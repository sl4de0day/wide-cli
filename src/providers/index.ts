import { configManager } from "../config/index.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

export function createProvider(overrideProvider?: string, overrideModel?: string): LLMProvider {
  const cfg = configManager.get();
  const providerType = overrideProvider || cfg.provider;
  const modelName = overrideModel || cfg.model;

  if (providerType === "gemini") {
    const key = configManager.getApiKey("gemini");
    if (!key) {
      throw new Error("Gemini API key is required. Run 'wide config set-key gemini <YOUR_KEY>' or set GEMINI_API_KEY.");
    }
    return new GeminiProvider(key, modelName || "gemini-2.5-flash");
  }

  if (providerType === "ollama") {
    return new OllamaProvider(cfg.ollamaBaseUrl, modelName || "deepseek-r1:7b");
  }

  if (providerType === "claude") {
    const key = configManager.getApiKey("claude");
    if (!key) {
      throw new Error("Claude API key is required. Run 'wide config set-key claude <YOUR_KEY>' or set ANTHROPIC_API_KEY.");
    }
    return new ClaudeProvider(key, modelName || "claude-3-7-sonnet-20250219");
  }

  if (providerType === "deepseek") {
    const key = configManager.getApiKey("deepseek");
    if (!key) {
      throw new Error("DeepSeek API key is required. Run 'wide config set-key deepseek <YOUR_KEY>' or set DEEPSEEK_API_KEY.");
    }
    return new OpenAICompatibleProvider("deepseek", key, modelName || "deepseek-chat", "https://api.deepseek.com/v1");
  }

  if (providerType === "openai") {
    const key = configManager.getApiKey("openai");
    if (!key) {
      throw new Error("OpenAI API key is required. Run 'wide config set-key openai <YOUR_KEY>' or set OPENAI_API_KEY.");
    }
    return new OpenAICompatibleProvider("openai", key, modelName || "gpt-4o", "https://api.openai.com/v1");
  }

  throw new Error(`Unsupported provider: '${providerType}'. Supported: gemini, ollama, claude, deepseek, openai.`);
}

export * from "./types.js";
