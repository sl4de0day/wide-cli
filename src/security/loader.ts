import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { SECURITY_RULES, DEFAULT_AGENT_RULES, SecurityRule } from "./rules.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".wide", "rules");
const DEFAULT_CACHE_FILE = join(DEFAULT_CACHE_DIR, "rules.json");
const REMOTE_RULES_URL = "https://raw.githubusercontent.com/sl4de0day/wide-rules/main/dist/rules.json";

export class RuleLoader {
  public static getCachePath(): string {
    return DEFAULT_CACHE_FILE;
  }

  public static getAgentRulesPath(workspaceDir = process.cwd()): { active: string; workspace: string | null; cache: string } {
    const wsAgentPath = resolve(workspaceDir, ".wide", "agent-rules.json");
    if (existsSync(wsAgentPath)) {
      return { active: wsAgentPath, workspace: wsAgentPath, cache: DEFAULT_CACHE_FILE };
    }
    const wsRulesPath = resolve(workspaceDir, ".wide", "rules.json");
    if (existsSync(wsRulesPath)) {
      return { active: wsRulesPath, workspace: wsRulesPath, cache: DEFAULT_CACHE_FILE };
    }
    if (existsSync(DEFAULT_CACHE_FILE)) {
      return { active: DEFAULT_CACHE_FILE, workspace: null, cache: DEFAULT_CACHE_FILE };
    }
    return { active: "embedded", workspace: null, cache: DEFAULT_CACHE_FILE };
  }

  public static loadRules(customPath?: string, workspaceDir = process.cwd()): SecurityRule[] {
    if (customPath) {
      const resolvedCustom = resolve(workspaceDir, customPath);
      if (existsSync(resolvedCustom)) {
        const customRules = this.parseRulesFile(resolvedCustom);
        if (customRules.length > 0) return customRules;
      }
    }

    const workspaceRulesPath = resolve(workspaceDir, ".wide", "rules.json");
    if (existsSync(workspaceRulesPath)) {
      const wsRules = this.parseRulesFile(workspaceRulesPath);
      if (wsRules.length > 0) return wsRules;
    }

    if (existsSync(DEFAULT_CACHE_FILE)) {
      const cached = this.parseRulesFile(DEFAULT_CACHE_FILE);
      if (cached.length > 0) return cached;
    }

    return [...SECURITY_RULES];
  }

  public static loadAgentRules(customPath?: string, workspaceDir = process.cwd()): SecurityRule[] {
    if (customPath) {
      const resolvedCustom = resolve(workspaceDir, customPath);
      if (existsSync(resolvedCustom)) {
        const customRules = this.parseRulesFile(resolvedCustom);
        const filtered = customRules.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
        if (filtered.length > 0) return filtered;
        if (customRules.length > 0) return customRules;
      }
    }

    const workspaceAgentRulesPath = resolve(workspaceDir, ".wide", "agent-rules.json");
    if (existsSync(workspaceAgentRulesPath)) {
      const wsAgentRules = this.parseRulesFile(workspaceAgentRulesPath);
      if (wsAgentRules.length > 0) return wsAgentRules;
    }

    const workspaceRulesPath = resolve(workspaceDir, ".wide", "rules.json");
    if (existsSync(workspaceRulesPath)) {
      const wsRules = this.parseRulesFile(workspaceRulesPath);
      const filtered = wsRules.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return filtered;
    }

    if (existsSync(DEFAULT_CACHE_FILE)) {
      const cached = this.parseRulesFile(DEFAULT_CACHE_FILE);
      const filtered = cached.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return filtered;
    }

    return [...DEFAULT_AGENT_RULES];
  }

  public static async updateRules(): Promise<{ count: number; path: string }> {
    mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });
    const response = await fetch(REMOTE_RULES_URL);
    if (!response.ok) {
      throw new Error(`Failed to download rules (${response.status}): ${response.statusText}`);
    }
    const data = await response.json() as any;
    const rulesList = Array.isArray(data) ? data : (data?.rules || []);
    writeFileSync(DEFAULT_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
    return { count: rulesList.length, path: DEFAULT_CACHE_FILE };
  }

  private static parseRulesFile(filePath: string): SecurityRule[] {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : (parsed?.rules || []);
      const result: SecurityRule[] = [];

      for (const item of list) {
        if (!item.id || !item.pattern) continue;
        try {
          const rule: SecurityRule = {
            id: item.id,
            cwe: item.cwe || "N/A",
            category: item.category || "General Security",
            severity: item.severity || "MEDIUM",
            languages: item.languages || ["all"],
            pattern: new RegExp(item.pattern, "i"),
            sourcePattern: item["source-pattern"] ? new RegExp(item["source-pattern"], "i") : undefined,
            message: item.message || "",
            remediation: item.remediation || ""
          };
          result.push(rule);
        } catch {
          continue;
        }
      }
      return result;
    } catch {
      return [];
    }
  }
}
