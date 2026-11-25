import type { Agent } from "../agent/index.js";
import { configManager, type ProviderName, type WideConfig } from "../config/index.js";
import {
  checkAntigravityStatus,
  checkClaudeCodeAuth,
  createProvider,
  listOllamaModels,
  PROVIDER_PRESETS,
} from "../providers/index.js";
import { glyphs, theme } from "../ui/theme.js";
import { askInlineText } from "../ui/tui/composer.js";
import { runInteractiveSelect, type SelectOption } from "../ui/tui/select.js";

export type PromptQuestionFn = (question: string) => Promise<string>;

type ApiKeyProvider = keyof WideConfig["apiKeys"];

export interface DetectedProviderState {
  name: ProviderName;
  label: string;
  needsKey: boolean;
  ready: boolean;
  badge?: string;
  badgeTone?: "ok" | "warn" | "info" | "muted";
  detail: string;
  models: string[];
}

const PROVIDER_META: Array<{ index: string; name: ProviderName; label: string; needsKey: boolean }> = [
  { index: "1", name: "antigravity", label: "Google Antigravity", needsKey: false },
  { index: "2", name: "claude-code", label: "Claude Code", needsKey: false },
  { index: "3", name: "gemini", label: "Gemini (Google AI)", needsKey: true },
  { index: "4", name: "claude", label: "Claude (Anthropic)", needsKey: true },
  { index: "5", name: "ollama", label: "Ollama (Local)", needsKey: false },
  { index: "6", name: "codex", label: "OpenAI Codex", needsKey: false },
  { index: "7", name: "openai", label: "OpenAI", needsKey: true },
  { index: "8", name: "deepseek", label: "DeepSeek", needsKey: true },
];

export async function probeProviderStates(): Promise<DetectedProviderState[]> {
  const cfg = configManager.get();
  const [ollama, claudeAuth, agyStatus] = await Promise.all([
    listOllamaModels(cfg.ollamaBaseUrl),
    checkClaudeCodeAuth(),
    checkAntigravityStatus(),
  ]);

  const states: DetectedProviderState[] = PROVIDER_META.map((item) => {
    if (item.name === "antigravity") {
      const models = agyStatus.models.length > 0 ? ["default", ...agyStatus.models] : PROVIDER_PRESETS.antigravity;
      return {
        name: item.name,
        label: item.label,
        needsKey: false,
        ready: agyStatus.signedIn,
        badge: agyStatus.signedIn ? "READY" : agyStatus.installed ? "SIGN IN" : undefined,
        badgeTone: agyStatus.signedIn ? "ok" : agyStatus.installed ? "warn" : "muted",
        detail: agyStatus.signedIn
          ? `CLI v${agyStatus.version || "latest"} signed in (${agyStatus.models.length} models)`
          : agyStatus.installed
            ? `Installed (v${agyStatus.version || "cli"}), run 'agy' to sign in`
            : "Local agy CLI sign-in, no API key",
        models,
      };
    }
    if (item.name === "claude-code") {
      return {
        name: item.name,
        label: item.label,
        needsKey: false,
        ready: Boolean(claudeAuth?.loggedIn),
        badge: claudeAuth?.loggedIn ? "READY" : claudeAuth ? "SIGN IN" : undefined,
        badgeTone: claudeAuth?.loggedIn ? "ok" : claudeAuth ? "warn" : "muted",
        detail: claudeAuth?.loggedIn
          ? `Signed in${claudeAuth.subscriptionType ? ` (${claudeAuth.subscriptionType})` : ""}`
          : claudeAuth
            ? "Installed, run 'claude auth login'"
            : "Local claude CLI subscription, no API key",
        models: PROVIDER_PRESETS["claude-code"],
      };
    }
    if (item.name === "ollama") {
      const models = ollama.models.length > 0 ? ollama.models : PROVIDER_PRESETS.ollama;
      return {
        name: item.name,
        label: item.label,
        needsKey: false,
        ready: ollama.reachable && ollama.models.length > 0,
        badge: ollama.reachable ? "RUNNING" : undefined,
        badgeTone: ollama.reachable ? "ok" : "muted",
        detail: ollama.reachable
          ? `${ollama.models.length} local model(s) on ${cfg.ollamaBaseUrl}`
          : `Not detected at ${cfg.ollamaBaseUrl}`,
        models,
      };
    }
    if (item.name === "codex") {
      return {
        name: item.name,
        label: item.label,
        needsKey: false,
        ready: false,
        detail: "Local codex CLI ChatGPT sign-in, no API key",
        models: PROVIDER_PRESETS.codex,
      };
    }
    const hasKey = Boolean(configManager.getApiKey(item.name as ApiKeyProvider));
    return {
      name: item.name,
      label: item.label,
      needsKey: true,
      ready: hasKey,
      badge: hasKey ? "KEY SAVED" : undefined,
      badgeTone: hasKey ? "ok" : "muted",
      detail: hasKey ? "API key detected" : "Requires API key",
      models: PROVIDER_PRESETS[item.name],
    };
  });

  states.sort((a, b) => Number(b.ready) - Number(a.ready));
  return states;
}

export async function tryAutoConnectProvider(agent: Agent): Promise<{ provider: ProviderName; model: string } | null> {
  if (agent.hasProvider()) return null;
  const states = await probeProviderStates();
  const readyLocal = states.filter((s) => s.ready && !s.needsKey);
  if (readyLocal.length === 1) {
    const picked = readyLocal[0];
    const model = picked.models[0] || "default";
    configManager.set("provider", picked.name);
    configManager.set("model", model);
    agent.setProvider(createProvider(picked.name, model));
    return { provider: picked.name, model };
  }
  return null;
}

export async function runInteractiveSetup(
  ask: PromptQuestionFn,
  agent: Agent,
  isFirstLaunch = false,
  signal?: AbortSignal,
): Promise<boolean> {
  const states = await probeProviderStates();
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (isTty) {
    const selectOpts: SelectOption<ProviderName | "__skip__">[] = states.map((st) => ({
      value: st.name,
      label: st.label,
      description: st.detail,
      badge: st.badge,
      badgeTone: st.badgeTone,
    }));
    selectOpts.push({
      value: "__skip__",
      label: "Skip for now",
      description: "Use /scan, /rules, /doctor, !shell without an AI provider",
    });

    const chosenName = await runInteractiveSelect({
      title: isFirstLaunch ? "Wide Provider Setup" : "Switch AI Provider",
      subtitle: isFirstLaunch
        ? "Select an AI provider to start chatting (ready local CLIs appear first)."
        : "Choose a provider and model for this workspace.",
      options: selectOpts,
      searchable: false,
      signal,
    });

    if (!chosenName || chosenName === "__skip__") {
      console.log(`  ${theme.faint("Skipped setup. Run /setup or /key <provider> anytime.")}\n`);
      return false;
    }

    const chosen = states.find((s) => s.name === chosenName);
    if (!chosen) return false;

    if (chosen.needsKey) {
      const keyProvider = chosen.name as ApiKeyProvider;
      const existing = configManager.getApiKey(keyProvider);
      const rawKey = await askInlineText(`${chosen.label} API Key`, {
        masked: true,
        placeholder: existing ? "Press Enter to keep saved key, or paste a new key" : "Paste API key (input is masked)",
        signal,
      });
      if (rawKey === null) {
        console.log(`  ${theme.warn(glyphs.warn)} ${theme.muted("Setup cancelled.")}\n`);
        return false;
      }
      const trimmedKey = rawKey.trim();
      if (!trimmedKey && !existing) {
        console.log(`  ${theme.warn(glyphs.warn)} ${theme.muted("API key is required for this provider.")}\n`);
        return false;
      }
      if (trimmedKey) {
        configManager.setApiKey(keyProvider, trimmedKey);
      }
    }

    const modelOptions: SelectOption<string>[] = chosen.models.map((m, idx) => ({
      value: m,
      label: m,
      badge: idx === 0 ? "DEFAULT" : undefined,
      badgeTone: "accent",
    }));
    modelOptions.push({
      value: "__custom__",
      label: "Custom model name...",
      description: "Type an exact model identifier",
    });

    let chosenModel = await runInteractiveSelect({
      title: `${chosen.label} Model`,
      options: modelOptions,
      searchable: chosen.models.length > 6,
      signal,
    });
    if (!chosenModel) {
      console.log(`  ${theme.warn(glyphs.warn)} ${theme.muted("Model selection cancelled.")}\n`);
      return false;
    }
    if (chosenModel === "__custom__") {
      const custom = await askInlineText("Custom Model ID", {
        placeholder: chosen.models[0],
        signal,
      });
      chosenModel = (custom || "").trim() || chosen.models[0];
    }

    configManager.set("provider", chosen.name);
    configManager.set("model", chosenModel);
    agent.setProvider(createProvider(chosen.name, chosenModel));
    console.log(`  ${theme.ok(glyphs.dot)} Active model set to ${theme.info(`${chosen.name}/${chosenModel}`)}\n`);
    return true;
  }

  console.log("");
  console.log(`  ${theme.accentBold("Setup")} ${theme.fgBold("Configure AI Provider & Model")}\n`);
  states.forEach((item, idx) => {
    const tag = item.badge ? ` ${theme.badge(item.badge, item.badgeTone || "muted")}` : "";
    console.log(`  ${theme.info(String(idx + 1))}. ${theme.fg(item.label)} ${theme.faint(item.detail)}${tag}`);
  });
  console.log(`  ${theme.info("0")}. ${theme.faint("Skip for now")}\n`);

  const selection = (await ask(`  ${theme.accent("Provider [1-8, Enter to skip]:")} `)).trim();
  if (!selection || selection === "0" || selection.toLowerCase() === "skip") {
    console.log(`  ${theme.faint("Skipped setup. Run /setup or /key <provider> <key> anytime.")}\n`);
    return false;
  }

  const numericIdx = Number(selection);
  const chosen =
    (Number.isInteger(numericIdx) && numericIdx >= 1 && numericIdx <= states.length ? states[numericIdx - 1] : null) ||
    states.find((c) => c.name === selection.toLowerCase()) ||
    null;

  if (!chosen) {
    console.log(`  ${theme.warn(glyphs.warn)} Unknown selection '${selection}'. Run /setup to try again.\n`);
    return false;
  }

  if (chosen.needsKey) {
    const keyProvider = chosen.name as ApiKeyProvider;
    const existing = configManager.getApiKey(keyProvider);
    const keyPrompt = existing
      ? `  ${theme.accent(`${chosen.name} API key`)} ${theme.faint("(Enter to keep existing)")}: `
      : `  ${theme.accent(`${chosen.name} API key`)} ${theme.faint("(paste key or Enter to cancel)")}: `;
    const keyInput = (await ask(keyPrompt)).trim();
    if (!keyInput && !existing) {
      console.log(`  ${theme.warn(glyphs.warn)} Cancelled setup: API key is required.\n`);
      return false;
    }
    if (keyInput) {
      configManager.setApiKey(keyProvider, keyInput);
    }
  }

  const defaultModel = chosen.models[0];
  console.log(`\n  ${theme.faint("Suggested models:")} ${chosen.models.map((m) => theme.info(m)).join(", ")}`);
  const chosenModel = (await ask(`  ${theme.accent(`Model [${defaultModel}]:`)} `)).trim() || defaultModel;

  configManager.set("provider", chosen.name);
  configManager.set("model", chosenModel);
  agent.setProvider(createProvider(chosen.name, chosenModel));

  console.log(`\n  ${theme.ok(glyphs.dot)} Active model set to ${theme.info(`${chosen.name}/${chosenModel}`)}\n`);
  return true;
}
