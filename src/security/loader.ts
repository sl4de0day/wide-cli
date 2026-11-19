import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { hasNestedQuantifiers } from "./inspect.js";
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
const BUNDLED_WIDE_RULES = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/rules.json");
const BUNDLED_WIDE_OSV = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/osv-bundle.json");
const rulesFileCache = new Map<string, { mtimeMs: number; size: number; rules: SecurityRule[] }>();
const sanitizationRegexCache = new Map<string, RegExp>();

function getSanitizationRegex(src: string, flags: string): RegExp {
  const key = `${flags}:${src}`;
  let compiled = sanitizationRegexCache.get(key);
  if (!compiled) {
    if (sanitizationRegexCache.size >= 256) {
      const oldest = sanitizationRegexCache.keys().next().value;
      if (oldest !== undefined) sanitizationRegexCache.delete(oldest);
    }
    compiled = new RegExp(src, flags);
    sanitizationRegexCache.set(key, compiled);
  }
  return compiled;
}

function parseChecksums(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

const EMOJI_ZWJ_SEQUENCE_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u2600-\u27BF])(?:\uFE0F|\uFE0E|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u2600-\u27BF])(?:\uFE0F|\uFE0E|[\u{1F3FB}-\u{1F3FF}])?)+/gu;
const EMOJI_KEYCAP_RE = /[0-9#*]\uFE0F?\u20E3/gu;
const EMOJI_SUPP_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu;
const EMOJI_PICT_RE = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?/gu;
const EMOJI_PRES_RE = /\p{Emoji_Presentation}(?:\uFE0F|\uFE0E)?/gu;
const EMOJI_BMP_RE = /[\u231A-\u23FF\u2600-\u27BF\u2B05-\u2B55][\uFE0E\uFE0F]?|[\u2139\u2194-\u21AA\u24C2\u25AA-\u25FE\u2934-\u2935\u3030\u303D\u3297\u3299]\uFE0F|[\uFE0E\uFE0F\u20E3]/gu;
const LONE_SURROGATE_RE = new RegExp("[\\uD800-\\uDFFF]", "g");
const EMOJI_TAIL_RE = /(?:[0-9#*]\uFE0F|[\u2139\u2194-\u21AA\u24C2\u25AA-\u25FE\u2934-\u2935\u3030\u303D\u3297\u3299]|[\uD800-\uDBFF]|[\uFE0E\uFE0F\u200D])$/;

function stripAllEmojis(text: string, stripLoneSurrogates = true): string {
  let out = text
    .replace(EMOJI_ZWJ_SEQUENCE_RE, "")
    .replace(EMOJI_KEYCAP_RE, "")
    .replace(EMOJI_SUPP_RE, "")
    .replace(EMOJI_PICT_RE, "")
    .replace(EMOJI_PRES_RE, "")
    .replace(EMOJI_BMP_RE, "");
  if (stripLoneSurrogates) {
    out = out.replace(LONE_SURROGATE_RE, "");
  }
  return out;
}

function mergeDefaultAgentRules(rules: SecurityRule[]): SecurityRule[] {
  const merged = [...rules];
  const seen = new Set(merged.map((r) => r.id));
  for (const fallback of DEFAULT_AGENT_RULES) {
    if (!seen.has(fallback.id)) {
      merged.push(fallback);
      seen.add(fallback.id);
    }
  }
  merged.sort((a, b) => (a.id === "wide/ai-no-emojis" ? -1 : b.id === "wide/ai-no-emojis" ? 1 : 0));
  return merged;
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
    if (existsSync(BUNDLED_WIDE_RULES)) {
      return { active: BUNDLED_WIDE_RULES, workspace: null, cache: DEFAULT_CACHE_FILE };
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

    if (existsSync(BUNDLED_WIDE_RULES)) {
      const bundled = this.parseRulesFile(BUNDLED_WIDE_RULES);
      if (bundled.length > 0) return bundled;
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
      if (filtered.length > 0) return mergeDefaultAgentRules(filtered);
    }

    const siblingWideRules = resolve(workspaceDir, "../wide-rules/dist/rules.json");
    if (existsSync(siblingWideRules)) {
      const siblingRules = this.parseRulesFile(siblingWideRules);
      const filtered = siblingRules.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return mergeDefaultAgentRules(filtered);
    }

    if (existsSync(INSTALL_WIDE_RULES)) {
      const installRules = this.parseRulesFile(INSTALL_WIDE_RULES);
      const filtered = installRules.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return mergeDefaultAgentRules(filtered);
    }

    if (existsSync(DEFAULT_CACHE_FILE)) {
      const cached = this.parseRulesFile(DEFAULT_CACHE_FILE);
      const filtered = cached.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return mergeDefaultAgentRules(filtered);
    }

    if (existsSync(BUNDLED_WIDE_RULES)) {
      const bundled = this.parseRulesFile(BUNDLED_WIDE_RULES);
      const filtered = bundled.filter(r => r.category === "AI_SECURITY" || r.id.includes("ai-"));
      if (filtered.length > 0) return mergeDefaultAgentRules(filtered);
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

  public static sanitizeOutput(text: string, rules?: SecurityRule[], stripLoneSurrogates = true): string {
    if (!text || typeof text !== "string") return "";
    const targetRules = Array.isArray(rules) && rules.length > 0 ? rules : this.loadAgentRules();
    let result = stripAllEmojis(text, stripLoneSurrogates);
    for (const r of targetRules) {
      if ((r.id === "wide/ai-no-emojis" || r.id.includes("emoji")) && r.pattern) {
        try {
          const src = r.pattern.source;
          const flags = src.includes("\\uD800") ? "g" : "gu";
          result = result.replace(getSanitizationRegex(src, flags), "");
        } catch {}
      }
    }
    return result;
  }

  public static createStreamSanitizer(rules?: SecurityRule[]) {
    let pending = "";
    return {
      push: (chunk: string): string => {
        const combined = pending + String(chunk ?? "");
        const match = EMOJI_TAIL_RE.exec(combined);
        const tailLen = match ? match[0].length : 0;
        const safeLen = combined.length - tailLen;
        pending = tailLen > 0 ? combined.slice(safeLen) : "";
        if (safeLen <= 0) return "";
        return this.sanitizeOutput(combined.slice(0, safeLen), rules, false);
      },
      flush: (): string => {
        if (!pending) return "";
        const out = this.sanitizeOutput(pending, rules, true);
        pending = "";
        return out;
      }
    };
  }

  public static loadAdvisories(workspaceDir = process.cwd()): Record<string, any> {
    const candidates = [
      resolve(workspaceDir, ".wide", "osv.json"),
      DEFAULT_OSV_FILE,
      resolve(workspaceDir, "../wide-rules/dist/osv-bundle.json"),
      INSTALL_WIDE_OSV,
      BUNDLED_WIDE_OSV
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
      if (existsSync(DEFAULT_META_FILE) && existsSync(DEFAULT_CACHE_FILE)) {
        const meta = JSON.parse(readFileSync(DEFAULT_META_FILE, "utf8"));
        const age = Date.now() - Date.parse(meta?.syncedAt || "");
        if (Number.isFinite(age) && age >= 0 && age < ttlMs) {
          const cachedRaw = readFileSync(DEFAULT_CACHE_FILE, "utf8");
          if (cachedRaw.includes("wide/ai-no-emojis")) return false;
        }
      }
    } catch {}
    await this.updateRules();
    return true;
  }

  public static async updateRules(options: { verifySha256?: boolean; fetchImpl?: typeof fetch; cacheDir?: string } = {}): Promise<{ count: number; osvCount: number; path: string; osvPath: string | null }> {
    const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
    const cacheFile = join(cacheDir, "rules.json");
    const osvFile = join(cacheDir, "osv-bundle.json");
    const metaFile = join(cacheDir, ".sync-meta.json");
    const verifySha = options.verifySha256 !== false;
    const fetchFn = options.fetchImpl || fetch;

    mkdirSync(cacheDir, { recursive: true });
    let checksums = new Map<string, string>();
    const sumRes = await fetchFn(REMOTE_CHECKSUMS_URL, { signal: AbortSignal.timeout(15000) });
    if (!sumRes.ok) {
      if (verifySha) {
        throw new Error(`SHA-256 verification required: failed to fetch SHA256SUMS (${sumRes.status})`);
      }
    } else {
      checksums = parseChecksums(await sumRes.text());
    }

    const expectedRulesSha = checksums.get("rules.json");
    if (verifySha && !expectedRulesSha) {
      throw new Error("SHA-256 verification failed: rules.json missing from SHA256SUMS");
    }

    const response = await fetchFn(REMOTE_RULES_URL, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      throw new Error(`Failed to download rules (${response.status}): ${response.statusText}`);
    }
    const rulesRaw = await response.text();
    if (expectedRulesSha) {
      const actualSha = createHash("sha256").update(rulesRaw).digest("hex");
      if (actualSha !== expectedRulesSha) {
        throw new Error("SHA-256 mismatch while downloading rules.json");
      }
    }
    const data = JSON.parse(rulesRaw) as any;
    const rulesList = Array.isArray(data) ? data : (data?.rules || []);
    writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf8");
    rulesFileCache.delete(cacheFile);

    let osvCount = 0;
    let osvPath: string | null = null;
    const osvRes = await fetchFn(REMOTE_OSV_URL, { signal: AbortSignal.timeout(20000) });
    if (osvRes.ok) {
      const osvRaw = await osvRes.text();
      const expectedOsvSha = checksums.get("osv-bundle.json");
      if (verifySha && !expectedOsvSha) {
        throw new Error("SHA-256 verification failed: osv-bundle.json missing from SHA256SUMS");
      }
      if (expectedOsvSha) {
        const actualOsvSha = createHash("sha256").update(osvRaw).digest("hex");
        if (actualOsvSha !== expectedOsvSha) {
          throw new Error("SHA-256 mismatch while downloading osv-bundle.json");
        }
      }
      const osvData = JSON.parse(osvRaw) as any;
      writeFileSync(osvFile, JSON.stringify(osvData, null, 2), "utf8");
      osvPath = osvFile;
      osvCount = Number(osvData?.stats?.total || 0);
    }

    writeFileSync(
      metaFile,
      JSON.stringify({ syncedAt: new Date().toISOString(), rulesCount: rulesList.length, osvCount }, null, 2),
      "utf8"
    );
    return { count: rulesList.length, osvCount, path: cacheFile, osvPath };
  }

  private static parseRulesFile(filePath: string): SecurityRule[] {
    try {
      const st = statSync(filePath);
      const cached = rulesFileCache.get(filePath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.rules;
      }

      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : (parsed?.rules || []);
      const result: SecurityRule[] = [];

      for (const item of list) {
        if (!item.id || !item.pattern) continue;
        if (hasNestedQuantifiers(String(item.pattern))) continue;
        try {
          const notMatchRaw = item["not-match"] || item.notMatch;
          const safeNotMatch =
            typeof notMatchRaw === "string" && notMatchRaw && !hasNestedQuantifiers(notMatchRaw)
              ? new RegExp(notMatchRaw, "i")
              : undefined;
          const srcRaw = item["source-pattern"];
          const safeSource =
            typeof srcRaw === "string" && srcRaw && !hasNestedQuantifiers(srcRaw)
              ? new RegExp(srcRaw, "i")
              : undefined;
          const rule: SecurityRule = {
            id: item.id,
            cwe: item.cwe || "N/A",
            category: item.category || "General Security",
            severity: item.severity || "MEDIUM",
            languages: item.languages || ["all"],
            pattern: new RegExp(item.pattern, "i"),
            notMatch: safeNotMatch,
            sourcePattern: safeSource,
            message: item.message || "",
            remediation: item.remediation || "",
            instruction: item.instruction || item.message || ""
          };
          result.push(rule);
        } catch {
          continue;
        }
      }
      rulesFileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, rules: result });
      return result;
    } catch {
      return [];
    }
  }
}
