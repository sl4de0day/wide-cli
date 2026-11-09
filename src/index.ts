import { Command } from "commander";
import pc from "picocolors";
import { Agent } from "./agent/index.js";
import { configManager } from "./config/index.js";
import { createProvider } from "./providers/index.js";
import { startRepl } from "./repl/index.js";
import { executeTool } from "./tools/index.js";

const program = new Command();

program
  .name("wide")
  .description("Terminal-first autonomous AI coding & security agent for the Wide ecosystem")
  .version("0.1.0")
  .argument("[prompt...]", "Optional one-shot prompt for the agent to execute")
  .option("-p, --provider <provider>", "LLM provider to use (gemini, ollama, claude, deepseek)")
  .option("-m, --model <model>", "Model name to use")
  .option("-y, --yes", "Auto-approve all file edits and command executions")
  .action(async (promptParts, options) => {
    const userPrompt = Array.isArray(promptParts) ? promptParts.join(" ").trim() : "";

    // If flags passed, temporarily update config
    if (options.yes) {
      configManager.set("autoApproveWrite", true);
      configManager.set("autoApproveRun", true);
    }

    if (userPrompt) {
      // One-shot mode
      try {
        const provider = createProvider(options.provider, options.model);
        const agent = new Agent(process.cwd(), provider);
        await agent.runPrompt(userPrompt);
      } catch (err: any) {
        console.error(`${pc.red("Error:")} ${err.message}`);
        process.exit(1);
      }
    } else {
      // Interactive REPL mode
      await startRepl();
    }
  });

// Standalone security scan command: wide scan
program
  .command("scan [path]")
  .description("Run Wide's native SAST security engine on the current workspace or target directory")
  .action(async (targetPath = ".") => {
    const res = await executeTool("run_security_scan", { path: targetPath }, { workingDirectory: process.cwd() });
    console.log(res.output);
  });

// Config management commands: wide config
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
  .description("Set configuration property (e.g. 'wide config set provider ollama')")
  .action((key, value) => {
    try {
      configManager.set(key as any, value);
      console.log(pc.green(`✔ Updated '${key}' to '${value}'`));
    } catch (err: any) {
      console.error(pc.red(`Failed to set config: ${err.message}`));
    }
  });

configCmd
  .command("set-key <provider> <apiKey>")
  .description("Store API key for a provider (e.g. 'wide config set-key gemini AIzaSy...')")
  .action((provider, apiKey) => {
    try {
      configManager.setApiKey(provider as any, apiKey);
      console.log(pc.green(`✔ Stored API key for provider '${provider}' in ~/.wide/config.json`));
    } catch (err: any) {
      console.error(pc.red(`Failed to set key: ${err.message}`));
    }
  });

await program.parseAsync(process.argv);
