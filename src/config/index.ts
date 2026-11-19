import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProviderName = "gemini" | "ollama" | "claude" | "claude-code" | "antigravity" | "codex" | "deepseek" | "openai";

import type { CliToolMode } from "../tools/types.js";

export interface WideConfig {
  provider: ProviderName;
  model: string;
  apiKeys: {
    gemini?: string;
    claude?: string;
    deepseek?: string;
    openai?: string;
  };
  ollamaBaseUrl: string;
  autoApproveRead: boolean;
  autoApproveWrite: boolean;
  autoApproveRun: boolean;
  maxIterations: number;
  toolMode?: CliToolMode;
  allowBrowser?: boolean;
}

const DEFAULT_CONFIG: WideConfig = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  apiKeys: {},
  ollamaBaseUrl: "http://localhost:11434",
  autoApproveRead: true,
  autoApproveWrite: true,
  autoApproveRun: false,
  maxIterations: 25,
  toolMode: "full",
  allowBrowser: true,
};

export function coerceConfigValue(key: string, raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (key === "autoApproveRead" || key === "autoApproveWrite" || key === "autoApproveRun" || key === "allowBrowser") {
    if (trimmed === "true" || trimmed === "on" || trimmed === "1") return true;
    if (trimmed === "false" || trimmed === "off" || trimmed === "0") return false;
  }
  if (key === "toolMode") {
    const mode = trimmed.toLowerCase();
    if (mode === "full" || mode === "code" || mode === "security") return mode;
  }
  if (key === "maxIterations") {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return raw;
}

export class ConfigManager {
  private configDir: string;
  private configPath: string;
  private config: WideConfig;

  constructor() {
    this.configDir = join(homedir(), ".wide");
    this.configPath = join(this.configDir, "config.json");
    this.config = this.load();
  }

  public get(): WideConfig {
    return {
      ...this.config,
      apiKeys: { ...(this.config.apiKeys || {}) },
    };
  }

  public set<K extends keyof WideConfig>(key: K, value: WideConfig[K]): void {
    this.config[key] = coerceConfigValue(String(key), value) as WideConfig[K];
    this.save();
  }

  public setApiKey(provider: keyof WideConfig["apiKeys"], key: string): void {
    if (!this.config.apiKeys) this.config.apiKeys = {};
    this.config.apiKeys[provider] = key.trim();
    this.save();
  }

  public getApiKey(provider: keyof WideConfig["apiKeys"]): string | undefined {
    const envSpecific = process.env[`WIDE_${provider.toUpperCase()}_API_KEY`];
    const envStandard =
      provider === "claude"
        ? process.env.ANTHROPIC_API_KEY
        : process.env[`${provider.toUpperCase()}_API_KEY`];
    return envSpecific || envStandard || this.config.apiKeys?.[provider];
  }

  public hasProviderCredentials(provider?: ProviderName): boolean {
    const target = provider || this.config.provider;
    if (target === "ollama" || target === "claude-code" || target === "antigravity" || target === "codex") return true;
    return Boolean(this.getApiKey(target));
  }

  private load(): WideConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, "utf8");
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      }
    } catch {
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG };
  }

  private save(): void {
    try {
      if (!existsSync(this.configDir)) {
        mkdirSync(this.configDir, { recursive: true });
      }
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  }
}

export const configManager = new ConfigManager();
