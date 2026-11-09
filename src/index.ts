import { Command } from "commander";
import pc from "picocolors";
import { Agent } from "./agent/index.js";
import { configManager } from "./config/index.js";
import { loadWorkspaceConfig } from "./config/workspace.js";
import { createProvider } from "./providers/index.js";
import { startRepl } from "./repl/index.js";
import { executeTool } from "./tools/index.js";
import { getAllPayloadTypes } from "./security/payloads.js";
import { RuleLoader } from "./security/loader.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  return new Promise((resolvePromise) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolvePromise(data.trim());
    });
    process.stdin.on("error", () => {
      resolvePromise("");
    });
  });
}

const program = new Command();

program
  .name("wide")
  .description("Terminal-first autonomous AI coding and security agent for the Wide ecosystem")
  .version("0.291126")
  .argument("[prompt...]", "Optional one-shot prompt for the agent to execute")
  .option("-p, --provider <provider>", "LLM provider to use (gemini, ollama, claude, deepseek, openai)")
  .option("-m, --model <model>", "Model name to use")
  .option("-y, --yes", "Auto-approve all file edits and command executions")
  .action(async (promptParts, options) => {
    const pipedData = await readStdin();
    const argPrompt = Array.isArray(promptParts) ? promptParts.join(" ").trim() : "";
    let userPrompt = argPrompt;

    if (pipedData) {
      userPrompt = userPrompt ? `${userPrompt}\n\n[Piped Input]:\n${pipedData}` : pipedData;
    }

    if (options.yes) {
      configManager.set("autoApproveWrite", true);
      configManager.set("autoApproveRun", true);
    }

    const ws = loadWorkspaceConfig();
    if (ws.rules.length > 0) {
      console.log(pc.dim(`Loaded ${ws.rules.length} workspace rule(s) from .wide/rules`));
    }

    if (userPrompt) {
      try {
        const provider = createProvider(options.provider, options.model);
        const agent = new Agent(process.cwd(), provider);
        await agent.runPrompt(userPrompt);
      } catch (err: any) {
        console.error(`${pc.red("Error:")} ${err.message}`);
        process.exit(1);
      }
    } else {
      await startRepl();
    }
  });

program
  .command("scan [path]")
  .description("Run Wide native SAST security engine across 20+ vulnerability categories")
  .option("-s, --severity <level>", "Minimum severity (CRITICAL, HIGH, MEDIUM, LOW, ALL)", "ALL")
  .option("-r, --rules <path>", "Path to custom rules.json file")
  .action(async (targetPath = ".", opts) => {
    const res = await executeTool("run_security_scan", { path: targetPath, severityFilter: opts.severity, rulesPath: opts.rules }, { workingDirectory: process.cwd() });
    console.log(res.output);
  });

const rulesCmd = program
  .command("rules")
  .description("Manage and synchronize Wide security rules");

rulesCmd
  .command("update")
  .description("Download latest security rules from wide-rules database")
  .action(async () => {
    try {
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
  .action(() => {
    console.log(RuleLoader.getCachePath());
  });

program
  .command("payloads <type>")
  .description(`Output targeted security injection payloads (${getAllPayloadTypes().join(", ")})`)
  .action(async (type) => {
    const res = await executeTool("generate_payloads", { type }, { workingDirectory: process.cwd() });
    console.log(res.output);
  });

program
  .command("fuzz <url> <param> <type>")
  .description("Actively probe an endpoint parameter with injection vectors")
  .option("-X, --method <method>", "HTTP method (GET, POST)", "GET")
  .action(async (url, param, type, opts) => {
    const res = await executeTool("fuzz_endpoint", { url, param, payloadType: type, method: opts.method }, { workingDirectory: process.cwd() });
    console.log(res.output);
  });

const configCmd = program
  .command("config")
  .description("Manage Wide CLI configuration and API keys");

configCmd
  .command("list")
  .description("List current configuration")
  .action(() => {
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
  .action((key, value) => {
    try {
      configManager.set(key as any, value);
      console.log(pc.green(`[OK] Updated '${key}' to '${value}'`));
    } catch (err: any) {
      console.error(pc.red(`Failed to set config: ${err.message}`));
    }
  });

configCmd
  .command("set-key <provider> <apiKey>")
  .description("Store API key for a provider")
  .action((provider, apiKey) => {
    try {
      configManager.setApiKey(provider as any, apiKey);
      console.log(pc.green(`[OK] Stored API key for provider '${provider}' in ~/.wide/config.json`));
    } catch (err: any) {
      console.error(pc.red(`Failed to set key: ${err.message}`));
    }
  });

await program.parseAsync(process.argv);
