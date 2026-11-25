import { createInterface } from "node:readline";
import { Agent } from "../agent/index.js";
import { configManager } from "../config/index.js";
import { PermissionStore } from "../config/permissions.js";
import { createOptionalProvider } from "../providers/index.js";
import { RuleLoader } from "../security/loader.js";
import { executeTool } from "../tools/index.js";
import { assessShellRisk } from "../tools/risk.js";
import { runShellProcess } from "../tools/shell.js";
import type { ApprovalOutcome, ApprovalRequest, CliToolMode, PermissionProfile } from "../tools/types.js";
import { printBanner, printWelcomeHeader } from "../ui/banner.js";
import { formatErrorCard } from "../ui/errors.js";
import { restoreTerminalCursor } from "../ui/spinner.js";
import { glyphs, theme } from "../ui/theme.js";
import { askInlineText, attachTurnInterruptWatcher, PromptComposer } from "../ui/tui/composer.js";
import { disableTerminalInputModes, setMouseEnabled } from "../ui/tui/keys.js";
import { runInteractiveSelect, type SelectOption } from "../ui/tui/select.js";
import { getCachedGitStatus, refreshGitStatus, type StatusBarState } from "../ui/tui/statusbar.js";
import { TurnCheckpointStore } from "./checkpoints.js";
import { handleRewindCommand, handleSlashCommand, SLASH_COMMANDS } from "./commands.js";
import { appendCliHistory, loadCliHistory } from "./history.js";
import { expandAtFileMentions, listWorkspacePathsForCompletion, warmWorkspacePathsCache } from "./mentions.js";
import { createSessionId, loadLatestSession, loadSession, saveSession } from "./sessions.js";
import { runInteractiveSetup, tryAutoConnectProvider } from "./setup.js";

export interface ReplOptions {
  initialPrompt?: string;
  resumeId?: string;
  continueLatest?: boolean;
  overrideProvider?: string;
  overrideModel?: string;
  autoApproveAll?: boolean;
  toolMode?: CliToolMode;
  allowBrowser?: boolean;
  permissionProfile?: PermissionProfile;
  verbose?: boolean;
}

const PERMISSION_CYCLE: PermissionProfile[] = ["ask", "accept-edits", "plan", "auto"];
const TOOL_MODE_CYCLE: CliToolMode[] = ["full", "code", "security"];

function needsMoreLines(buffer: string): boolean {
  if (buffer.endsWith("\\")) return true;
  const fenceMatches = buffer.match(/```/g);
  return Boolean(fenceMatches && fenceMatches.length % 2 === 1);
}

function buildPlainPromptLabel(agent: Agent): string {
  const status = agent.hasProvider() ? theme.info(agent.getModelName()) : theme.warn("unconfigured");
  return `${theme.accentBold("wide")} ${theme.faint(`[${status}]`)} ${theme.faint(">")} `;
}

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const savedCfg = configManager.get();
  if (savedCfg.mouse === false) {
    setMouseEnabled(false);
  }

  if (process.stdin.isTTY && process.env.WIDE_NO_AUTO_RULES_SYNC !== "1") {
    setTimeout(() => {
      RuleLoader.syncIfStale().catch(() => {});
    }, 2500).unref();
  }

  const initialProvider =
    options.overrideProvider || options.overrideModel
      ? createOptionalProvider(options.overrideProvider, options.overrideModel)
      : undefined;

  const initialPermissionProfile: PermissionProfile | undefined = options.autoApproveAll
    ? "auto"
    : options.permissionProfile;

  const agent = new Agent(process.cwd(), initialProvider, {
    toolMode: options.toolMode,
    allowBrowser: options.allowBrowser,
    permissionProfile: initialPermissionProfile,
    verbose: options.verbose,
  });

  const permissionStore = new PermissionStore(agent.getWorkingDirectory());
  const checkpoints = new TurnCheckpointStore();
  void warmWorkspacePathsCache(agent.getWorkingDirectory());
  let sessionId = createSessionId();

  let autoConnectedNote = "";
  if (isTty && !agent.hasProvider() && !options.overrideProvider && !options.overrideModel) {
    const auto = await tryAutoConnectProvider(agent);
    if (auto) {
      autoConnectedNote = `${auto.provider}/${auto.model}`;
    }
  }

  const ruleList = RuleLoader.loadRules(undefined, agent.getWorkingDirectory());
  const advisoryDb = RuleLoader.loadAdvisories(agent.getWorkingDirectory());
  const ruleCount = ruleList.length;
  const advisoryCount = advisoryDb?.stats?.total || 0;

  const renderHeader = () => {
    if (!isTty) {
      printBanner();
      return;
    }
    const git = getCachedGitStatus(agent.getWorkingDirectory());
    printWelcomeHeader({
      providerLabel: agent.getProviderLabel(),
      providerReady: agent.hasProvider(),
      toolMode: agent.getToolMode(),
      permissionProfile: agent.getPermissionProfile(),
      allowBrowser: agent.getAllowBrowser(),
      workspace: agent.getWorkingDirectory(),
      gitBranch: git?.branch || undefined,
      gitDirty: git?.dirty,
      ruleCount,
      advisoryCount,
    });
  };

  if (isTty) {
    await refreshGitStatus(agent.getWorkingDirectory());
  }
  renderHeader();

  if (autoConnectedNote) {
    console.log(`  ${theme.ok(glyphs.dot)} Auto-connected to ${theme.info(autoConnectedNote)} ${theme.faint("(use /provider to switch)")}\n`);
  }

  if (options.continueLatest) {
    const latest = loadLatestSession();
    if (latest) {
      sessionId = latest.id;
      agent.loadMessages(latest.messages);
      console.log(`  ${theme.ok(glyphs.dot)} Resumed latest session ${theme.info(latest.id)} (${latest.messages.length} messages).\n`);
    } else {
      console.log(`  ${theme.faint("No previous session found; starting a new session.")}\n`);
    }
  } else if (options.resumeId) {
    const target = loadSession(options.resumeId);
    if (target) {
      sessionId = target.id;
      agent.loadMessages(target.messages);
      console.log(`  ${theme.ok(glyphs.dot)} Resumed session ${theme.info(target.id)} (${target.messages.length} messages).\n`);
    } else {
      console.log(`  ${theme.warn(glyphs.warn)} Session '${options.resumeId}' not found; starting a new session.\n`);
    }
  }

  if (!isTty) {
    const modelStatus = agent.hasProvider()
      ? theme.info(agent.getProviderLabel())
      : `${theme.warn("not configured")} ${theme.faint("(run /setup)")}`;
    console.log(
      `  ${theme.faint("Model:")} ${modelStatus} ${theme.faint("|")} ${theme.faint("Mode:")} ${theme.info(agent.getToolMode())} ${theme.faint("|")} ${theme.faint("Browser:")} ${agent.getAllowBrowser() ? theme.ok("ON") : theme.warn("OFF")} ${theme.faint("|")} ${theme.faint("Workspace:")} ${theme.faint(agent.getWorkingDirectory())}\n`,
    );
  }

  const sessionApprovedTools = new Set<string>();
  let activeAbortController: AbortController | null = null;
  let closing = false;

  const cleanupAndExit = async (rl?: ReturnType<typeof createInterface>) => {
    if (closing) return;
    closing = true;
    activeAbortController?.abort();
    disableTerminalInputModes();
    if (agent.getAllowBrowser()) {
      try {
        await executeTool("browser_close", {}, { workingDirectory: agent.getWorkingDirectory() });
      } catch {}
    }
    restoreTerminalCursor();
    console.log(theme.faint("\nGoodbye!"));
    if (rl) {
      try {
        rl.close();
      } catch {}
    }
    process.exit(0);
  };

  if (isTty) {
    const composer = new PromptComposer(loadCliHistory());

    const getStatus = (): StatusBarState => {
      const git = getCachedGitStatus(agent.getWorkingDirectory());
      const ctxInfo = agent.getContextBreakdown();
      return {
        providerLabel: agent.getProviderLabel(),
        providerReady: agent.hasProvider(),
        toolMode: agent.getToolMode(),
        permissionProfile: agent.getPermissionProfile(),
        contextPercent: ctxInfo.fillPercent,
        ruleCount,
        verbose: agent.isVerbose(),
        gitBranch: git?.branch || undefined,
        gitDirty: git?.dirty,
      };
    };

    const requestTtyApproval = async (
      req: ApprovalRequest,
      detachInterrupt?: () => void,
      reattachInterrupt?: () => void,
    ): Promise<ApprovalOutcome> => {
      detachInterrupt?.();
      try {
        console.log("");
        if (req.destructive) {
          console.log(`  ${theme.pill("DESTRUCTIVE", "error")} ${theme.errorBold(req.title)}`);
        } else {
          console.log(`  ${theme.badge("APPROVAL", "warn")} ${theme.fgBold(req.title)}`);
        }
        if (req.preview && req.tool === "run_command") {
          console.log(`    ${req.preview}`);
        } else if (!req.preview && req.detail) {
          console.log(`    ${theme.muted(req.detail)}`);
        }

        const opts: SelectOption<string>[] = [
          { value: "once", label: "Allow once", description: "Execute this action once", badge: "Y", badgeTone: "ok" },
        ];
        if (!req.destructive) {
          opts.push({
            value: "always",
            label: "Allow for this session",
            description: `Approve ${req.sessionKey || req.tool} until Wide exits`,
            badge: "A",
            badgeTone: "info",
          });
          if (req.suggestedPattern) {
            opts.push({
              value: "pattern",
              label: `Always allow ${req.suggestedPattern}`,
              description: "Save allow rule in .wide/settings.json",
              badge: "RULE",
              badgeTone: "accent",
            });
          }
        }
        opts.push(
          { value: "deny", label: "Deny", description: "Decline this action", badge: "N", badgeTone: "error" },
          { value: "feedback", label: "Deny with feedback", description: "Decline and tell Wide what to do instead", badge: "MSG", badgeTone: "warn" },
        );

        const picked = await runInteractiveSelect({
          title: req.destructive ? "Confirm Destructive Action" : "Action Approval",
          options: opts,
          initialIndex: req.destructive ? opts.findIndex((o) => o.value === "deny") : 0,
          signal: activeAbortController?.signal,
        });

        if (activeAbortController?.signal.aborted || !picked || picked === "deny") {
          return "deny";
        }
        if (picked === "once") return "once";
        if (picked === "always") return "always";
        if (picked === "pattern" && req.suggestedPattern) {
          permissionStore.addRule("allow", req.suggestedPattern, "project");
          console.log(`  ${theme.ok(glyphs.dot)} Saved allow rule ${theme.info(req.suggestedPattern)} in .wide/settings.json`);
          return "once";
        }
        if (picked === "feedback") {
          const msg = await askInlineText("Guidance for Wide", {
            placeholder: "Describe what to do instead...",
            signal: activeAbortController?.signal,
          });
          return { decision: "deny", feedback: (msg || "").trim() || undefined };
        }
        return "deny";
      } finally {
        reattachInterrupt?.();
      }
    };

    const askTtyLine = async (q: string): Promise<string> => {
      const clean = q.replace(/\x1b\[[0-9;]*m/g, "").replace(/:\s*$/, "").trim() || "Input";
      const res = await askInlineText(clean);
      return res ?? "";
    };

    const executeChatTurn = async (rawPrompt: string) => {
      if (!agent.hasProvider()) {
        await runInteractiveSetup(askTtyLine, agent, true);
        if (!agent.hasProvider()) {
          console.log(`  ${theme.warn(glyphs.warn)} No provider configured. Run ${theme.info("/setup")} or ${theme.info("/key")} first.\n`);
          return;
        }
      }

      const singlePreview = rawPrompt.replace(/\s+/g, " ").trim();
      const shortPreview = singlePreview.length > 100 ? `${singlePreview.slice(0, 97)}${glyphs.ellipsis}` : singlePreview;
      console.log(`\n  ${theme.accentBold(glyphs.prompt)} ${theme.fgBold(shortPreview)}`);

      const expanded = expandAtFileMentions(rawPrompt, agent.getWorkingDirectory());
      if (expanded.attachedFiles.length > 0) {
        console.log(`  ${theme.faint(`Attached: ${expanded.attachedFiles.join(", ")}`)}`);
      }
      console.log("");

      checkpoints.beginTurn(rawPrompt, agent.getMessages().length);
      activeAbortController = new AbortController();
      let detachWatcher = attachTurnInterruptWatcher(activeAbortController, {
        onInterrupt: () => {
          agent.getTimeline().pauseForPrompt();
          console.log(`\n  ${theme.warn(glyphs.warn)} ${theme.muted("Turn interrupted (Esc/Ctrl+C).")}\n`);
        },
        onToggleVerbose: () => {
          const v = agent.toggleVerbose();
          agent.getTimeline().updateThinking(v ? "Verbose output ON" : "Verbose output OFF");
        },
      });

      const reattach = () => {
        if (activeAbortController && !activeAbortController.signal.aborted) {
          detachWatcher = attachTurnInterruptWatcher(activeAbortController, {
            onInterrupt: () => {
              agent.getTimeline().pauseForPrompt();
              console.log(`\n  ${theme.warn(glyphs.warn)} ${theme.muted("Turn interrupted (Esc/Ctrl+C).")}\n`);
            },
            onToggleVerbose: () => {
              agent.toggleVerbose();
            },
          });
        }
      };

      try {
        await agent.runPrompt(expanded.prompt, {
          signal: activeAbortController.signal,
          sessionApprovedTools,
          autoApproveWrite: options.autoApproveAll ? true : undefined,
          autoApproveRun: options.autoApproveAll ? true : undefined,
          evaluatePermission: (tool, target) => permissionStore.evaluate(tool, target),
          onFileChange: (snap) => checkpoints.recordFileChange(snap),
          requestApproval: (req) => requestTtyApproval(req, () => detachWatcher(), reattach),
        });
        if (activeAbortController.signal.aborted) {
          checkpoints.discardActiveTurn();
        } else {
          checkpoints.commitTurn();
          const cfg = configManager.get();
          saveSession(sessionId, {
            workingDirectory: agent.getWorkingDirectory(),
            provider: cfg.provider,
            model: cfg.model,
            messages: agent.getMessages(),
          });
        }
        console.log("");
      } catch (err: any) {
        checkpoints.discardActiveTurn();
        console.log(`\n${formatErrorCard(err)}\n`);
      } finally {
        detachWatcher();
        activeAbortController = null;
        restoreTerminalCursor();
        void refreshGitStatus(agent.getWorkingDirectory());
      }
    };

    const executeDirectShell = async (commandLine: string) => {
      const risk = assessShellRisk(commandLine);
      activeAbortController = new AbortController();
      if (risk.destructive) {
        const outcome = await requestTtyApproval({
          tool: "shell_escape",
          title: `Destructive shell command (${risk.reason})`,
          detail: commandLine,
          preview: `${theme.faint("$")} ${theme.fgBold(commandLine)}`,
          destructive: true,
        });
        const decision = typeof outcome === "string" ? outcome : outcome.decision;
        if (decision !== "once") {
          activeAbortController = null;
          console.log(`  ${theme.warn(glyphs.warn)} Cancelled destructive command.\n`);
          return;
        }
      }
      console.log(`\n  ${theme.warnBold("$")} ${theme.fgBold(commandLine)}\n`);
      const detach = attachTurnInterruptWatcher(activeAbortController, {
        onInterrupt: () => {
          console.log(`\n  ${theme.warn(glyphs.warn)} Command interrupted.`);
        },
      });
      try {
        const res = await runShellProcess(commandLine, agent.getWorkingDirectory(), {
          streamToStdout: true,
          timeoutMs: 60000,
          signal: activeAbortController.signal,
        });
        console.log(
          res.exitCode === 0
            ? `\n  ${theme.ok(glyphs.dot)} ${theme.faint("exit 0")}\n`
            : `\n  ${theme.warn(glyphs.warn)} ${theme.warn(`exit ${res.exitCode}`)}\n`,
        );
      } finally {
        detach();
        activeAbortController = null;
        restoreTerminalCursor();
        void refreshGitStatus(agent.getWorkingDirectory());
      }
    };

    if (!agent.hasProvider()) {
      await runInteractiveSetup(askTtyLine, agent, true);
    }

    if (options.initialPrompt && options.initialPrompt.trim()) {
      appendCliHistory(options.initialPrompt);
      composer.pushHistory(options.initialPrompt);
      await executeChatTurn(options.initialPrompt.trim());
    }

    while (!closing) {
      const action = await composer.readPrompt({
        getStatus,
        getSlashCommands: () => SLASH_COMMANDS,
        getWorkspaceFiles: (prefix) => listWorkspacePathsForCompletion(agent.getWorkingDirectory(), prefix),
        getModifiedFiles: () => getCachedGitStatus(agent.getWorkingDirectory())?.modifiedFiles,
        onCyclePermission: () => {
          const cur = agent.getPermissionProfile();
          const idx = PERMISSION_CYCLE.indexOf(cur);
          agent.setPermissionProfile(PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length]);
        },
        onCycleToolMode: () => {
          const cur = agent.getToolMode();
          const idx = TOOL_MODE_CYCLE.indexOf(cur);
          const next = TOOL_MODE_CYCLE[(idx + 1) % TOOL_MODE_CYCLE.length];
          agent.setToolMode(next);
          configManager.set("toolMode", next);
        },
        onToggleVerbose: () => {
          agent.toggleVerbose();
        },
        onRedrawScreen: () => {
          console.clear();
          renderHeader();
        },
      });

      if (closing || action.type === "exit") {
        await cleanupAndExit();
        return;
      }

      if (action.type === "command") {
        await handleSlashCommand(action.command, {
          agent,
          sessionId,
          setSessionId: (nextId) => {
            sessionId = nextId;
          },
          sessionApprovedTools,
          permissionStore,
          checkpoints,
          ask: askTtyLine,
          onRedrawHeader: renderHeader,
          onExit: () => cleanupAndExit(),
        });
        continue;
      }

      if (action.type === "rewind") {
        await handleRewindCommand({
          agent,
          sessionId,
          setSessionId: (nextId) => {
            sessionId = nextId;
          },
          sessionApprovedTools,
          permissionStore,
          checkpoints,
          ask: askTtyLine,
          onRedrawHeader: renderHeader,
          onExit: () => cleanupAndExit(),
        });
        continue;
      }

      const trimmed = action.text.trim();
      if (!trimmed) continue;
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
        permissionStore,
        checkpoints,
        ask: askTtyLine,
        onRedrawHeader: renderHeader,
        onExit: () => cleanupAndExit(),
      });
      if (handled) continue;

      await executeChatTurn(trimmed);
    }
    return;
  }

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
    terminal: false,
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
        if (pendingResolver === settle) pendingResolver = null;
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

  rl.on("SIGINT", () => {
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
      console.log(`\n${theme.warn("[CANCELLED]")} Active turn interrupted.\n`);
      return;
    }
    const now = Date.now();
    if (now - lastIdleInterruptAt < 2000) {
      void cleanupAndExit(rl);
      return;
    }
    lastIdleInterruptAt = now;
    console.log(theme.faint("\nPress Ctrl+C again within 2s or type 'exit' to quit."));
    rl.setPrompt(buildPlainPromptLabel(agent));
    rl.prompt(true);
  });

  rl.on("close", () => {
    if (!closing) {
      void cleanupAndExit(rl);
    }
  });

  const requestPlainApproval = async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    lineQueue.length = 0;
    console.log("");
    if (req.destructive) {
      console.log(`${theme.pill("DESTRUCTIVE", "error")} ${theme.error(req.title)}`);
    } else {
      console.log(`${theme.badge("APPROVAL", "warn")} ${theme.fgBold(req.title)}`);
    }
    if (req.preview && req.tool === "run_command") {
      console.log(`  ${req.preview}`);
    } else if (!req.preview) {
      console.log(`  ${theme.faint(req.detail)}`);
    }
    const hint = req.destructive
      ? `  ${theme.error("Allow once?")} ${theme.faint("[y]es / [n]o (default n):")} `
      : `  ${theme.info("Allow?")} ${theme.faint("[y]es once / [a]lways this session / [n]o (default y):")} `;
    const answer = (await askLine(hint, activeAbortController?.signal, false)).trim().toLowerCase();
    if (activeAbortController?.signal.aborted) return "deny";
    if (req.destructive) return answer === "y" || answer === "yes" ? "once" : "deny";
    if (answer === "" || answer === "y" || answer === "yes") return "once";
    if (answer === "a" || answer === "always") return "always";
    return "deny";
  };

  const executePlainTurn = async (rawPrompt: string) => {
    if (!agent.hasProvider()) {
      console.log(`  ${theme.warn(glyphs.warn)} No provider configured. Run /setup or /key <provider> <KEY> first.\n`);
      return;
    }
    const expanded = expandAtFileMentions(rawPrompt, agent.getWorkingDirectory());
    if (expanded.attachedFiles.length > 0) {
      console.log(theme.faint(`Attached context: ${expanded.attachedFiles.join(", ")}`));
    }
    checkpoints.beginTurn(rawPrompt, agent.getMessages().length);
    activeAbortController = new AbortController();
    console.log("");
    try {
      await agent.runPrompt(expanded.prompt, {
        signal: activeAbortController.signal,
        sessionApprovedTools,
        autoApproveWrite: options.autoApproveAll ? true : undefined,
        autoApproveRun: options.autoApproveAll ? true : undefined,
        evaluatePermission: (tool, target) => permissionStore.evaluate(tool, target),
        onFileChange: (snap) => checkpoints.recordFileChange(snap),
        requestApproval: requestPlainApproval,
      });
      checkpoints.commitTurn();
      const cfg = configManager.get();
      saveSession(sessionId, {
        workingDirectory: agent.getWorkingDirectory(),
        provider: cfg.provider,
        model: cfg.model,
        messages: agent.getMessages(),
      });
      console.log("");
    } catch (err: any) {
      checkpoints.discardActiveTurn();
      console.log(`\n${formatErrorCard(err)}\n`);
    } finally {
      activeAbortController = null;
      restoreTerminalCursor();
    }
  };

  if (options.initialPrompt && options.initialPrompt.trim()) {
    appendCliHistory(options.initialPrompt);
    await executePlainTurn(options.initialPrompt.trim());
  }

  while (!closing) {
    const firstLine = await askLine(buildPlainPromptLabel(agent));
    if (closing) break;

    let combined = firstLine;
    while (needsMoreLines(combined) && !closing) {
      const stripped = combined.endsWith("\\") ? combined.slice(0, -1) + "\n" : combined + "\n";
      const nextLine = await askLine(theme.faint("... > "));
      combined = stripped + nextLine;
    }

    const trimmed = combined.trim();
    if (!trimmed) continue;

    lastIdleInterruptAt = 0;
    appendCliHistory(trimmed);

    if (trimmed.startsWith("!")) {
      const shellCmd = trimmed.slice(1).trim();
      if (shellCmd) {
        const risk = assessShellRisk(shellCmd);
        activeAbortController = new AbortController();
        try {
          if (risk.destructive) {
            const decision = await requestPlainApproval({
              tool: "shell_escape",
              title: `Destructive shell command (${risk.reason})`,
              detail: shellCmd,
              preview: `${theme.faint("$")} ${theme.fgBold(shellCmd)}`,
              destructive: true,
            });
            if ((typeof decision === "string" ? decision : decision.decision) !== "once") {
              console.log(theme.warn("Cancelled destructive command.\n"));
              continue;
            }
          }
          console.log("");
          const res = await runShellProcess(shellCmd, agent.getWorkingDirectory(), {
            streamToStdout: true,
            timeoutMs: 60000,
            signal: activeAbortController.signal,
          });
          console.log(res.exitCode === 0 ? theme.faint("\n[exit 0]\n") : theme.warn(`\n[exit ${res.exitCode}]\n`));
        } finally {
          activeAbortController = null;
          restoreTerminalCursor();
        }
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
      permissionStore,
      checkpoints,
      ask: (q) => askLine(q, undefined, false),
      onRedrawHeader: renderHeader,
      onExit: () => cleanupAndExit(rl),
    });
    if (handled) continue;

    await executePlainTurn(trimmed);
  }
}
