import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WideConfig {
  provider: "gemini" | "ollama" | "claude" | "deepseek" | "openai";
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
}

const DEFAULT_CONFIG: WideConfig = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  apiKeys: {},
  ollamaBaseUrl: "http://localhost:11434",
  autoApproveRead: true,
  autoApproveWrite: false,
  autoApproveRun: false,
  maxIterations: 25,
};

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
    return { ...this.config };
  }

  public set<K extends keyof WideConfig>(key: K, value: WideConfig[K]): void {
    this.config[key] = value;
    this.save();
  }

  public setApiKey(provider: keyof WideConfig["apiKeys"], key: string): void {
    if (!this.config.apiKeys) this.config.apiKeys = {};
    this.config.apiKeys[provider] = key;
    this.save();
  }

  public getApiKey(provider: keyof WideConfig["apiKeys"]): string | undefined {
    return process.env[`WIDE_${provider.toUpperCase()}_API_KEY`] ||
           process.env[`${provider.toUpperCase()}_API_KEY`] ||
           this.config.apiKeys?.[provider];
  }

  private load(): WideConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, "utf8");
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      }
    } catch {
      // Fallback to default
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
