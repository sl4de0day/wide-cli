import pc from "picocolors";
import type { Agent } from "../agent/index.js";
import { configManager, type ProviderName, type WideConfig } from "../config/index.js";
import { createProvider, listOllamaModels, PROVIDER_PRESETS } from "../providers/index.js";

export type PromptQuestionFn = (question: string) => Promise<string>;

type ApiKeyProvider = keyof WideConfig["apiKeys"];

const PROVIDER_CHOICES: Array<{ index: string; name: ProviderName; label: string; needsKey: boolean }> = [
  { index: "1", name: "gemini", label: "Gemini (Google AI)", needsKey: true },
  { index: "2", name: "ollama", label: "Ollama (Local models)", needsKey: false },
  { index: "3", name: "claude", label: "Claude (Anthropic)", needsKey: true },
  { index: "4", name: "claude-code", label: "Claude Code (Subscription, no API key)", needsKey: false },
  { index: "5", name: "antigravity", label: "Google Antigravity (CLI sign-in, no API key)", needsKey: false },
  { index: "6", name: "codex", label: "OpenAI Codex (ChatGPT subscription, no API key)", needsKey: false },
  { index: "7", name: "deepseek", label: "DeepSeek", needsKey: true },
  { index: "8", name: "openai", label: "OpenAI", needsKey: true },
];

export async function runInteractiveSetup(ask: PromptQuestionFn, agent: Agent, isFirstLaunch = false): Promise<boolean> {
  const cfg = configManager.get();
  const ollama = await listOllamaModels(cfg.ollamaBaseUrl);

  console.log("");
  if (isFirstLaunch) {
    console.log(`${pc.yellow("[SETUP]")} ${pc.bold("No AI model provider is configured yet.")}`);
    console.log(pc.dim("Configure one now to start chatting, or press Enter to skip into the CLI shell.\n"));
  } else {
    console.log(`${pc.cyan("[SETUP]")} ${pc.bold("Configure AI Provider & Model")}\n`);
  }

  for (const item of PROVIDER_CHOICES) {
    let note = "";
    if (item.name === "ollama") {
      note = ollama.reachable
        ? pc.green(` (running, ${ollama.models.length} model(s))`)
        : pc.dim(" (not detected on localhost:11434)");
    } else if (item.name === "claude-code") {
      note = pc.dim(" (uses local claude CLI login)");
    } else if (item.name === "antigravity") {
      note = pc.dim(" (uses local agy CLI login)");
    } else if (item.name === "codex") {
      note = pc.dim(" (uses local codex ChatGPT login)");
    } else if (configManager.getApiKey(item.name as ApiKeyProvider)) {
      note = pc.green(" (key saved)");
    }
    console.log(`  ${pc.cyan(item.index)}. ${pc.white(item.label)}${note}`);
  }
  console.log(`  ${pc.cyan("0")}. ${pc.dim("Skip for now (use /scan, /rules, /help, !shell)")}\n`);

  const selection = (await ask(`  ${pc.cyan("Provider [1-6, Enter to skip]:")} `)).trim();
  if (!selection || selection === "0" || selection.toLowerCase() === "skip") {
    console.log(pc.dim("  Skipped setup. Run /setup or /key <provider> <key> anytime.\n"));
    return false;
  }

  const chosen =
    PROVIDER_CHOICES.find((c) => c.index === selection || c.name === selection.toLowerCase()) || null;
  if (!chosen) {
    console.log(pc.yellow(`  Unknown selection '${selection}'. Run /setup to try again.\n`));
    return false;
  }

  if (chosen.needsKey && chosen.name !== "ollama" && chosen.name !== "claude-code" && chosen.name !== "antigravity" && chosen.name !== "codex") {
    const keyProvider = chosen.name as ApiKeyProvider;
    const existing = configManager.getApiKey(keyProvider);
    const keyPrompt = existing
      ? `  ${pc.cyan(`${chosen.name} API key`)} ${pc.dim("(Enter to keep existing)")}: `
      : `  ${pc.cyan(`${chosen.name} API key`)} ${pc.dim("(paste key or Enter to cancel)")}: `;
    const keyInput = (await ask(keyPrompt)).trim();
    if (!keyInput && !existing) {
      console.log(pc.yellow("  Cancelled setup: API key is required for this provider.\n"));
      return false;
    }
    if (keyInput) {
      configManager.setApiKey(keyProvider, keyInput);
    }
  }

  let availableModels = PROVIDER_PRESETS[chosen.name];
  if (chosen.name === "ollama" && ollama.models.length > 0) {
    availableModels = ollama.models;
  }

  const defaultModel = availableModels[0];
  console.log(`\n  ${pc.dim("Suggested models:")} ${availableModels.map((m) => pc.cyan(m)).join(", ")}`);
  const chosenModel = (await ask(`  ${pc.cyan(`Model [${defaultModel}]:`)} `)).trim() || defaultModel;

  configManager.set("provider", chosen.name);
  configManager.set("model", chosenModel);
  agent.setProvider(createProvider(chosen.name, chosenModel));

  console.log(`${pc.green("\n[OK]")} Active model set to ${pc.cyan(`${chosen.name}/${chosenModel}`)}\n`);
  return true;
}
