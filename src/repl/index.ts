import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { Agent } from "../agent/index.js";
import { configManager } from "../config/index.js";
import { createProvider } from "../providers/index.js";
import { executeTool } from "../tools/index.js";
import { printBanner } from "../ui/banner.js";

export async function startRepl(): Promise<void> {
  printBanner();

  const cfg = configManager.get();
  console.log(`  ${pc.gray("Model:")} ${pc.cyan(`${cfg.provider}/${cfg.model}`)} - ${pc.gray("Workspace:")} ${pc.dim(process.cwd())}\n`);

  let agent: Agent;
  try {
    agent = new Agent(process.cwd());
  } catch (err: any) {
    console.log(`${pc.yellow("[WARN]")} ${err.message}`);
    console.log(`${pc.dim("Configure an API key using 'wide config set-key gemini <KEY>' or run Ollama locally.\n")}`);
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptUser = async () => {
    while (true) {
      try {
        const input = await rl.question(`${pc.cyan("wide")} ${pc.dim(">")} `);
        const trimmed = input.trim();

        if (!trimmed) continue;

        if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit") {
          console.log(pc.dim("Goodbye!"));
          rl.close();
          process.exit(0);
        }

        if (trimmed === "/clear") {
          console.clear();
          printBanner();
          agent.clearHistory();
          console.log(pc.green("[OK] Session history cleared.\n"));
          continue;
        }

        if (trimmed === "/help") {
          console.log(`\n${pc.bold("Available Slash Commands:")}`);
          console.log(`  ${pc.cyan("/help")}      Show this help menu`);
          console.log(`  ${pc.cyan("/scan")}      Run instant Wide SAST security scan in workspace`);
          console.log(`  ${pc.cyan("/model")}     Show or change current LLM provider and model`);
          console.log(`  ${pc.cyan("/clear")}     Clear chat context and screen`);
          console.log(`  ${pc.cyan("exit")}       Exit Wide CLI\n`);
          continue;
        }

        if (trimmed === "/scan") {
          const res = await executeTool("run_security_scan", { path: "." }, { workingDirectory: process.cwd() });
          console.log(res.output);
          continue;
        }

        if (trimmed.startsWith("/model")) {
          const parts = trimmed.split(" ").filter(Boolean);
          if (parts.length === 1) {
            const current = configManager.get();
            console.log(`Current model: ${pc.cyan(current.provider)} / ${pc.bold(current.model)}\n`);
          } else if (parts.length >= 3) {
            const newProv = parts[1] as any;
            const newMod = parts[2];
            configManager.set("provider", newProv);
            configManager.set("model", newMod);
            agent.setProvider(createProvider(newProv, newMod));
            console.log(pc.green(`[OK] Model switched to ${newProv}/${newMod}\n`));
          } else {
            console.log(`Usage: ${pc.cyan("/model <provider> <model_name>")}`);
            console.log(`Example: ${pc.dim("/model ollama deepseek-r1:7b")} or ${pc.dim("/model gemini gemini-2.5-flash")}\n`);
          }
          continue;
        }

        console.log("");
        try {
          await agent.runPrompt(trimmed);
          console.log("");
        } catch (err: any) {
          console.log(`\n${pc.red("Error:")} ${err.message}\n`);
        }
      } catch (err) {
        break;
      }
    }
  };

  await promptUser();
}
