import { Command } from "commander";
import pc from "picocolors";
import { debugLog, enableDebugLogging } from "./config/logger.js";

async function readPipedStdin(requireFullRead: boolean): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  return new Promise((resolvePromise) => {
    let data = "";
    let receivedAny = false;
    let settled = false;

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
    };

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      cleanup();
      resolvePromise(result);
    };

    const onData = (chunk: string | Buffer) => {
      receivedAny = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      data += String(chunk);
    };

    const onEnd = () => finish(data.trim());
    const onError = () => finish("");

    let idleTimer: NodeJS.Timeout | null = null;
    if (!requireFullRead) {
      idleTimer = setTimeout(() => {
        if (!receivedAny) {
          process.stdin.pause();
          finish("");
        }
      }, 60);
      idleTimer.unref?.();
    }

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

let cursorHookRegistered = false;
async function ensureCursorCleanupHook(): Promise<void> {
  if (cursorHookRegistered) return;
  cursorHookRegistered = true;
  const { restoreTerminalCursor } = await import("./ui/spinner.js");
  process.on("exit", () => {
    restoreTerminalCursor();
  });
}

const program = new Command();

program
  .name("wide")
  .description("Terminal-first autonomous AI coding and security agent for the Wide ecosystem")
  .version("0.5151126")
  .option("-d, --debug", "Enable structured debug diagnostics to stderr")
  .option("-v, --verbose", "Enable verbose diagnostic logging")
  .argument("[prompt...]", "Optional initial prompt for the agent")
  .option("-p, --print", "Run a single prompt non-interactively and exit")
  .option("-c, --continue", "Resume the most recent saved interactive session")
  .option("-r, --resume [sessionId]", "Resume a saved interactive session by ID")
  .option("--provider <provider>", "LLM provider to use (gemini, ollama, claude, deepseek, openai)")
  .option("-m, --model <model>", "Model name to use")
  .option("-y, --yes", "Auto-approve all file edits and non-destructive command executions")
  .hook("preAction", () => {
    const rootOpts = program.opts();
    if (rootOpts.debug || rootOpts.verbose) {
      enableDebugLogging();
      debugLog("cli", `invoked argv=${JSON.stringify(process.argv.slice(2))}`);
    }
  })
  .action(async (promptParts, options) => {
    await ensureCursorCleanupHook();
    const pipedData = await readPipedStdin(Boolean(options.print));
    const argPrompt = Array.isArray(promptParts) ? promptParts.join(" ").trim() : "";
    let userPrompt = argPrompt;

    if (pipedData) {
      userPrompt = userPrompt ? `${userPrompt}\n\n[Piped Input]:\n${pipedData}` : pipedData;
    }

    const { loadWorkspaceConfig } = await import("./config/workspace.js");
    const ws = loadWorkspaceConfig();
    if (ws.rules.length > 0) {
      console.log(pc.dim(`Loaded ${ws.rules.length} workspace rule(s) from .wide/rules`));
    }

    const nonInteractive = Boolean(options.print || pipedData);
    if (nonInteractive) {
      if (!userPrompt) {
        console.error(pc.red("Error: --print requires a prompt or piped input."));
        process.exit(1);
      }
      try {
        const [{ createProvider }, { Agent }, { loadLatestSession, loadSession }, { executeTool }] = await Promise.all([
          import("./providers/index.js"),
          import("./agent/index.js"),
          import("./repl/sessions.js"),
          import("./tools/index.js"),
        ]);
        const provider = createProvider(options.provider, options.model);
        const agent = new Agent(process.cwd(), provider);
        if (options.continue) {
          const latest = loadLatestSession();
          if (latest) agent.loadMessages(latest.messages);
        } else if (typeof options.resume === "string") {
          const saved = loadSession(options.resume);
          if (saved) agent.loadMessages(saved.messages);
        }
        await agent.runPrompt(userPrompt, {
          autoApproveWrite: options.yes ? true : undefined,
          autoApproveRun: options.yes ? true : undefined,
        });
        await executeTool("browser_close", {}, { workingDirectory: process.cwd() });
      } catch (err: any) {
        console.error(`${pc.red("Error:")} ${err.message}`);
        process.exit(1);
      }
      return;
    }

    const { startRepl } = await import("./repl/index.js");
    await startRepl({
      initialPrompt: userPrompt || undefined,
      continueLatest: Boolean(options.continue),
      resumeId: typeof options.resume === "string" ? options.resume : undefined,
      overrideProvider: options.provider,
      overrideModel: options.model,
      autoApproveAll: Boolean(options.yes),
    });
  });

program
  .command("scan [path]")
  .description("Run Wide native SAST, taint flow, and OSV SCA security engine")
  .option("-s, --severity <level>", "Minimum severity (CRITICAL, HIGH, MEDIUM, LOW, ALL)", "ALL")
  .option("-r, --rules <path>", "Path to custom rules.json file")
  .option("--no-sca", "Disable OSV dependency vulnerability scanning")
  .option("--history", "Scan recent git commits for historically leaked secrets")
  .option("--sarif <file>", "Write findings in SARIF 2.1.0 JSON format")
  .action(async (targetPath = ".", opts) => {
    const { executeTool } = await import("./tools/index.js");
    const res = await executeTool(
      "run_security_scan",
      {
        path: targetPath,
        severityFilter: opts.severity,
        rulesPath: opts.rules,
        sca: opts.sca,
        scanHistory: Boolean(opts.history),
        sarifPath: opts.sarif
      },
      { workingDirectory: process.cwd() }
    );
    console.log(res.output);
  });

program
  .command("update")
  .alias("upgrade")
  .description("Check for updates and synchronize the Wide CLI and rules to the latest version")
  .action(async () => {
    try {
      const { RuleLoader } = await import("./security/loader.js");
      console.log(pc.cyan("Synchronizing Wide security rules..."));
      const ruleResult = await RuleLoader.updateRules();
      console.log(pc.green(`Synchronized ${ruleResult.count} security rules to ${ruleResult.path}`));

      console.log(pc.cyan("Checking for Wide CLI updates..."));
      const currentVersion = "0.5151126";
      const res = await fetch("https://api.github.com/repos/sl4de0day/wide-cli/releases/latest", {
        headers: { "User-Agent": "Wide-CLI", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const release = (await res.json()) as any;
        const latestTag = String(release.tag_name || release.name || "").replace(/^v/i, "");
        if (latestTag && latestTag !== currentVersion) {
          console.log(pc.yellow(`New Wide CLI version available: v${latestTag} (current: v${currentVersion})`));
          console.log(pc.cyan("Run npm install -g wide-cli or download from https://github.com/sl4de0day/wide-cli/releases to update."));
        } else {
          console.log(pc.green(`Wide CLI is already up to date (v${currentVersion}).`));
        }
      }
    } catch (err: any) {
      console.error(pc.red(`Update check failed: ${err.message}`));
    }
  });

const rulesCmd = program
  .command("rules")
  .description("Manage and synchronize Wide security rules");

rulesCmd
  .command("update")
  .description("Download latest security rules from wide-rules database")
  .action(async () => {
    try {
      const { RuleLoader } = await import("./security/loader.js");
      console.log(pc.cyan("Downloading latest rules from wide-rules repository..."));
      const result = await RuleLoader.updateRules();
      console.log(pc.green(`Successfully synchronized ${result.count} rules to ${result.path}`));
    } catch (err: any) {
      console.error(pc.red(`Failed to update rules: ${err.message}`));
      process.exit(1);
    }
  });

rulesCmd
  .command("path")
  .description("Show local rules cache path")
  .action(async () => {
    const { RuleLoader } = await import("./security/loader.js");
    console.log(RuleLoader.getCachePath());
  });

rulesCmd
  .command("agent")
  .description("List active AI agent security rules")
  .option("-r, --rules <path>", "Path to custom agent rules JSON file")
  .action(async (opts) => {
    const { RuleLoader } = await import("./security/loader.js");
    const rules = RuleLoader.loadAgentRules(opts.rules);
    const info = RuleLoader.getAgentRulesPath();
    console.log(pc.bold(`Active AI Agent Security Rules (${rules.length}) [source: ${info.active}]:`));
    for (const r of rules) {
      console.log(`  ${pc.cyan(r.id)} [${pc.yellow(r.severity)}] (${r.cwe}) - ${r.message}`);
    }
  });

program
  .command("payloads <type>")
  .description("Output targeted security injection payloads (sqli, xss, ssrf, traversal, cmd, ssti)")
  .action(async (type) => {
    const { executeTool } = await import("./tools/index.js");
    const res = await executeTool("generate_payloads", { type }, { workingDirectory: process.cwd() });
    console.log(res.output);
  });

program
  .command("fuzz <url> <param> <type>")
  .description("Actively probe an endpoint parameter with injection vectors")
  .option("-X, --method <method>", "HTTP method (GET, POST)", "GET")
  .action(async (url, param, type, opts) => {
    const { executeTool } = await import("./tools/index.js");
    const res = await executeTool("fuzz_endpoint", { url, param, payloadType: type, method: opts.method }, { workingDirectory: process.cwd() });
    console.log(res.output);
  });

const configCmd = program
  .command("config")
  .description("Manage Wide CLI configuration and API keys");

configCmd
  .command("list")
  .description("List current configuration")
  .action(async () => {
    const { configManager } = await import("./config/index.js");
    const cfg = configManager.get();
    console.log(pc.bold("\nWide CLI Configuration:"));
    console.log(`  Provider:        ${pc.cyan(cfg.provider)}`);
    console.log(`  Model:           ${pc.cyan(cfg.model)}`);
    console.log(`  Ollama URL:      ${pc.dim(cfg.ollamaBaseUrl)}`);
    console.log(`  Auto-Approve:    Read=${cfg.autoApproveRead}, Write=${cfg.autoApproveWrite}, Run=${cfg.autoApproveRun}`);
    console.log(`  Config Path:     ${pc.dim("~/.wide/config.json")}\n`);
  });

configCmd
  .command("set <key> <value>")
  .description("Set configuration property")
  .action(async (key, value) => {
    try {
      const { configManager } = await import("./config/index.js");
      configManager.set(key as any, value);
      console.log(pc.green(`[OK] Updated '${key}' to '${value}'`));
    } catch (err: any) {
      console.error(pc.red(`Failed to set config: ${err.message}`));
    }
  });

configCmd
  .command("set-key <provider> <apiKey>")
  .description("Store API key for a provider")
  .action(async (provider, apiKey) => {
    try {
      const { configManager } = await import("./config/index.js");
      configManager.setApiKey(provider as any, apiKey);
      console.log(pc.green(`[OK] Stored API key for provider '${provider}' in ~/.wide/config.json`));
    } catch (err: any) {
      console.error(pc.red(`Failed to set key: ${err.message}`));
    }
  });

const completionCmd = program
  .command("completion")
  .description("Generate or install shell completion scripts")
  .option("-s, --shell <shell>", "Target shell (powershell, bash, zsh)")
  .action(async (opts) => {
    try {
      const { generateCompletionScript } = await import("./completion.js");
      console.log(generateCompletionScript(opts.shell));
    } catch (err: any) {
      console.error(pc.red(`Failed to generate completion: ${err.message}`));
      process.exit(1);
    }
  });

completionCmd
  .command("install")
  .description("Install completion script into your shell profile")
  .option("-s, --shell <shell>", "Target shell (powershell, bash, zsh)")
  .option("-p, --profile <path>", "Override target profile file path")
  .action(async (opts) => {
    try {
      const { installShellCompletion } = await import("./completion.js");
      const res = installShellCompletion({
        shell: opts.shell,
        profilePath: opts.profile,
      });
      if (res.updated) {
        console.log(pc.green(`[OK] Installed ${res.shell} completion in ${res.profilePath}`));
      } else {
        console.log(pc.cyan(`[OK] ${res.shell} completion already configured in ${res.profilePath}`));
      }
    } catch (err: any) {
      console.error(pc.red(`Failed to install completion: ${err.message}`));
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
