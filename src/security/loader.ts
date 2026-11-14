import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SECURITY_RULES, DEFAULT_AGENT_RULES, SecurityRule } from "./rules.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".wide", "rules");
const DEFAULT_CACHE_FILE = join(DEFAULT_CACHE_DIR, "rules.json");
const DEFAULT_OSV_FILE = join(DEFAULT_CACHE_DIR, "osv-bundle.json");
const DEFAULT_META_FILE = join(DEFAULT_CACHE_DIR, ".sync-meta.json");
const REMOTE_RULES_URL = "https://raw.githubusercontent.com/sl4de0day/wide-rules/main/dist/rules.json";
const REMOTE_OSV_URL = "https://raw.githubusercontent.com/sl4de0day/wide-rules/main/dist/osv-bundle.json";
const REMOTE_CHECKSUMS_URL = "https://raw.githubusercontent.com/sl4de0day/wide-rules/main/dist/SHA256SUMS";
const INSTALL_WIDE_RULES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../wide-rules/dist/rules.json");
const INSTALL_WIDE_OSV = resolve(dirname(fileURLToPath(import.meta.url)), "../../../wide-rules/dist/osv-bundle.json");

function parseChecksums(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

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
    const siblingWideRules = resolve(workspaceDir, "../wide-rules/dist/rules.json");
    if (existsSync(siblingWideRules)) {
      return { active: siblingWideRules, workspace: null, cache: DEFAULT_CACHE_FILE };
    }
    if (existsSync(INSTALL_WIDE_RULES)) {
      return { active: INSTALL_WIDE_RULES, workspace: null, cache: DEFAULT_CACHE_FILE };
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

    const siblingWideRules = resolve(workspaceDir, "../wide-rules/dist/rules.json");
    if (existsSync(siblingWideRules)) {
      const siblingRules = this.parseRulesFile(siblingWideRules);
      if (siblingRules.length > 0) return siblingRules;
    }

    if (existsSync(INSTALL_WIDE_RULES)) {
      const installRules = this.parseRulesFile(INSTALL_WIDE_RULES);
      if (installRules.length > 0) return installRules;
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

    const siblingWideRules = resolve(workspaceDir, "../wide-rules/dist/rules.json");
    if (existsSync(siblingWideRules)) {
      const siblingRules = this.parseRulesFile(siblingWideRules);
      const filtered = siblingRules.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return filtered;
    }

    if (existsSync(INSTALL_WIDE_RULES)) {
      const installRules = this.parseRulesFile(INSTALL_WIDE_RULES);
      const filtered = installRules.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return filtered;
    }

    if (existsSync(DEFAULT_CACHE_FILE)) {
      const cached = this.parseRulesFile(DEFAULT_CACHE_FILE);
      const filtered = cached.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return filtered;
    }

    return [...DEFAULT_AGENT_RULES];
  }

  public static buildAgentInstructions(rules?: SecurityRule[]): string {
    const targetRules = Array.isArray(rules) && rules.length > 0 ? rules : this.loadAgentRules();
    const lines: string[] = [];
    for (const r of targetRules) {
      const text = (r.instruction || r.message || "").trim();
      if (text) {
        lines.push(`- ${text}`);
      }
    }
    return lines.join("\n");
  }

  public static sanitizeOutput(text: string, rules?: SecurityRule[]): string {
    if (!text || typeof text !== "string") return "";
    const targetRules = Array.isArray(rules) && rules.length > 0 ? rules : this.loadAgentRules();
    let result = text;
    for (const r of targetRules) {
      if (r.id === "wide/ai-no-emojis" || r.id.includes("emoji")) {
        result = result.replace(/(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF])/g, "");
        result = result.replace(/\p{Extended_Pictographic}/gu, "");
      }
    }
    return result;
  }

  public static loadAdvisories(workspaceDir = process.cwd()): Record<string, any> {
    const candidates = [
      resolve(workspaceDir, ".wide", "osv.json"),
      DEFAULT_OSV_FILE,
      resolve(workspaceDir, "../wide-rules/dist/osv-bundle.json"),
      INSTALL_WIDE_OSV
    ];
    for (const file of candidates) {
      if (existsSync(file)) {
        try {
          return JSON.parse(readFileSync(file, "utf8"));
        } catch {}
      }
    }
    return { npm: [], pip: [], maven: [], go: [] };
  }

  public static async syncIfStale(ttlMs = 24 * 60 * 60 * 1000): Promise<boolean> {
    if (process.env.WIDE_NO_AUTO_RULES_SYNC === "1") return false;
    try {
      if (existsSync(DEFAULT_META_FILE)) {
        const meta = JSON.parse(readFileSync(DEFAULT_META_FILE, "utf8"));
        const age = Date.now() - Date.parse(meta?.syncedAt || "");
        if (Number.isFinite(age) && age >= 0 && age < ttlMs) return false;
      }
    } catch {}
    await this.updateRules();
    return true;
  }

  public static async updateRules(): Promise<{ count: number; osvCount: number; path: string; osvPath: string | null }> {
    mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });
    let checksums = new Map<string, string>();
    try {
      const sumRes = await fetch(REMOTE_CHECKSUMS_URL);
      if (sumRes.ok) checksums = parseChecksums(await sumRes.text());
    } catch {}

    const response = await fetch(REMOTE_RULES_URL);
    if (!response.ok) {
      throw new Error(`Failed to download rules (${response.status}): ${response.statusText}`);
    }
    const rulesRaw = await response.text();
    const expectedRulesSha = checksums.get("rules.json");
    if (expectedRulesSha) {
      const actualSha = createHash("sha256").update(rulesRaw).digest("hex");
      if (actualSha !== expectedRulesSha) {
        throw new Error("SHA-256 mismatch while downloading rules.json");
      }
    }
    const data = JSON.parse(rulesRaw) as any;
    const rulesList = Array.isArray(data) ? data : (data?.rules || []);
    writeFileSync(DEFAULT_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");

    let osvCount = 0;
    let osvPath: string | null = null;
    try {
      const osvRes = await fetch(REMOTE_OSV_URL);
      if (osvRes.ok) {
        const osvRaw = await osvRes.text();
        const expectedOsvSha = checksums.get("osv-bundle.json");
        if (expectedOsvSha) {
          const actualOsvSha = createHash("sha256").update(osvRaw).digest("hex");
          if (actualOsvSha !== expectedOsvSha) {
            throw new Error("SHA-256 mismatch while downloading osv-bundle.json");
          }
        }
        const osvData = JSON.parse(osvRaw) as any;
        writeFileSync(DEFAULT_OSV_FILE, JSON.stringify(osvData, null, 2), "utf8");
        osvPath = DEFAULT_OSV_FILE;
        osvCount = Number(osvData?.stats?.total || 0);
      }
    } catch (err) {
      if (String((err as Error)?.message || "").includes("SHA-256 mismatch")) throw err;
    }

    writeFileSync(
      DEFAULT_META_FILE,
      JSON.stringify({ syncedAt: new Date().toISOString(), rulesCount: rulesList.length, osvCount }, null, 2),
      "utf8"
    );
    return { count: rulesList.length, osvCount, path: DEFAULT_CACHE_FILE, osvPath };
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
          const notMatchRaw = item["not-match"] || item.notMatch;
          const rule: SecurityRule = {
            id: item.id,
            cwe: item.cwe || "N/A",
            category: item.category || "General Security",
            severity: item.severity || "MEDIUM",
            languages: item.languages || ["all"],
            pattern: new RegExp(item.pattern, "i"),
            notMatch: typeof notMatchRaw === "string" && notMatchRaw ? new RegExp(notMatchRaw, "i") : undefined,
            sourcePattern: item["source-pattern"] ? new RegExp(item["source-pattern"], "i") : undefined,
            message: item.message || "",
            remediation: item.remediation || "",
            instruction: item.instruction || item.message || ""
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
