import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { debugLog, enableDebugLogging } from "./config/logger.js";
import { formatErrorCard } from "./ui/errors.js";
import { formatCrawlReport, formatInspectReport } from "./ui/reports.js";
import { restoreTerminalCursor, Spinner } from "./ui/spinner.js";
import { glyphs, setColorDepthOverride, theme } from "./ui/theme.js";
import { disableTerminalInputModes, setMouseEnabled } from "./ui/tui/keys.js";

const CLI_VERSION = "0.9.251126";

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

function listGitChangedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    const files: string[] = [];
    for (const raw of out.split(/\r?\n/)) {
      if (!raw.trim() || raw.startsWith(" D") || raw.startsWith("D ")) continue;
      const p = raw.slice(3).trim().replace(/^"|"$/g, "");
      const finalPath = p.includes(" -> ") ? p.split(" -> ").pop()!.trim() : p;
      if (finalPath) files.push(finalPath);
    }
    return [...new Set(files)];
  } catch {
    return [];
  }
}

let cursorHookRegistered = false;
function ensureTerminalCleanupHook(): void {
  if (cursorHookRegistered) return;
  cursorHookRegistered = true;
  process.on("exit", () => {
    disableTerminalInputModes();
    restoreTerminalCursor();
  });
}

const program = new Command();

program
  .name("wide")
  .description("Wide — Security-first autonomous AI coding and AppSec agent in your terminal")
  .version(CLI_VERSION)
  .option("-d, --debug", "Enable structured debug diagnostics to stderr")
  .option("-v, --verbose", "Show expanded tool outputs and verbose diagnostics")
  .option("-q, --quiet", "Suppress non-essential banners and status lines")
  .option("--no-color", "Disable ANSI color formatting")
  .option("--no-mouse", "Disable terminal mouse click and wheel interaction")
  .argument("[prompt...]", "Optional initial prompt for the agent")
  .option("-p, --print", "Run a single prompt non-interactively and exit")
  .option("--output-format <format>", "Output format for --print mode (text, json, stream-json)", "text")
  .option("-c, --continue", "Resume the most recent saved interactive session")
  .option("-r, --resume [sessionId]", "Resume a saved interactive session by ID")
  .option("--provider <provider>", "LLM provider (antigravity, claude-code, gemini, claude, ollama, codex, deepseek, openai)")
  .option("-m, --model <model>", "Model name to use")
  .option("--mode <mode>", "Tool mode (full, code, security)")
  .option("--plan", "Start in read-only Plan mode (no disk writes or shell execution)")
  .option("--no-browser", "Disable interactive browser_* tools")
  .option("-y, --yes", "Auto-approve all file edits and non-destructive command executions")
  .addHelpText(
    "after",
    [
      "",
      "Command Groups:",
      "  Interactive Agent:    wide [prompt]  |  wide -c  |  wide --plan  |  wide -p --output-format json",
      "  Security Analysis:    scan  |  crawl  |  inspect  |  fuzz  |  payloads",
      "  Remediation & Hooks:  fix  |  hook install|uninstall|run",
      "  Setup & Diagnostics:  doctor  |  config  |  rules  |  update  |  completion",
      "",
      "Examples:",
      "  $ wide                                      Launch interactive TUI session",
      "  $ wide --plan \"design auth refactor\"         Start in read-only Plan mode",
      "  $ git diff | wide -p \"review for security\"   Pipe stdin into non-interactive agent",
      "  $ wide scan . --fail-on HIGH --changed      CI gate over git-modified files",
      "  $ wide fix . --ai                           Interactive security patch review",
      "  $ wide doctor                               Verify providers, rules, and terminal setup",
      "",
    ].join("\n"),
  )
  .hook("preAction", () => {
    const rootOpts = program.opts();
    if (rootOpts.color === false || process.argv.includes("--no-color")) {
      setColorDepthOverride("none");
    }
    if (rootOpts.mouse === false || process.argv.includes("--no-mouse")) {
      setMouseEnabled(false);
    }
    if (rootOpts.debug || rootOpts.verbose) {
      enableDebugLogging();
      debugLog("cli", `invoked argv=${JSON.stringify(process.argv.slice(2))}`);
    }
  })
  .action(async (promptParts, options) => {
    ensureTerminalCleanupHook();
    const pipedData = await readPipedStdin(Boolean(options.print));
    const argPrompt = Array.isArray(promptParts) ? promptParts.join(" ").trim() : "";
    let userPrompt = argPrompt;

    if (pipedData) {
      userPrompt = userPrompt ? `${userPrompt}\n\n[Piped Input]:\n${pipedData}` : pipedData;
    }

    const outputFormat = String(options.outputFormat || "text").trim().toLowerCase();
    if (outputFormat !== "text" && outputFormat !== "json" && outputFormat !== "stream-json") {
      console.error(formatErrorCard(new Error(`Invalid --output-format '${options.outputFormat}'. Choose text, json, or stream-json.`)));
      process.exit(1);
    }

    const nonInteractive = Boolean(options.print || pipedData);
    const { loadWorkspaceConfig } = await import("./config/workspace.js");
    const ws = loadWorkspaceConfig();
    if (ws.rules.length > 0 && !options.quiet && !nonInteractive) {
      console.error(theme.faint(`  Loaded ${ws.rules.length} workspace rule(s) from .wide/rules`));
    }

    if (options.mode !== undefined) {
      const normalizedMode = String(options.mode).trim().toLowerCase();
      if (normalizedMode !== "full" && normalizedMode !== "code" && normalizedMode !== "security") {
        console.error(formatErrorCard(new Error(`Invalid --mode '${options.mode}'. Choose one of: full, code, security.`)));
        process.exit(1);
      }
      options.mode = normalizedMode;
    }

    const cliToolMode = options.mode as "full" | "code" | "security" | undefined;
    const cliAllowBrowser = options.browser === false ? false : undefined;
    const cliPermProfile = options.plan ? "plan" : options.yes ? "auto" : undefined;

    if (nonInteractive) {
      if (!userPrompt) {
        console.error(formatErrorCard(new Error("--print requires a prompt or piped input.")));
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
        const agent = new Agent(process.cwd(), provider, {
          toolMode: cliToolMode,
          allowBrowser: cliAllowBrowser,
          permissionProfile: cliPermProfile,
          verbose: Boolean(options.verbose),
        });
        if (options.continue) {
          const latest = loadLatestSession();
          if (latest) agent.loadMessages(latest.messages);
        } else if (typeof options.resume === "string") {
          const saved = loadSession(options.resume);
          if (saved) agent.loadMessages(saved.messages);
        }

        const isJson = outputFormat === "json";
        const isStreamJson = outputFormat === "stream-json";
        const finalAnswer = await agent.runPrompt(userPrompt, {
          autoApproveWrite: options.yes ? true : undefined,
          autoApproveRun: options.yes ? true : undefined,
          permissionProfile: cliPermProfile,
          rawOutput: outputFormat === "text" && !process.stdout.isTTY,
          silent: isJson || isStreamJson,
          statusStream: process.stderr,
          onStreamEvent: isStreamJson
            ? (ev) => {
                process.stdout.write(`${JSON.stringify(ev)}\n`);
              }
            : undefined,
        });

        if (isJson) {
          process.stdout.write(
            `${JSON.stringify(
              {
                ok: true,
                provider: provider.name,
                model: provider.model,
                response: finalAnswer,
                stats: agent.getStats(),
              },
              null,
              2,
            )}\n`,
          );
        }

        if (agent.getAllowBrowser()) {
          await executeTool("browser_close", {}, { workingDirectory: process.cwd() });
        }
      } catch (err: any) {
        if (outputFormat === "json" || outputFormat === "stream-json") {
          process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
        } else {
          console.error(formatErrorCard(err));
        }
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
      toolMode: cliToolMode,
      allowBrowser: cliAllowBrowser,
      permissionProfile: cliPermProfile,
      verbose: Boolean(options.verbose),
    });
  });

program
  .command("doctor")
  .description("Check terminal capabilities, provider auth, Git status, and security rules health")
  .option("--json", "Output diagnostic checks as JSON")
  .action(async (opts) => {
    const { runDoctorDiagnostics, formatDoctorReport } = await import("./repl/doctor.js");
    const items = await runDoctorDiagnostics(process.cwd(), CLI_VERSION);
    if (opts.json) {
      console.log(JSON.stringify({ version: CLI_VERSION, checks: items }, null, 2));
      return;
    }
    console.log(formatDoctorReport(items));
  });

program
  .command("scan [path]")
  .description("Run Wide native SAST, taint flow, and OSV SCA security engine")
  .option("-s, --severity <level>", "Minimum severity (CRITICAL, HIGH, MEDIUM, LOW, ALL)", "ALL")
  .option("-r, --rules <path>", "Path to custom rules.json file")
  .option("--no-sca", "Disable OSV dependency vulnerability scanning")
  .option("--history", "Scan recent git commits for historically leaked secrets")
  .option("--sarif <file>", "Write findings in SARIF 2.1.0 JSON format")
  .option("-f, --format <fmt>", "Output format (table, compact, json, sarif)", "table")
  .option("--fail-on <severity>", "Exit with code 1 if any finding meets or exceeds severity (CRITICAL, HIGH, MEDIUM, LOW)")
  .option("--changed", "Scan only git-modified and untracked workspace files")
  .action(async (targetPath = ".", opts) => {
    const fmt = String(opts.format || "table").trim().toLowerCase();
    if (!["table", "compact", "json", "sarif"].includes(fmt)) {
      console.error(formatErrorCard(new Error(`Invalid --format '${opts.format}'. Choose table, compact, json, or sarif.`)));
      process.exitCode = 1;
      return;
    }

    const spinner =
      fmt === "table" && process.stderr.isTTY
        ? new Spinner(`Scanning ${opts.changed ? "git-changed files" : targetPath}...`, { stream: process.stderr }).start()
        : null;

    const t0 = Date.now();
    try {
      const { SecurityScanner, meetsSeverityThreshold } = await import("./security/scanner.js");
      const scanner = new SecurityScanner(process.cwd(), opts.rules);
      const sev = String(opts.severity || "ALL").toUpperCase() as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "ALL";
      const scanOpts = {
        sca: opts.sca !== false,
        scanHistory: Boolean(opts.history),
        sarifPath: opts.sarif,
      };

      let result;
      if (opts.changed) {
        const changedFiles = listGitChangedFiles(process.cwd());
        if (changedFiles.length === 0) {
          spinner?.stop(true);
          if (fmt === "json") {
            console.log(JSON.stringify({ totalFilesScanned: 0, findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0 } }, null, 2));
          } else {
            console.log(`  ${theme.ok(glyphs.dot)} No git-modified files to scan.`);
          }
          return;
        }
        result = await scanner.scanFiles(changedFiles, sev, scanOpts);
      } else {
        result = await scanner.scanPath(targetPath, sev, scanOpts);
      }

      spinner?.stop(true);
      const elapsedMs = Date.now() - t0;

      if (fmt === "json") {
        console.log(JSON.stringify({ ...result, elapsedMs }, null, 2));
      } else if (fmt === "sarif") {
        console.log(JSON.stringify(scanner.formatSarif(result), null, 2));
      } else if (fmt === "compact") {
        console.log(scanner.formatCompactReport(result));
      } else {
        console.log(scanner.formatCliReport(result, { elapsedMs }));
      }

      if (opts.failOn && meetsSeverityThreshold(result.findings, opts.failOn)) {
        process.exitCode = 1;
      }
    } catch (err: any) {
      spinner?.stop(true);
      console.error(formatErrorCard(err));
      process.exitCode = 1;
    }
  });

program
  .command("fix [path]")
  .description("Interactively review and apply security patches or quick-fix suppressions")
  .option("-s, --severity <level>", "Minimum severity to fix (CRITICAL, HIGH, MEDIUM, LOW, ALL)", "HIGH")
  .option("-r, --rules <path>", "Path to custom rules.json file")
  .option("-y, --yes", "Auto-apply all proposed patches without interactive confirmation")
  .option("--dry-run", "Preview proposed diffs without writing modifications to disk")
  .option("--suppress", "Only generate quick-fix suppressions (wide-ignore directives)")
  .option("--ai", "Use AI LLM provider to synthesize intelligent code remediation patches")
  .option("--provider <provider>", "LLM provider override")
  .option("-m, --model <model>", "Model name override")
  .action(async (targetPath = ".", opts) => {
    try {
      const { runInteractiveFix } = await import("./fix.js");
      await runInteractiveFix({
        path: targetPath,
        severity: opts.severity,
        rulesPath: opts.rules,
        yes: Boolean(opts.yes),
        dryRun: Boolean(opts.dryRun),
        suppressOnly: Boolean(opts.suppress),
        ai: Boolean(opts.ai),
        provider: opts.provider,
        model: opts.model,
        cwd: process.cwd()
      });
    } catch (err: any) {
      console.error(formatErrorCard(err));
      process.exit(1);
    }
  });

program
  .command("update")
  .alias("upgrade")
  .description("Check for updates and synchronize the Wide CLI and rules to the latest version")
  .action(async () => {
    const spinner = new Spinner("Synchronizing Wide security rules...", { stream: process.stderr }).start();
    try {
      const { RuleLoader } = await import("./security/loader.js");
      const ruleResult = await RuleLoader.updateRules();
      spinner.stop(true);
      console.log(`  ${theme.ok(glyphs.dot)} Synchronized ${theme.fgBold(String(ruleResult.count))} security rules to ${theme.faint(ruleResult.path)}`);

      const checkSpinner = new Spinner("Checking for Wide CLI updates...", { stream: process.stderr }).start();
      const res = await fetch("https://api.github.com/repos/sl4de0day/wide-cli/releases/latest", {
        headers: { "User-Agent": "Wide-CLI", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000)
      });
      checkSpinner.stop(true);
      if (res.ok) {
        const release = (await res.json()) as any;
        const latestTag = String(release.tag_name || release.name || "").replace(/^v/i, "");
        if (latestTag && latestTag !== CLI_VERSION) {
          console.log(`  ${theme.warn(glyphs.warn)} New Wide CLI version available: ${theme.fgBold(`v${latestTag}`)} ${theme.faint(`(current: v${CLI_VERSION})`)}`);
          console.log(`  ${theme.info("Next:")} Run ${theme.info("npm install -g wide-cli")} to update.`);
        } else {
          console.log(`  ${theme.ok(glyphs.dot)} Wide CLI is up to date (${theme.info(`v${CLI_VERSION}`)}).`);
        }
      }
    } catch (err: any) {
      spinner.stop(true);
      console.error(formatErrorCard(err));
    }
  });

const rulesCmd = program
  .command("rules")
  .description("Manage and synchronize Wide security rules");

rulesCmd
  .command("update")
  .description("Download latest security rules from wide-rules database")
  .action(async () => {
    const spinner = new Spinner("Downloading latest rules from wide-rules...", { stream: process.stderr }).start();
    try {
      const { RuleLoader } = await import("./security/loader.js");
      const result = await RuleLoader.updateRules();
      spinner.stop(true);
      console.log(`  ${theme.ok(glyphs.dot)} Synchronized ${result.count} rules and ${result.osvCount} OSV advisories to ${theme.faint(result.path)}`);
    } catch (err: any) {
      spinner.stop(true);
      console.error(formatErrorCard(err));
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
    console.log(`\n  ${theme.fgBold(`Active AI Agent Security Rules (${rules.length})`)} ${theme.faint(`[source: ${info.active}]`)}\n`);
    for (const r of rules) {
      console.log(`    ${theme.info(r.id)} ${theme.severity(r.severity)} ${theme.faint(`(${r.cwe})`)} ${theme.muted(r.message)}`);
    }
    console.log("");
  });

program
  .command("payloads <type>")
  .description("Output targeted security injection payloads (sqli, xss, ssrf, traversal, cmd, ssti)")
  .action(async (type) => {
    const { executeTool } = await import("./tools/index.js");
    const res = await executeTool("generate_payloads", { type }, { workingDirectory: process.cwd() });
    if (!res.success && res.error) {
      console.error(formatErrorCard(new Error(res.error)));
      process.exitCode = 1;
      return;
    }
    console.log(res.output);
  });

program
  .command("fuzz <url> <param> <type>")
  .description("Actively probe an endpoint parameter with injection vectors")
  .option("-X, --method <method>", "HTTP method (GET, POST)", "GET")
  .action(async (url, param, type, opts) => {
    const spinner = new Spinner(`Fuzzing ${param} (${type}) on ${url}...`, { stream: process.stderr }).start();
    const { executeTool } = await import("./tools/index.js");
    const res = await executeTool("fuzz_endpoint", { url, param, payloadType: type, method: opts.method }, { workingDirectory: process.cwd() });
    spinner.stop(true);
    if (!res.success && res.error) {
      console.error(formatErrorCard(new Error(res.error)));
      process.exitCode = 1;
      return;
    }
    console.log(res.output);
  });

program
  .command("crawl <url>")
  .description("Crawl a web target with SSRF protection, PathTrie normalization, SimHash dedup, and passive audits")
  .option("-d, --depth <n>", "Crawl depth limit", "3")
  .option("-m, --max-pages <n>", "Maximum pages to crawl", "80")
  .option("-s, --scope <mode>", "Scope mode (rdn, fqdn, dn)", "rdn")
  .option("--allow-private", "Allow private/loopback addresses")
  .option("--tls-profile <profile>", "TLS/browser profile (none, chrome, firefox, safari)", "none")
  .option("--json", "Output raw crawl result as JSON")
  .action(async (url, opts) => {
    const spinner = !opts.json && process.stderr.isTTY ? new Spinner(`Crawling ${url}...`, { stream: process.stderr }).start() : null;
    try {
      const { WideCrawler } = await import("./security/crawler.js");
      const crawler = new WideCrawler();
      const result = await crawler.crawl(url, {
        maxDepth: Number(opts.depth) || 3,
        maxPages: Number(opts.maxPages) || 80,
        fieldScope: opts.scope || "rdn",
        allowPrivate: Boolean(opts.allowPrivate),
        tlsProfile: opts.tlsProfile || "none",
      });
      spinner?.stop(true);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatCrawlReport(result));
      }
    } catch (err: any) {
      spinner?.stop(true);
      console.error(formatErrorCard(err));
      process.exitCode = 1;
    }
  });

program
  .command("inspect <url>")
  .description("Inspect an HTTP request/wire frame for RFC 9112 smuggling, evasion decoding, lexical SQLi/XSS, and scored policy")
  .option("-X, --method <method>", "HTTP method", "GET")
  .option("-b, --body <body>", "Request body")
  .option("--raw <wire>", "Raw HTTP/1.x wire request")
  .option("--learn", "Generate dated exception drafts")
  .option("--json", "Output raw inspection report as JSON")
  .action(async (url, opts) => {
    try {
      const { evaluateHttpInspection } = await import("./security/inspect.js");
      const report = evaluateHttpInspection(
        {
          url,
          method: opts.method || "GET",
          headers: {},
          body: opts.body || "",
          rawRequest: opts.raw,
        },
        { learning: Boolean(opts.learn) },
      );
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatInspectReport(url, opts.method || "GET", report));
      }
    } catch (err: any) {
      console.error(formatErrorCard(err));
      process.exitCode = 1;
    }
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
    console.log(`\n  ${theme.fgBold("Wide CLI Configuration:")}`);
    console.log(`    Provider:        ${theme.info(cfg.provider)}`);
    console.log(`    Model:           ${theme.info(cfg.model)}`);
    console.log(`    Tool Mode:       ${theme.accent(cfg.toolMode || "full")}`);
    console.log(`    Ollama URL:      ${theme.faint(cfg.ollamaBaseUrl)}`);
    console.log(`    Auto-Approve:    Read=${cfg.autoApproveRead}, Write=${cfg.autoApproveWrite}, Run=${cfg.autoApproveRun}`);
    console.log(`    Config Path:     ${theme.faint("~/.wide/config.json")}\n`);
  });

configCmd
  .command("set <key> <value>")
  .description("Set configuration property")
  .action(async (key, value) => {
    try {
      const { configManager } = await import("./config/index.js");
      configManager.set(key as any, value);
      console.log(`  ${theme.ok(glyphs.dot)} Updated '${key}' to '${value}'`);
    } catch (err: any) {
      console.error(formatErrorCard(err));
    }
  });

configCmd
  .command("set-key <provider> <apiKey>")
  .description("Store API key for a provider")
  .action(async (provider, apiKey) => {
    try {
      const { configManager } = await import("./config/index.js");
      configManager.setApiKey(provider as any, apiKey);
      console.log(`  ${theme.ok(glyphs.dot)} Stored API key for provider '${provider}' in ~/.wide/config.json`);
    } catch (err: any) {
      console.error(formatErrorCard(err));
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
      console.error(formatErrorCard(err));
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
        console.log(`  ${theme.ok(glyphs.dot)} Installed ${res.shell} completion in ${theme.info(res.profilePath)}`);
      } else {
        console.log(`  ${theme.info(glyphs.dot)} ${res.shell} completion already configured in ${theme.info(res.profilePath)}`);
      }
    } catch (err: any) {
      console.error(formatErrorCard(err));
      process.exit(1);
    }
  });

const hookCmd = program
  .command("hook")
  .description("Manage and execute Git pre-commit security hooks");

hookCmd
  .command("install")
  .description("Install Wide pre-commit security hook in the current Git repository")
  .option("--fail-on <severity>", "Minimum severity to block commit (CRITICAL, HIGH, MEDIUM, LOW)", "HIGH")
  .option("-f, --force", "Overwrite existing pre-commit hook")
  .action(async (opts) => {
    try {
      const { installPreCommitHook } = await import("./hook.js");
      const res = installPreCommitHook({
        failOn: opts.failOn,
        force: Boolean(opts.force),
        cwd: process.cwd()
      });
      if (res.installed) {
        console.log(`  ${theme.ok(glyphs.dot)} Pre-commit hook installed to ${theme.info(res.hookPath)}`);
      } else {
        console.log(`  ${theme.info(glyphs.dot)} ${res.message}`);
      }
    } catch (err: any) {
      console.error(formatErrorCard(err));
      process.exit(1);
    }
  });

hookCmd
  .command("uninstall")
  .description("Uninstall Wide pre-commit security hook from the current Git repository")
  .action(async () => {
    try {
      const { uninstallPreCommitHook } = await import("./hook.js");
      const res = uninstallPreCommitHook({ cwd: process.cwd() });
      if (res.uninstalled) {
        console.log(`  ${theme.ok(glyphs.dot)} Pre-commit hook removed from ${theme.info(res.hookPath)}`);
      } else {
        console.log(`  ${theme.warn(glyphs.warn)} ${res.message}`);
      }
    } catch (err: any) {
      console.error(formatErrorCard(err));
      process.exit(1);
    }
  });

hookCmd
  .command("run")
  .description("Run security check against staged Git changes")
  .option("--fail-on <severity>", "Minimum severity to block commit (CRITICAL, HIGH, MEDIUM, LOW)", "HIGH")
  .option("-r, --rules <path>", "Path to custom rules.json file")
  .action(async (opts) => {
    try {
      const { runPreCommitHook } = await import("./hook.js");
      const res = await runPreCommitHook({
        failOn: opts.failOn,
        rulesPath: opts.rules,
        cwd: process.cwd()
      });
      if (res.blocked) {
        process.exit(1);
      }
    } catch (err: any) {
      console.error(formatErrorCard(err));
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
