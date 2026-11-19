import { configManager, type ProviderName } from "../config/index.js";
import { AntigravityProvider } from "./antigravity.js";
import { ClaudeProvider } from "./claude.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import { CodexProvider } from "./codex.js";
import { GeminiProvider } from "./gemini.js";
import { listOllamaModels, OllamaProvider } from "./ollama.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

export const PROVIDER_PRESETS: Record<ProviderName, string[]> = {
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  ollama: ["deepseek-r1:7b", "qwen2.5-coder:7b", "llama3.1:8b"],
  claude: ["claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022"],
  "claude-code": ["default", "sonnet", "opus", "haiku"],
  antigravity: [
    "default",
    "gemini-4-neon-high",
    "gemini-4-neon-xhigh",
    "gemini-4-argon-high",
    "gemini-4-hydrogen-high",
    "gemini-3.8-flash-high",
    "claude-sonnet-5-5-high",
    "claude-opus-5-5-high",
    "gpt-oss-120b-medium",
  ],
  codex: [
    "default",
    "gpt-6.2-sol",
    "gpt-6.2-sol-xhigh",
    "gpt-6.2-astra",
    "gpt-6-luna",
    "gpt-5.5",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  openai: ["gpt-4o", "gpt-4o-mini"],
};

export function createProvider(overrideProvider?: string, overrideModel?: string): LLMProvider {
  const cfg = configManager.get();
  const providerType = (overrideProvider || cfg.provider) as ProviderName;
  const modelName = overrideModel || cfg.model;

  if (providerType === "gemini") {
    const key = configManager.getApiKey("gemini");
    if (!key) {
      throw new Error("Gemini API key is required. Use /key gemini <YOUR_KEY> or run 'wide config set-key gemini <YOUR_KEY>'.");
    }
    return new GeminiProvider(key, modelName || "gemini-2.5-flash");
  }

  if (providerType === "ollama") {
    return new OllamaProvider(cfg.ollamaBaseUrl, modelName || "deepseek-r1:7b");
  }

  if (providerType === "claude") {
    const key = configManager.getApiKey("claude");
    if (!key) {
      throw new Error("Claude API key is required. Use /key claude <YOUR_KEY> or run 'wide config set-key claude <YOUR_KEY>'.");
    }
    return new ClaudeProvider(key, modelName || "claude-3-7-sonnet-20250219");
  }

  if (providerType === "claude-code") {
    return new ClaudeCodeProvider(modelName || "default");
  }

  if (providerType === "antigravity") {
    return new AntigravityProvider(modelName || "default");
  }

  if (providerType === "codex") {
    return new CodexProvider(modelName || "default");
  }

  if (providerType === "deepseek") {
    const key = configManager.getApiKey("deepseek");
    if (!key) {
      throw new Error("DeepSeek API key is required. Use /key deepseek <YOUR_KEY> or run 'wide config set-key deepseek <YOUR_KEY>'.");
    }
    return new OpenAICompatibleProvider("deepseek", key, modelName || "deepseek-chat", "https://api.deepseek.com/v1");
  }

  if (providerType === "openai") {
    const key = configManager.getApiKey("openai");
    if (!key) {
      throw new Error("OpenAI API key is required. Use /key openai <YOUR_KEY> or run 'wide config set-key openai <YOUR_KEY>'.");
    }
    return new OpenAICompatibleProvider("openai", key, modelName || "gpt-4o", "https://api.openai.com/v1");
  }

  throw new Error(`Unsupported provider: '${providerType}'. Supported: gemini, ollama, claude, claude-code, antigravity, codex, deepseek, openai.`);
}

export function createOptionalProvider(overrideProvider?: string, overrideModel?: string): LLMProvider | null {
  try {
    return createProvider(overrideProvider, overrideModel);
  } catch {
    return null;
  }
}

export function isProviderConfigured(provider?: ProviderName): boolean {
  return configManager.hasProviderCredentials(provider);
}

export { listOllamaModels };
export * from "./types.js";
