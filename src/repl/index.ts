import { createInterface } from "node:readline";
import pc from "picocolors";
import { Agent } from "../agent/index.js";
import { configManager } from "../config/index.js";
import { createOptionalProvider } from "../providers/index.js";
import { executeTool } from "../tools/index.js";
import { assessShellRisk } from "../tools/risk.js";
import { runShellProcess } from "../tools/shell.js";
import type { ApprovalDecision, ApprovalRequest, CliToolMode } from "../tools/types.js";
import { printBanner } from "../ui/banner.js";
import { restoreTerminalCursor } from "../ui/spinner.js";
import { handleSlashCommand, SLASH_COMMANDS } from "./commands.js";
import { appendCliHistory, loadCliHistory } from "./history.js";
import { expandAtFileMentions, listWorkspacePathsForCompletion, warmWorkspacePathsCache } from "./mentions.js";
import { createSessionId, loadLatestSession, loadSession, saveSession } from "./sessions.js";
import { RuleLoader } from "../security/loader.js";
import { runInteractiveSetup } from "./setup.js";

export interface ReplOptions {
  initialPrompt?: string;
  resumeId?: string;
  continueLatest?: boolean;
  overrideProvider?: string;
  overrideModel?: string;
  autoApproveAll?: boolean;
  toolMode?: CliToolMode;
  allowBrowser?: boolean;
}

function needsMoreLines(buffer: string): boolean {
  if (buffer.endsWith("\\")) return true;
  const fenceMatches = buffer.match(/```/g);
  return Boolean(fenceMatches && fenceMatches.length % 2 === 1);
}

function buildPromptLabel(agent: Agent): string {
  const status = agent.hasProvider() ? pc.cyan(agent.getModelName()) : pc.yellow("unconfigured");
  return `${pc.bold(pc.cyan("wide"))} ${pc.dim(`[${status}]`)} ${pc.dim(">")} `;
}

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  printBanner();
  if (process.stdin.isTTY && process.env.WIDE_NO_AUTO_RULES_SYNC !== "1") {
    setTimeout(() => {
      RuleLoader.syncIfStale().catch(() => {});
    }, 2500).unref();
  }

  const initialProvider = options.overrideProvider || options.overrideModel
    ? createOptionalProvider(options.overrideProvider, options.overrideModel)
    : undefined;
  const agent = new Agent(process.cwd(), initialProvider, {
    toolMode: options.toolMode,
    allowBrowser: options.allowBrowser,
  });
  void warmWorkspacePathsCache(agent.getWorkingDirectory());
  let sessionId = createSessionId();

  if (options.continueLatest) {
    const latest = loadLatestSession();
    if (latest) {
      sessionId = latest.id;
      agent.loadMessages(latest.messages);
      console.log(`${pc.green("[OK]")} Resumed latest session ${pc.cyan(latest.id)} (${latest.messages.length} messages).`);
    } else {
      console.log(pc.dim("No previous session found; starting a new session."));
    }
  } else if (options.resumeId) {
    const target = loadSession(options.resumeId);
    if (target) {
      sessionId = target.id;
      agent.loadMessages(target.messages);
      console.log(`${pc.green("[OK]")} Resumed session ${pc.cyan(target.id)} (${target.messages.length} messages).`);
    } else {
      console.log(`${pc.yellow("[WARN]")} Session '${options.resumeId}' not found; starting a new session.`);
    }
  }

  const modelStatus = agent.hasProvider()
    ? pc.cyan(agent.getProviderLabel())
    : `${pc.yellow("not configured")} ${pc.dim("(run /setup)")}`;
  console.log(
    `  ${pc.gray("Model:")} ${modelStatus} ${pc.dim("|")} ${pc.gray("Mode:")} ${pc.cyan(agent.getToolMode())} ${pc.dim("|")} ${pc.gray("Browser:")} ${agent.getAllowBrowser() ? pc.green("ON") : pc.yellow("OFF")} ${pc.dim("|")} ${pc.gray("Workspace:")} ${pc.dim(agent.getWorkingDirectory())}`,
  );

  const sessionApprovedTools = new Set<string>();
  let activeAbortController: AbortController | null = null;
  let activeSubPromptAbort: AbortController | null = null;
  let closing = false;
  let lastIdleInterruptAt = 0;

  const lineQueue: string[] = [];
  let pendingResolver: ((line: string) => void) | null = null;

  const completer = (line: string): [string[], string] => {
    if (line.startsWith("/") && !line.includes(" ")) {
      const matches = SLASH_COMMANDS.map((c) => c.command).filter((cmd) => cmd.startsWith(line));
      return [matches, line];
    }
    const atIdx = line.lastIndexOf("@");
    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(line[atIdx - 1]))) {
      const partial = line.slice(atIdx + 1);
      const token = `@${partial}`;
      const paths = listWorkspacePathsForCompletion(agent.getWorkingDirectory(), partial).map((p) => `@${p}`);
      return [paths, token];
    }
    return [[], line];
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
    history: loadCliHistory(),
    historySize: 500,
    removeHistoryDuplicates: true,
    terminal: Boolean(process.stdin.isTTY),
  });

  rl.on("line", (line) => {
    if (pendingResolver) {
      const resolveNext = pendingResolver;
      pendingResolver = null;
      resolveNext(line);
    } else {
      lineQueue.push(line);
    }
  });

  const askLine = (promptText: string, signal?: AbortSignal, allowQueue = true): Promise<string> => {
    if (allowQueue && lineQueue.length > 0 && !signal?.aborted) {
      const queued = lineQueue.shift() as string;
      process.stdout.write(`${promptText}${queued}\n`);
      return Promise.resolve(queued);
    }
    return new Promise((resolvePromise) => {
      if (signal?.aborted) {
        resolvePromise("");
        return;
      }
      const onAbort = () => {
        if (pendingResolver === settle) {
          pendingResolver = null;
        }
        process.stdout.write("\n");
        resolvePromise("");
      };
      const settle = (value: string) => {
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(value);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingResolver = settle;
      rl.setPrompt(promptText);
      rl.prompt(true);
    });
  };

  const shutdown = async (exitProcess = true) => {
    if (closing) return;
    closing = true;
    activeAbortController?.abort();
    activeSubPromptAbort?.abort();
    if (pendingResolver) {
      const res = pendingResolver;
      pendingResolver = null;
      res("");
    }
    if (agent.getAllowBrowser()) {
      try {
        await executeTool("browser_close", {}, { workingDirectory: agent.getWorkingDirectory() });
      } catch {
      }
    }
    restoreTerminalCursor();
    console.log(pc.dim("\nGoodbye!"));
    try {
      rl.close();
    } catch {
    }
    if (exitProcess) {
      process.exit(0);
    }
  };

  rl.on("SIGINT", () => {
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
      console.log(`\n${pc.yellow("[CANCELLED]")} Active turn interrupted. Returning to prompt.\n`);
      return;
    }
    if (activeSubPromptAbort && !activeSubPromptAbort.signal.aborted) {
      activeSubPromptAbort.abort();
      return;
    }
    const now = Date.now();
    if (now - lastIdleInterruptAt < 2000) {
      void shutdown(true);
      return;
    }
    lastIdleInterruptAt = now;
    try {
      rl.write(null, { ctrl: true, name: "u" });
    } catch {
    }
    console.log(pc.dim("\nPress Ctrl+C again within 2s or type 'exit' to quit."));
    rl.setPrompt(buildPromptLabel(agent));
    rl.prompt(true);
  });

  rl.on("close", () => {
    if (!closing) {
      void shutdown(true);
    }
  });

  const requestApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    lineQueue.length = 0;
    console.log("");
    if (req.destructive) {
      console.log(`${pc.bgRed(pc.white(" DESTRUCTIVE "))} ${pc.red(req.title)}`);
    } else {
      console.log(`${pc.yellow("[APPROVAL]")} ${pc.bold(req.title)}`);
    }
    if (req.preview && req.tool === "run_command") {
      console.log(`  ${req.preview}`);
    } else if (!req.preview) {
      console.log(`  ${pc.dim(req.detail)}`);
    }

    const promptHint = req.destructive
      ? `  ${pc.red("Allow once?")} ${pc.dim("[y]es / [n]o (default n):")} `
      : `  ${pc.cyan("Allow?")} ${pc.dim("[y]es once / [a]lways this session / [n]o (default y):")} `;

    const answer = (await askLine(promptHint, activeAbortController?.signal, false)).trim().toLowerCase();
    if (activeAbortController?.signal.aborted) return "deny";
    if (req.destructive) {
      return answer === "y" || answer === "yes" ? "once" : "deny";
    }
    if (answer === "" || answer === "y" || answer === "yes") return "once";
    if (answer === "a" || answer === "always") return "always";
    return "deny";
  };

  const executeChatTurn = async (rawPrompt: string) => {
    if (!agent.hasProvider()) {
      if (process.stdin.isTTY) {
        activeSubPromptAbort = new AbortController();
        await runInteractiveSetup((q) => askLine(q, activeSubPromptAbort?.signal, false), agent, true);
        activeSubPromptAbort = null;
      }
      if (!agent.hasProvider()) {
        console.log(`${pc.yellow("[WARN]")} No provider configured. Run ${pc.cyan("/setup")} or ${pc.cyan("/key gemini <KEY>")} first.\n`);
        return;
      }
    }

    const expanded = expandAtFileMentions(rawPrompt, agent.getWorkingDirectory());
    if (expanded.attachedFiles.length > 0) {
      console.log(pc.dim(`Attached context: ${expanded.attachedFiles.join(", ")}`));
    }

    activeAbortController = new AbortController();
    console.log("");
    try {
      await agent.runPrompt(expanded.prompt, {
        signal: activeAbortController.signal,
        sessionApprovedTools,
        autoApproveWrite: options.autoApproveAll ? true : undefined,
        autoApproveRun: options.autoApproveAll ? true : undefined,
        requestApproval,
      });
      const cfg = configManager.get();
      saveSession(sessionId, {
        workingDirectory: agent.getWorkingDirectory(),
        provider: cfg.provider,
        model: cfg.model,
        messages: agent.getMessages(),
      });
      console.log("");
    } catch (err: any) {
      console.log(`\n${pc.red("Error:")} ${err.message}\n`);
    } finally {
      activeAbortController = null;
      restoreTerminalCursor();
    }
  };

  const executeDirectShell = async (commandLine: string) => {
    const risk = assessShellRisk(commandLine);
    activeAbortController = new AbortController();
    try {
      if (risk.destructive) {
        const decision = await requestApproval({
          tool: "shell_escape",
          title: `Destructive shell command (${risk.reason})`,
          detail: commandLine,
          preview: `${pc.dim("$")} ${pc.bold(commandLine)}`,
          destructive: true,
        });
        if (decision !== "once") {
          console.log(pc.yellow("Cancelled destructive command.\n"));
          return;
        }
      }
      console.log("");
      const res = await runShellProcess(commandLine, agent.getWorkingDirectory(), {
        streamToStdout: true,
        timeoutMs: 60000,
        signal: activeAbortController.signal,
      });
      console.log(
        res.exitCode === 0
          ? pc.dim(`\n[exit 0]\n`)
          : pc.yellow(`\n[exit ${res.exitCode}]\n`)
      );
    } finally {
      activeAbortController = null;
      restoreTerminalCursor();
    }
  };

  if (!agent.hasProvider() && process.stdin.isTTY) {
    activeSubPromptAbort = new AbortController();
    await runInteractiveSetup((q) => askLine(q, activeSubPromptAbort?.signal, false), agent, true);
    activeSubPromptAbort = null;
  } else {
    console.log("");
  }

  if (options.initialPrompt && options.initialPrompt.trim()) {
    appendCliHistory(options.initialPrompt);
    await executeChatTurn(options.initialPrompt.trim());
  }

  while (!closing) {
    const firstLine = await askLine(buildPromptLabel(agent));
    if (closing) break;

    let combined = firstLine;
    while (needsMoreLines(combined) && !closing) {
      const stripped = combined.endsWith("\\") ? combined.slice(0, -1) + "\n" : combined + "\n";
      const nextLine = await askLine(pc.dim("... > "));
      combined = stripped + nextLine;
    }

    const trimmed = combined.trim();
    if (!trimmed) continue;

    lastIdleInterruptAt = 0;
    appendCliHistory(trimmed);

    if (trimmed.startsWith("!")) {
      const shellCmd = trimmed.slice(1).trim();
      if (shellCmd) {
        await executeDirectShell(shellCmd);
      }
      continue;
    }

    const handled = await handleSlashCommand(trimmed, {
      agent,
      sessionId,
      setSessionId: (nextId) => {
        sessionId = nextId;
      },
      sessionApprovedTools,
      ask: (q) => askLine(q, undefined, false),
      onExit: () => shutdown(true),
    });
    if (handled) continue;

    await executeChatTurn(trimmed);
  }
}
