import { configManager } from "../config/index.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
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

  throw new Error(`Unsupported provider: '${providerType}'. Supported: 'gemini', 'ollama'.`);
}

export * from "./types.js";
