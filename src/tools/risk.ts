export interface CommandRiskAssessment {
  destructive: boolean;
  reason: string;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-z]*r[a-z]*f/i, reason: "recursive forced file deletion (rm -rf)" },
  { pattern: /\brm\s+-[a-z]*f[a-z]*r/i, reason: "recursive forced file deletion (rm -fr)" },
  { pattern: /\brmdir\s+\/s/i, reason: "recursive Windows directory removal (rmdir /s)" },
  { pattern: /\bdel\s+.*\/[sq]/i, reason: "recursive or quiet file deletion (del)" },
  { pattern: /\bRemove-Item\b.*-Recurse.*-Force/i, reason: "forced recursive PowerShell deletion" },
  { pattern: /\b(format|diskpart|mkfs|fdisk|parted)\b/i, reason: "disk partitioning or filesystem formatting" },
  { pattern: /\bdd\b\s+.*\bof=\/dev\//i, reason: "raw block device write (dd)" },
  { pattern: /\breg\s+delete\b/i, reason: "Windows registry deletion" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "system power state change" },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/i, reason: "forced remote git push" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "destructive git reset --hard" },
  { pattern: /\bgit\s+clean\b.*-[a-z]*f/i, reason: "destructive git clean" },
  { pattern: /(curl|wget)\s+[^\n|]+\|\s*(sh|bash|zsh|pwsh|powershell)/i, reason: "piping remote script directly to shell" },
];

export function assessShellRisk(command: string): CommandRiskAssessment {
  const normalized = String(command || "").trim();
  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return { destructive: true, reason: entry.reason };
    }
  }
  return { destructive: false, reason: "" };
}

function stripSqlCommentsAndLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const s = String(sql || "");
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === "-" && next === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote === "'" ? "''" : " ";
      i++;
      while (i < s.length) {
        if (s[i] === quote) {
          if (s[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (s[i] === "\\" && i + 1 < s.length) {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function splitSqlStatements(sql: string): string[] {
  return stripSqlCommentsAndLiterals(sql)
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const SQL_READONLY_PREFIXES = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const REDIS_READONLY_COMMANDS = new Set([
  "PING", "INFO", "DBSIZE", "SCAN", "TYPE", "TTL", "PTTL", "GET", "MGET",
  "HGET", "HGETALL", "HKEYS", "HLEN", "LRANGE", "LLEN", "LINDEX",
  "SMEMBERS", "SCARD", "SISMEMBER", "ZRANGE", "ZCARD", "ZSCORE", "EXISTS", "KEYS",
]);

export function isQueryReadOnly(query: string, kind = "sqlite"): boolean {
  const trimmed = String(query || "").trim();
  if (!trimmed) return true;
  if (kind === "redis") {
    const cmd = trimmed.split(/\s+/)[0]?.toUpperCase() || "";
    return REDIS_READONLY_COMMANDS.has(cmd);
  }
  const stmts = splitSqlStatements(trimmed);
  if (stmts.length === 0) return true;
  return stmts.every((stmt) => {
    if (SQL_READONLY_PREFIXES.test(stmt)) {
      return !/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(stmt);
    }
    if (/^PRAGMA\b/i.test(stmt)) {
      return !/=/.test(stmt) && !/\bwritable_schema\b/i.test(stmt);
    }
    return false;
  });
}

const DESTRUCTIVE_SQL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX|TRIGGER|FUNCTION|PROCEDURE|USER|ROLE)\b/i, reason: "destructive DROP statement" },
  { pattern: /\bTRUNCATE\b/i, reason: "destructive TRUNCATE statement" },
  { pattern: /\bALTER\s+(TABLE|DATABASE|SCHEMA|SYSTEM|USER|ROLE)\b/i, reason: "schema/system modification (ALTER)" },
  { pattern: /\b(GRANT|REVOKE)\b/i, reason: "privilege change (GRANT/REVOKE)" },
  { pattern: /\b(ATTACH|DETACH)\s+DATABASE\b/i, reason: "database attach/detach operation" },
  { pattern: /\bPRAGMA\s+writable_schema\b/i, reason: "dangerous SQLite PRAGMA writable_schema" },
];

export function assessSqlRisk(query: string, kind = "sqlite"): CommandRiskAssessment {
  const raw = String(query || "").trim();
  if (!raw) return { destructive: false, reason: "" };

  if (kind === "redis") {
    const cmd = raw.split(/\s+/)[0]?.toUpperCase() || "";
    if (cmd === "FLUSHALL" || cmd === "FLUSHDB") {
      return { destructive: true, reason: `destructive Redis command (${cmd})` };
    }
    if (cmd === "DEL" || cmd === "UNLINK" || cmd === "RENAME" || cmd === "CONFIG" || cmd === "SHUTDOWN" || cmd === "DEBUG") {
      return { destructive: true, reason: `destructive Redis command (${cmd})` };
    }
    return { destructive: false, reason: "" };
  }

  for (const stmt of splitSqlStatements(raw)) {
    for (const entry of DESTRUCTIVE_SQL_PATTERNS) {
      if (entry.pattern.test(stmt)) {
        return { destructive: true, reason: entry.reason };
      }
    }
    if (/^\s*DELETE\b/i.test(stmt)) {
      const hasWhere = /\bWHERE\b/i.test(stmt);
      const trivialWhere = /\bWHERE\s+(1\s*=\s*1|TRUE|NOT\s+FALSE)\s*$/i.test(stmt);
      if (!hasWhere || trivialWhere) {
        return { destructive: true, reason: "unconditional DELETE without selective WHERE clause" };
      }
    }
    if (/^\s*UPDATE\b/i.test(stmt)) {
      const hasWhere = /\bWHERE\b/i.test(stmt);
      const trivialWhere = /\bWHERE\s+(1\s*=\s*1|TRUE|NOT\s+FALSE)\s*$/i.test(stmt);
      if (!hasWhere || trivialWhere) {
        return { destructive: true, reason: "unconditional UPDATE without selective WHERE clause" };
      }
    }
  }
  return { destructive: false, reason: "" };
}
