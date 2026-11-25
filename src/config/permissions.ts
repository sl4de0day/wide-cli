import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PermissionTier = "allow" | "ask" | "deny";
export type PermissionScope = "project" | "global";

export interface PermissionRuleset {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface ParsedPermissionRule {
  raw: string;
  action: string;
  target: string;
  isRegex: boolean;
}

export function parsePermissionRule(raw: string): ParsedPermissionRule | null {
  const trimmed = String(raw || "").trim();
  const match = /^([a-zA-Z0-9_*-]+)\((.*)\)$/.exec(trimmed);
  if (!match) return null;
  const action = match[1].toLowerCase();
  const inner = match[2].trim();
  if (inner.startsWith("regex:")) {
    return { raw: trimmed, action, target: inner.slice(6), isRegex: true };
  }
  return { raw: trimmed, action, target: inner, isRegex: false };
}

function normalizePathish(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function matchesPermissionRule(ruleStr: string, action: string, target: string): boolean {
  const parsed = parsePermissionRule(ruleStr);
  if (!parsed) return false;
  const normAction = action.toLowerCase();
  const actionMatches =
    parsed.action === "*" ||
    parsed.action === normAction ||
    (parsed.action === "write" && (normAction === "write_file" || normAction === "edit_file")) ||
    (parsed.action === "shell" && (normAction === "command" || normAction === "run_command")) ||
    (parsed.action === "command" && normAction === "run_command");

  if (!actionMatches) return false;
  if (!parsed.target || parsed.target === "*") return true;

  if (parsed.isRegex) {
    try {
      const re = new RegExp(parsed.target, "i");
      return re.test(target);
    } catch {
      return false;
    }
  }

  if (normAction === "command" || normAction === "run_command") {
    const cleanCmd = target.trim().toLowerCase();
    const cleanPat = parsed.target.trim().toLowerCase();
    return cleanCmd === cleanPat || cleanCmd.startsWith(`${cleanPat} `) || cleanCmd.startsWith(`${cleanPat}\t`);
  }

  const normTarget = normalizePathish(target).toLowerCase();
  const normPat = normalizePathish(parsed.target).toLowerCase();
  if (normPat.endsWith("/")) {
    return normTarget.startsWith(normPat) || `${normTarget}/` === normPat;
  }
  if (normPat.includes("*")) {
    const escaped = normPat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(normTarget);
  }
  return normTarget === normPat || normTarget.startsWith(`${normPat}/`);
}

function emptyRuleset(): PermissionRuleset {
  return { allow: [], ask: [], deny: [] };
}

function sanitizeRuleset(raw: unknown): PermissionRuleset {
  if (!raw || typeof raw !== "object") return emptyRuleset();
  const rec = raw as Record<string, unknown>;
  const asList = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map((x) => String(x || "").trim()).filter(Boolean))] : [];
  return {
    allow: asList(rec.allow),
    ask: asList(rec.ask),
    deny: asList(rec.deny),
  };
}

export class PermissionStore {
  private workspaceDir: string;
  private globalPath: string;

  constructor(workspaceDir: string, globalPath?: string) {
    this.workspaceDir = workspaceDir;
    this.globalPath = globalPath ?? join(homedir(), ".wide", "permissions.json");
  }

  public setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir;
  }

  public getProjectPath(): string {
    return join(this.workspaceDir, ".wide", "settings.json");
  }

  public getGlobalPath(): string {
    return this.globalPath;
  }

  public loadScope(scope: PermissionScope): PermissionRuleset {
    const file = scope === "project" ? this.getProjectPath() : this.getGlobalPath();
    if (!existsSync(file)) return emptyRuleset();
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const block = scope === "project" ? parsed.permissions ?? parsed : parsed.permissions ?? parsed;
      return sanitizeRuleset(block);
    } catch {
      return emptyRuleset();
    }
  }

  public saveScope(scope: PermissionScope, rules: PermissionRuleset): void {
    const file = scope === "project" ? this.getProjectPath() : this.getGlobalPath();
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let existing: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    const payload =
      scope === "project"
        ? { ...existing, permissions: sanitizeRuleset(rules) }
        : sanitizeRuleset(rules);
    writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  }

  public loadMerged(): PermissionRuleset {
    const g = this.loadScope("global");
    const p = this.loadScope("project");
    return {
      allow: [...new Set([...g.allow, ...p.allow])],
      ask: [...new Set([...g.ask, ...p.ask])],
      deny: [...new Set([...g.deny, ...p.deny])],
    };
  }

  public addRule(tier: PermissionTier, rule: string, scope: PermissionScope = "project"): boolean {
    const clean = rule.trim();
    if (!parsePermissionRule(clean)) return false;
    const current = this.loadScope(scope);
    if (!current[tier].includes(clean)) {
      current[tier].push(clean);
      this.saveScope(scope, current);
    }
    return true;
  }

  public removeRule(tier: PermissionTier, rule: string, scope: PermissionScope = "project"): boolean {
    const current = this.loadScope(scope);
    const next = current[tier].filter((r) => r !== rule);
    if (next.length === current[tier].length) return false;
    current[tier] = next;
    this.saveScope(scope, current);
    return true;
  }

  public evaluate(action: string, target: string): PermissionTier | null {
    const merged = this.loadMerged();
    for (const rule of merged.deny) {
      if (matchesPermissionRule(rule, action, target)) return "deny";
    }
    for (const rule of merged.ask) {
      if (matchesPermissionRule(rule, action, target)) return "ask";
    }
    for (const rule of merged.allow) {
      if (matchesPermissionRule(rule, action, target)) return "allow";
    }
    return null;
  }
}
