import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import pc from "picocolors";
import { debugLog } from "../config/logger.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";
import { assessSqlRisk, isQueryReadOnly } from "./risk.js";

export type DbKind = "sqlite" | "postgres" | "mysql" | "redis";
export type DbEnvironment = "local" | "staging" | "prod";

export interface DbConnectionMeta {
  id: string;
  name: string;
  kind: DbKind;
  environment: DbEnvironment;
  readOnly: boolean;
  host?: string;
  port?: number;
  database?: string;
  filePath?: string;
  username?: string;
  sslMode?: "disable" | "require" | "verify-full" | "default";
  rejectUnauthorized?: boolean;
  createdAt: string;
}

interface DbStoreFile {
  activeId?: string;
  connections: DbConnectionMeta[];
}

export interface DbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  changes?: number;
  elapsedMs: number;
  truncated?: boolean;
}

export interface DbSchemaTable {
  name: string;
  type: "table" | "view";
  rowCount?: number;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    defaultValue?: string | null;
  }>;
  foreignKeys: Array<{
    column: string;
    refTable: string;
    refColumn: string;
  }>;
}

export interface DbSchemaResult {
  kind: DbKind;
  target: string;
  tables: DbSchemaTable[];
  redis?: {
    version?: string;
    usedMemory?: string;
    dbSize: number;
    sampleKeys: Array<{ key: string; type: string; ttl: number }>;
  };
}

export interface DbAuditFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
  category: string;
  target: string;
  message: string;
  recommendation: string;
}

const SECRET_COLUMN_RE = /(password|passwd|pwd|pass_hash|password_hash|secret|token|refresh_token|access_token|api_key|private_key|salt|ssn|credit_card|card_number|cvv)/i;
const PII_COLUMN_RE = /(email|e_mail|phone|mobile|ssn|social_security|tax_id|passport|birth_date|dob|address|street|ip_address|credit_card|card_number|iban)/i;
const SQLITE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".db3"]);
const DISCOVERY_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "coverage", "__pycache__"]);

function getWideDir(): string {
  const dir = join(homedir(), ".wide");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getOrCreateDbKey(): Buffer {
  const wideDir = getWideDir();
  const keyPath = join(wideDir, ".db.key");
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8").trim();
    const buf = Buffer.from(raw, "hex");
    if (buf.length === 32) return buf;
    const secretsPath = join(wideDir, "db-secrets.enc");
    if (existsSync(secretsPath)) {
      const backupPath = join(wideDir, `.db.key.corrupt.${Date.now()}`);
      try { copyFileSync(keyPath, backupPath); } catch {}
      debugLog("db", `Backed up corrupt .db.key to ${backupPath}`);
    }
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return key;
}

function encryptSecretsMap(data: Record<string, string>): string {
  const key = getOrCreateDbKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

function decryptSecretsMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.tag || !parsed.data) return {};
    const key = getOrCreateDbKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const obj = JSON.parse(plain);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function loadStore(): DbStoreFile {
  const file = join(getWideDir(), "db-connections.json");
  if (!existsSync(file)) return { connections: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : undefined,
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
    };
  } catch {
    return { connections: [] };
  }
}

function saveStore(store: DbStoreFile): void {
  const file = join(getWideDir(), "db-connections.json");
  writeFileSync(file, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
}

function loadSecrets(): Record<string, string> {
  const file = join(getWideDir(), "db-secrets.enc");
  if (!existsSync(file)) return {};
  return decryptSecretsMap(readFileSync(file, "utf8"));
}

function saveSecret(id: string, secret?: string): void {
  const file = join(getWideDir(), "db-secrets.enc");
  const current = loadSecrets();
  if (secret === undefined) {
    delete current[id];
  } else {
    current[id] = secret;
  }
  writeFileSync(file, encryptSecretsMap(current), { encoding: "utf8", mode: 0o600 });
}

export interface DbQueryHistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  durationMs: number;
  rowCount: number;
  error?: string;
  ranAt: number;
}

export function loadDbHistory(): DbQueryHistoryEntry[] {
  const file = join(getWideDir(), "recent-queries.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function clearDbHistory(connectionId?: string): void {
  const file = join(getWideDir(), "recent-queries.json");
  if (!connectionId) {
    writeFileSync(file, "[]", { encoding: "utf8", mode: 0o600 });
    return;
  }
  const filtered = loadDbHistory().filter((item) => item && item.connectionId !== connectionId);
  writeFileSync(file, JSON.stringify(filtered.slice(0, 50), null, 2), { encoding: "utf8", mode: 0o600 });
}

function recordDbHistoryEntry(entry: Omit<DbQueryHistoryEntry, "id" | "ranAt">): void {
  try {
    const cleanSql = maskDsn(String(entry.sql || "")).trim().slice(0, 8000);
    if (!cleanSql) return;
    const item: DbQueryHistoryEntry = {
      id: `${Date.now()}_${randomBytes(3).toString("hex")}`,
      connectionId: entry.connectionId,
      sql: cleanSql,
      durationMs: entry.durationMs,
      rowCount: entry.rowCount,
      ...(entry.error ? { error: maskDsn(entry.error).slice(0, 500) } : {}),
      ranAt: Date.now(),
    };
    const next = [item, ...loadDbHistory().slice(0, 49)];
    const file = join(getWideDir(), "recent-queries.json");
    writeFileSync(file, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {}
}

export function maskDsn(text: string): string {
  return String(text || "").replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]+):([^@\s/]+)@/g, "$1:****@");
}

function formatMaskedConnectionTarget(conn: DbConnectionMeta): string {
  if (conn.kind === "sqlite") return conn.filePath || "(sqlite)";
  const userPart = conn.username ? `${conn.username}@` : "";
  const host = conn.host || "localhost";
  const port = conn.port ? `:${conn.port}` : "";
  const db = conn.database ? `/${conn.database}` : "";
  const scheme = conn.kind === "postgres" ? "postgresql" : conn.kind;
  return `${scheme}://${userPart}${host}${port}${db}`;
}

function slugifyId(raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `db-${Date.now().toString(36)}`;
}

export function parseConnectionTarget(
  target: string,
  workingDirectory: string,
  opts: { name?: string; environment?: DbEnvironment; readOnly?: boolean } = {}
): { meta: DbConnectionMeta; secret?: string } {
  const trimmed = target.trim();
  const env: DbEnvironment = opts.environment || "local";
  const readOnly = Boolean(opts.readOnly);

  if (trimmed.startsWith("sqlite://") || trimmed.startsWith("file:") || !trimmed.includes("://")) {
    let filePath = trimmed;
    if (filePath.startsWith("sqlite://")) filePath = filePath.slice("sqlite://".length);
    if (filePath.startsWith("file:")) filePath = filePath.slice("file:".length);
    const resolved = filePath === ":memory:" ? ":memory:" : resolve(workingDirectory, filePath);
    const name = opts.name || (resolved === ":memory:" ? "memory-sqlite" : basename(resolved));
    return {
      meta: {
        id: slugifyId(name),
        name,
        kind: "sqlite",
        environment: env,
        readOnly,
        filePath: resolved,
        createdAt: new Date().toISOString(),
      },
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid connection URI or SQLite path: ${maskDsn(trimmed)}`);
  }

  const proto = url.protocol.replace(/:$/, "").toLowerCase();
  let kind: DbKind;
  if (proto === "postgres" || proto === "postgresql") kind = "postgres";
  else if (proto === "mysql" || proto === "mysql2") kind = "mysql";
  else if (proto === "redis" || proto === "rediss") kind = "redis";
  else throw new Error(`Unsupported database scheme '${proto}'. Use sqlite, postgres, mysql, or redis.`);

  const host = url.hostname || "localhost";
  const defaultPort = kind === "postgres" ? 5432 : kind === "mysql" ? 3306 : 6379;
  const port = url.port ? Number(url.port) : defaultPort;
  const database = url.pathname ? url.pathname.replace(/^\/+/, "") : (kind === "redis" ? "0" : "");
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const secret = url.password ? decodeURIComponent(url.password) : undefined;
  const sslParam = (url.searchParams.get("sslmode") || url.searchParams.get("ssl") || "").toLowerCase();

  let sslMode: DbConnectionMeta["sslMode"] = "default";
  let rejectUnauthorized: boolean | undefined;
  if (proto === "rediss" || sslParam === "require" || sslParam === "true" || sslParam === "1") {
    sslMode = "require";
    rejectUnauthorized = false;
  } else if (sslParam === "verify-full" || sslParam === "verify-ca") {
    sslMode = "verify-full";
    rejectUnauthorized = true;
  } else if (sslParam === "disable" || sslParam === "false" || sslParam === "0") {
    sslMode = "disable";
    rejectUnauthorized = false;
  }

  const name = opts.name || `${kind}-${host}-${database || port}`;
  return {
    meta: {
      id: slugifyId(name),
      name,
      kind,
      environment: env,
      readOnly,
      host,
      port,
      database,
      username,
      sslMode,
      rejectUnauthorized,
      createdAt: new Date().toISOString(),
    },
    secret,
  };
}

function isLocalHost(host?: string): boolean {
  const h = (host || "").trim().toLowerCase();
  return !h || h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function buildPgSsl(meta: DbConnectionMeta): any {
  if (meta.sslMode === "disable") return false;
  if (meta.sslMode === "verify-full") return { rejectUnauthorized: true };
  if (meta.sslMode === "require") return { rejectUnauthorized: meta.rejectUnauthorized ?? false };
  return undefined;
}

function buildMysqlSsl(meta: DbConnectionMeta): any {
  if (meta.sslMode === "disable" || meta.sslMode === "default") return undefined;
  return { rejectUnauthorized: meta.sslMode === "verify-full" ? true : (meta.rejectUnauthorized ?? false) };
}

async function openSqlite(filePath: string, readOnly: boolean): Promise<any> {
  if (readOnly && filePath !== ":memory:" && !existsSync(filePath)) {
    throw new Error(`SQLite database not found: ${filePath}`);
  }
  let sqliteMod: any;
  try {
    sqliteMod = await import("node:sqlite" as string);
  } catch (err: any) {
    throw new Error(`Built-in node:sqlite unavailable (requires Node >= 22.5): ${err?.message || String(err)}`);
  }
  const DatabaseSync = sqliteMod.DatabaseSync;
  if (typeof DatabaseSync !== "function") {
    throw new Error("node:sqlite DatabaseSync export missing.");
  }
  return new DatabaseSync(filePath, { readOnly: Boolean(readOnly) });
}

function normalizeRows(rawRows: any[]): { columns: string[]; rows: Record<string, unknown>[] } {
  const colSet = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const r of rawRows) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        colSet.add(k);
        copy[k] = typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? `<Buffer ${v.length}B>` : v;
      }
      rows.push(copy);
    }
  }
  return { columns: [...colSet], rows };
}

function redactRowsForAi(columns: string[], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const secretCols = new Set(columns.filter((c) => SECRET_COLUMN_RE.test(c)));
  if (secretCols.size === 0) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      out[col] = secretCols.has(col) && row[col] !== null && row[col] !== undefined ? "[REDACTED]" : row[col];
    }
    return out;
  });
}

async function withDbDriver<T>(
  meta: DbConnectionMeta,
  secret: string | undefined,
  fn: (handle: { kind: DbKind; db: any }) => Promise<T>
): Promise<T> {
  if (meta.kind === "sqlite") {
    const db = await openSqlite(meta.filePath || ":memory:", meta.readOnly);
    try {
      return await fn({ kind: "sqlite", db });
    } finally {
      try { db.close(); } catch {}
    }
  }

  if (meta.kind === "postgres") {
    const pgMod: any = await import("pg");
    const Client = pgMod.Client || pgMod.default?.Client;
    const client = new Client({
      host: meta.host || "localhost",
      port: meta.port || 5432,
      database: meta.database || "postgres",
      user: meta.username,
      password: secret,
      ssl: buildPgSsl(meta),
      connectionTimeoutMillis: 8000,
      query_timeout: 20000,
    });
    client.on?.("error", (err: Error) => debugLog("db:pg", err.message));
    try {
      await client.connect();
      return await fn({ kind: "postgres", db: client });
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (meta.kind === "mysql") {
    const mysqlMod: any = await import("mysql2/promise");
    const createConnection = mysqlMod.createConnection || mysqlMod.default?.createConnection;
    const conn = await createConnection({
      host: meta.host || "localhost",
      port: meta.port || 3306,
      database: meta.database || undefined,
      user: meta.username,
      password: secret,
      ssl: buildMysqlSsl(meta),
      connectTimeout: 8000,
    });
    try {
      return await fn({ kind: "mysql", db: conn });
    } finally {
      await conn.end().catch(() => {});
    }
  }

  const redisMod: any = await import("ioredis");
  const RedisCtor = redisMod.default || redisMod.Redis || redisMod;
  const redis = new RedisCtor({
    host: meta.host || "localhost",
    port: meta.port || 6379,
    username: meta.username || undefined,
    password: secret || undefined,
    db: meta.database ? Number(meta.database) || 0 : 0,
    tls: meta.sslMode === "require" || meta.sslMode === "verify-full"
      ? { rejectUnauthorized: meta.sslMode === "verify-full" }
      : undefined,
    connectTimeout: 8000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.on?.("error", (err: Error) => debugLog("db:redis", err.message));
  try {
    await redis.connect();
    return await fn({ kind: "redis", db: redis });
  } finally {
    await redis.quit().catch(() => {
      try { redis.disconnect(); } catch {}
    });
  }
}

export async function testDatabaseConnection(meta: DbConnectionMeta, secret?: string): Promise<string> {
  return withDbDriver(meta, secret, async ({ kind, db }) => {
    if (kind === "sqlite") {
      const row = db.prepare("SELECT sqlite_version() AS version").get();
      return `SQLite ${row?.version || "connected"}`;
    }
    if (kind === "postgres") {
      const res = await db.query("SELECT version() AS version");
      return String(res.rows?.[0]?.version || "PostgreSQL connected").split(",")[0];
    }
    if (kind === "mysql") {
      const [rows] = await db.query("SELECT VERSION() AS version");
      const first = Array.isArray(rows) ? rows[0] : null;
      return `MySQL ${first?.version || "connected"}`;
    }
    const pong = await db.ping();
    return `Redis (${pong})`;
  });
}

function quoteSqliteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export async function inspectDatabaseSchema(meta: DbConnectionMeta, secret?: string): Promise<DbSchemaResult> {
  return withDbDriver(meta, secret, async ({ kind, db }) => {
    const target = formatMaskedConnectionTarget(meta);
    if (kind === "redis") {
      const infoText = String(await db.info("server").catch(() => ""));
      const memText = String(await db.info("memory").catch(() => ""));
      const version = infoText.match(/redis_version:([^\r\n]+)/)?.[1]?.trim();
      const usedMemory = memText.match(/used_memory_human:([^\r\n]+)/)?.[1]?.trim();
      const dbSize = Number(await db.dbsize().catch(() => 0));
      const scanRes = await db.scan("0", "COUNT", "50").catch(() => ["0", []]);
      const keys = Array.isArray(scanRes?.[1]) ? scanRes[1] : [];
      const sampleKeys: Array<{ key: string; type: string; ttl: number }> = [];
      for (const k of keys.slice(0, 30)) {
        const [type, ttl] = await Promise.all([
          db.type(k).catch(() => "unknown"),
          db.ttl(k).catch(() => -1),
        ]);
        sampleKeys.push({ key: String(k), type: String(type), ttl: Number(ttl) });
      }
      return {
        kind,
        target,
        tables: [],
        redis: { version, usedMemory, dbSize, sampleKeys },
      };
    }

    const tables: DbSchemaTable[] = [];

    if (kind === "sqlite") {
      const entries = db.prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as Array<{ name: string; type: string }>;

      for (const entry of entries) {
        const qName = quoteSqliteIdent(entry.name);
        const colsRaw = db.prepare(`PRAGMA table_info(${qName})`).all() as any[];
        const fksRaw = db.prepare(`PRAGMA foreign_key_list(${qName})`).all() as any[];
        let rowCount: number | undefined;
        try {
          const c = db.prepare(`SELECT COUNT(*) AS cnt FROM ${qName}`).get() as any;
          rowCount = Number(c?.cnt ?? 0);
        } catch {}

        tables.push({
          name: entry.name,
          type: entry.type === "view" ? "view" : "table",
          rowCount,
          columns: colsRaw.map((c) => ({
            name: String(c.name),
            type: String(c.type || "ANY"),
            nullable: c.notnull === 0 && c.pk === 0,
            primaryKey: Number(c.pk) > 0,
            defaultValue: c.dflt_value !== undefined && c.dflt_value !== null ? String(c.dflt_value) : null,
          })),
          foreignKeys: fksRaw.map((fk) => ({
            column: String(fk.from),
            refTable: String(fk.table),
            refColumn: String(fk.to),
          })),
        });
      }
      return { kind, target, tables };
    }

    if (kind === "postgres") {
      const tRes = await db.query(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`
      );
      const cRes = await db.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public'
         ORDER BY table_name, ordinal_position`
      );
      const pkRes = await db.query(
        `SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'`
      );
      const fkRes = await db.query(
        `SELECT kcu.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'`
      );

      const pkSet = new Set<string>(pkRes.rows.map((r: any) => `${r.table_name}.${r.column_name}`));
      for (const t of tRes.rows) {
        tables.push({
          name: String(t.table_name),
          type: String(t.table_type).toUpperCase().includes("VIEW") ? "view" : "table",
          columns: cRes.rows
            .filter((c: any) => c.table_name === t.table_name)
            .map((c: any) => ({
              name: String(c.column_name),
              type: String(c.data_type),
              nullable: c.is_nullable === "YES",
              primaryKey: pkSet.has(`${t.table_name}.${c.column_name}`),
              defaultValue: c.column_default !== null ? String(c.column_default) : null,
            })),
          foreignKeys: fkRes.rows
            .filter((f: any) => f.table_name === t.table_name)
            .map((f: any) => ({
              column: String(f.column_name),
              refTable: String(f.ref_table),
              refColumn: String(f.ref_column),
            })),
        });
      }
      return { kind, target, tables };
    }

    const dbName = meta.database;
    const [tRows] = await db.query(
      "SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) ORDER BY TABLE_NAME",
      [dbName || null]
    );
    const [cRows] = await db.query(
      "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_KEY AS column_key, COLUMN_DEFAULT AS column_default FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) ORDER BY TABLE_NAME, ORDINAL_POSITION",
      [dbName || null]
    );
    const [fkRows] = await db.query(
      "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND REFERENCED_TABLE_NAME IS NOT NULL",
      [dbName || null]
    );

    for (const t of tRows as any[]) {
      tables.push({
        name: String(t.table_name),
        type: String(t.table_type).toUpperCase().includes("VIEW") ? "view" : "table",
        columns: (cRows as any[])
          .filter((c) => c.table_name === t.table_name)
          .map((c) => ({
            name: String(c.column_name),
            type: String(c.data_type),
            nullable: c.is_nullable === "YES",
            primaryKey: c.column_key === "PRI",
            defaultValue: c.column_default !== null ? String(c.column_default) : null,
          })),
        foreignKeys: (fkRows as any[])
          .filter((f) => f.table_name === t.table_name)
          .map((f) => ({
            column: String(f.column_name),
            refTable: String(f.ref_table),
            refColumn: String(f.ref_column),
          })),
      });
    }
    return { kind, target, tables };
  });
}

export function splitShellLikeArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote && input[i - 1] !== "\\") {
        quote = null;
      } else if (ch === "\\" && (input[i + 1] === quote || input[i + 1] === "\\")) {
        i++;
        cur += input[i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

export async function executeDatabaseQuery(
  meta: DbConnectionMeta,
  secret: string | undefined,
  query: string,
  maxRows = 500
): Promise<DbQueryResult> {
  if (meta.readOnly && !isQueryReadOnly(query, meta.kind)) {
    throw new Error(`Connection '${meta.name}' is configured as read-only; write/DDL queries are blocked.`);
  }

  const start = Date.now();
  try {
    const result = await withDbDriver(meta, secret, async ({ kind, db }) => {
      if (kind === "redis") {
        const parts = splitShellLikeArgs(query);
        const cmd = parts[0]?.toLowerCase();
        if (!cmd) throw new Error("Empty Redis command.");
        const raw = await db.call(cmd, ...parts.slice(1));
        const rows = Array.isArray(raw)
          ? raw.slice(0, maxRows).map((val, index) => ({ index, value: typeof val === "object" ? JSON.stringify(val) : String(val ?? "") }))
          : [{ result: typeof raw === "object" && raw !== null ? JSON.stringify(raw) : String(raw ?? "OK") }];
        return {
          columns: Object.keys(rows[0] || { result: "" }),
          rows,
          rowCount: rows.length,
          elapsedMs: Date.now() - start,
          truncated: Array.isArray(raw) && raw.length > maxRows,
        };
      }

      if (kind === "sqlite") {
        const trimmed = query.trim();
        const singleStmt = trimmed.replace(/;+$/, "").trim();
        if (isQueryReadOnly(singleStmt, "sqlite") && !singleStmt.includes(";")) {
          const stmt = db.prepare(singleStmt);
          const rawRows = stmt.all();
          const truncated = rawRows.length > maxRows;
          const sliced = truncated ? rawRows.slice(0, maxRows) : rawRows;
          const { columns, rows } = normalizeRows(sliced);
          return { columns, rows, rowCount: rows.length, elapsedMs: Date.now() - start, truncated };
        }
        db.exec(trimmed);
        let changes = 0;
        try {
          const ch = db.prepare("SELECT changes() AS changes").get() as any;
          changes = Number(ch?.changes ?? 0);
        } catch {}
        return { columns: [], rows: [], rowCount: 0, changes, elapsedMs: Date.now() - start };
      }

      if (kind === "postgres") {
        const res = await db.query(query);
        const rawRows = Array.isArray(res.rows) ? res.rows : [];
        const truncated = rawRows.length > maxRows;
        const sliced = truncated ? rawRows.slice(0, maxRows) : rawRows;
        const { columns, rows } = normalizeRows(sliced);
        return {
          columns: columns.length ? columns : (res.fields || []).map((f: any) => String(f.name)),
          rows,
          rowCount: rows.length,
          changes: typeof res.rowCount === "number" && rows.length === 0 ? res.rowCount : undefined,
          elapsedMs: Date.now() - start,
          truncated,
        };
      }

      const [res] = await db.query(query);
      if (Array.isArray(res)) {
        const truncated = res.length > maxRows;
        const sliced = truncated ? res.slice(0, maxRows) : res;
        const { columns, rows } = normalizeRows(sliced);
        return { columns, rows, rowCount: rows.length, elapsedMs: Date.now() - start, truncated };
      }
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        changes: Number((res as any)?.affectedRows ?? 0),
        elapsedMs: Date.now() - start,
      };
    });
    recordDbHistoryEntry({
      connectionId: meta.id,
      sql: query,
      durationMs: result.elapsedMs,
      rowCount: result.columns.length > 0 ? result.rowCount : Number(result.changes ?? 0),
    });
    return result;
  } catch (err: any) {
    recordDbHistoryEntry({
      connectionId: meta.id,
      sql: query,
      durationMs: Date.now() - start,
      rowCount: 0,
      error: err?.message || String(err),
    });
    throw err;
  }
}

function classifyPasswordSample(val: unknown): "weak_plain_or_short" | "weak_md5" | "weak_sha1" | "strong" | "skip" {
  if (typeof val !== "string" || !val.trim()) return "skip";
  const s = val.trim();
  if (/^\$2[aby]\$/.test(s) || /^\$argon2(id|i|d)\$/.test(s) || /^\$scrypt\$/.test(s) || /^pbkdf2[:$]/.test(s)) {
    return "strong";
  }
  if (/^[a-f0-9]{32}$/i.test(s)) return "weak_md5";
  if (/^[a-f0-9]{40}$/i.test(s)) return "weak_sha1";
  return "weak_plain_or_short";
}

export async function auditDatabaseSecurity(meta: DbConnectionMeta, secret?: string): Promise<DbAuditFinding[]> {
  const findings: DbAuditFinding[] = [];

  if (meta.environment === "prod" && !meta.readOnly) {
    findings.push({
      severity: "HIGH",
      category: "access-control",
      target: meta.name,
      message: "Production connection is configured with write access (readOnly=false).",
      recommendation: "Reconnect or mark production profiles with --readonly unless mutations are explicitly required.",
    });
  }

  if (meta.kind !== "sqlite") {
    if (meta.sslMode === "disable") {
      findings.push({
        severity: isLocalHost(meta.host) ? "MEDIUM" : "CRITICAL",
        category: "transport-security",
        target: `${meta.host}:${meta.port}`,
        message: "TLS is explicitly disabled (sslmode=disable); credentials and query data travel in cleartext.",
        recommendation: "Enable TLS with verify-full (sslmode=verify-full or rediss://).",
      });
    } else if (!isLocalHost(meta.host) && meta.sslMode === "default") {
      findings.push({
        severity: "HIGH",
        category: "transport-security",
        target: `${meta.host}:${meta.port}`,
        message: "Remote database connection does not enforce TLS certificate verification.",
        recommendation: "Configure sslmode=verify-full or rediss:// with strict certificate verification.",
      });
    } else if (meta.rejectUnauthorized === false) {
      findings.push({
        severity: "MEDIUM",
        category: "transport-security",
        target: `${meta.host}:${meta.port}`,
        message: "TLS certificate verification is relaxed (rejectUnauthorized=false), allowing MITM spoofing.",
        recommendation: "Use sslmode=verify-full with trusted CA certificates.",
      });
    }
  } else if (meta.filePath && meta.filePath !== ":memory:" && existsSync(meta.filePath)) {
    try {
      const fd = openSync(meta.filePath, "r");
      const header = Buffer.alloc(16);
      readSync(fd, header, 0, 16, 0);
      closeSync(fd);
      if (header.toString("ascii", 0, 15) === "SQLite format 3") {
        findings.push({
          severity: "INFO",
          category: "storage-encryption",
          target: meta.filePath,
          message: "SQLite file is unencrypted on disk (standard SQLite format 3 header).",
          recommendation: "Do not commit database files containing PII/credentials; use SQLCipher or disk encryption in production.",
        });
      }
      if (process.platform !== "win32") {
        const mode = statSync(meta.filePath).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          findings.push({
            severity: "MEDIUM",
            category: "file-permissions",
            target: meta.filePath,
            message: `SQLite file permissions (${mode.toString(8)}) allow group/world access.`,
            recommendation: `Restrict file permissions to owner-only (chmod 600 ${meta.filePath}).`,
          });
        }
      }
    } catch {}
  }

  const schema = await inspectDatabaseSchema(meta, secret);
  if (schema.kind === "redis" && schema.redis) {
    if (schema.redis.sampleKeys.some((k) => /(session|token|secret|password|auth)/i.test(k.key) && k.ttl === -1)) {
      findings.push({
        severity: "MEDIUM",
        category: "key-hygiene",
        target: meta.name,
        message: "Sensitive auth/session keys detected without TTL expiration (TTL = -1).",
        recommendation: "Set bounded TTL expirations on session, token, and auth cache keys.",
      });
    }
    return findings;
  }

  const piiTables: string[] = [];
  const authColumns: Array<{ table: string; column: string }> = [];

  for (const table of schema.tables) {
    const piiCols = table.columns.filter((c) => PII_COLUMN_RE.test(c.name)).map((c) => c.name);
    if (piiCols.length > 0) {
      piiTables.push(`${table.name} (${piiCols.join(", ")})`);
    }
    for (const col of table.columns) {
      if (/(password|passwd|pass_hash|password_hash)/i.test(col.name)) {
        authColumns.push({ table: table.name, column: col.name });
      }
    }
  }

  if (piiTables.length > 0) {
    findings.push({
      severity: "INFO",
      category: "pii-discovery",
      target: meta.name,
      message: `PII-bearing columns found in ${piiTables.length} table(s): ${piiTables.slice(0, 6).join("; ")}`,
      recommendation: "Apply least-privilege access, encryption at rest, and retention/anonymization policies.",
    });
  }

  if (authColumns.length > 0 && (meta.kind === "sqlite" || meta.kind === "postgres" || meta.kind === "mysql")) {
    await withDbDriver(meta, secret, async ({ kind, db }) => {
      for (const { table, column } of authColumns.slice(0, 8)) {
        try {
          const qt = kind === "mysql" ? `\`${table.replace(/`/g, "``")}\`` : quoteSqliteIdent(table);
          const qc = kind === "mysql" ? `\`${column.replace(/`/g, "``")}\`` : quoteSqliteIdent(column);
          const sql = `SELECT ${qc} AS val FROM ${qt} WHERE ${qc} IS NOT NULL LIMIT 20`;
          let vals: unknown[] = [];
          if (kind === "sqlite") {
            vals = db.prepare(sql).all().map((r: any) => r?.val);
          } else if (kind === "postgres") {
            vals = (await db.query(sql)).rows.map((r: any) => r?.val);
          } else if (kind === "mysql") {
            const [rows] = await db.query(sql);
            vals = (Array.isArray(rows) ? rows : []).map((r: any) => r?.val);
          }
          const counts = { weak_plain_or_short: 0, weak_md5: 0, weak_sha1: 0, strong: 0 };
          for (const v of vals) {
            const cls = classifyPasswordSample(v);
            if (cls !== "skip") counts[cls]++;
          }
          if (counts.weak_plain_or_short > 0 || counts.weak_md5 > 0 || counts.weak_sha1 > 0) {
            const details: string[] = [];
            if (counts.weak_plain_or_short) details.push(`${counts.weak_plain_or_short} plaintext/unrecognized`);
            if (counts.weak_md5) details.push(`${counts.weak_md5} MD5-like`);
            if (counts.weak_sha1) details.push(`${counts.weak_sha1} SHA1-like`);
            findings.push({
              severity: "CRITICAL",
              category: "weak-credential-storage",
              target: `${table}.${column}`,
              message: `Weak or unhashed credential values sampled in '${table}.${column}' (${details.join(", ")}).`,
              recommendation: "Migrate password storage to Argon2id, scrypt, or bcrypt.",
            });
          }
        } catch {}
      }
    });
  }

  return findings;
}

export function discoverWorkspaceDatabases(workingDirectory: string): Array<{ kind: string; path: string }> {
  const results: Array<{ kind: string; path: string }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || results.length >= 40) return;
    let entries: any[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".env")) continue;
      const fullPath = join(dir, entry.name);
      const rel = relative(workingDirectory, fullPath);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        const ext = extname(lower);
        if (SQLITE_EXTENSIONS.has(ext)) {
          results.push({ kind: "sqlite", path: rel });
        } else if (lower === "schema.prisma") {
          results.push({ kind: "prisma", path: rel });
        } else if (lower.startsWith("drizzle.config.")) {
          results.push({ kind: "drizzle", path: rel });
        } else if (lower === "docker-compose.yml" || lower === "docker-compose.yaml" || lower === "compose.yml" || lower === "compose.yaml") {
          results.push({ kind: "compose", path: rel });
        }
      }
    }
  };
  walk(workingDirectory, 0);
  return results;
}

function resolveTargetConnection(
  refOrEmpty: string | undefined,
  workingDirectory: string
): { meta: DbConnectionMeta; secret?: string } {
  const store = loadStore();
  const secrets = loadSecrets();

  if (!refOrEmpty) {
    if (!store.activeId) {
      throw new Error("No active database connection. Run '/db connect <sqlite-path-or-uri>' or provide a connection id/path.");
    }
    const found = store.connections.find((c) => c.id === store.activeId);
    if (!found) throw new Error(`Active connection '${store.activeId}' no longer exists.`);
    return { meta: found, secret: secrets[found.id] };
  }

  const bySaved = store.connections.find(
    (c) => c.id.toLowerCase() === refOrEmpty.toLowerCase() || c.name.toLowerCase() === refOrEmpty.toLowerCase()
  );
  if (bySaved) {
    return { meta: bySaved, secret: secrets[bySaved.id] };
  }

  const maybePath = resolve(workingDirectory, refOrEmpty);
  if (existsSync(maybePath) || refOrEmpty === ":memory:" || refOrEmpty.startsWith("sqlite://")) {
    return parseConnectionTarget(refOrEmpty, workingDirectory, { readOnly: true });
  }

  if (refOrEmpty.includes("://")) {
    return parseConnectionTarget(refOrEmpty, workingDirectory, { readOnly: true });
  }

  throw new Error(`Database connection or file not found: '${refOrEmpty}'.`);
}

function formatAsciiTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (columns.length === 0) return "(no columns)";
  const maxColWidth = 38;
  const stringifyCell = (val: unknown): string => {
    if (val === null || val === undefined) return "NULL";
    const s = typeof val === "object" ? JSON.stringify(val) : String(val);
    return s.length > maxColWidth ? s.slice(0, maxColWidth - 3) + "..." : s.replace(/[\r\n]+/g, " ");
  };

  const widths = columns.map((col) => {
    let w = col.length;
    for (const r of rows) {
      w = Math.max(w, stringifyCell(r[col]).length);
    }
    return Math.min(maxColWidth, w);
  });

  const sep = "+-" + widths.map((w) => "-".repeat(w)).join("-+-") + "-+";
  const header = "| " + columns.map((c, i) => pc.bold(c.padEnd(widths[i]))).join(" | ") + " |";
  const body = rows.map(
    (r) => "| " + columns.map((c, i) => stringifyCell(r[c]).padEnd(widths[i])).join(" | ") + " |"
  );
  return [sep, header, sep, ...body, sep].join("\n");
}

function formatSchemaText(schema: DbSchemaResult): string {
  const lines: string[] = [`Database Schema (${schema.kind}) - ${schema.target}`];
  if (schema.kind === "redis" && schema.redis) {
    lines.push(`Redis ${schema.redis.version || ""} | Keys: ${schema.redis.dbSize} | Memory: ${schema.redis.usedMemory || "n/a"}`);
    for (const k of schema.redis.sampleKeys) {
      lines.push(`  ${k.key} [${k.type}] (ttl: ${k.ttl})`);
    }
    return lines.join("\n");
  }
  if (schema.tables.length === 0) {
    lines.push("  (no tables or views found)");
    return lines.join("\n");
  }
  for (const t of schema.tables) {
    const countStr = t.rowCount !== undefined ? ` (${t.rowCount} rows)` : "";
    lines.push(`\n[${t.type.toUpperCase()}] ${t.name}${countStr}`);
    for (const c of t.columns) {
      const flags = [c.primaryKey ? "PK" : "", c.nullable ? "NULL" : "NOT NULL"].filter(Boolean).join(", ");
      lines.push(`  - ${c.name}: ${c.type}${flags ? ` [${flags}]` : ""}`);
    }
    for (const fk of t.foreignKeys) {
      lines.push(`  -> FK ${fk.column} REFERENCES ${fk.refTable}(${fk.refColumn})`);
    }
  }
  return lines.join("\n");
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  const raw = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function escapeSqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  const raw = typeof val === "object" ? JSON.stringify(val) : String(val);
  return `'${raw.replace(/'/g, "''")}'`;
}

function quoteExportIdent(ident: string, kind: DbKind = "sqlite"): string {
  return kind === "mysql" ? `\`${ident.replace(/`/g, "``")}\`` : quoteSqliteIdent(ident);
}

export function exportDbData(
  format: "csv" | "json" | "sql",
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
  kind: DbKind = "sqlite"
): string {
  if (format === "json") {
    return JSON.stringify(rows, null, 2);
  }
  const cols = columns.length > 0 ? columns : (rows[0] ? Object.keys(rows[0]) : []);
  if (format === "csv") {
    const header = cols.map((c) => escapeCsvCell(c)).join(",");
    const body = rows.map((row) => cols.map((c) => escapeCsvCell(row[c])).join(","));
    return [header, ...body].join("\n");
  }
  if (cols.length === 0 || rows.length === 0) return "";
  const qTable = quoteExportIdent(tableName || "query_result", kind);
  const qCols = cols.map((c) => quoteExportIdent(c, kind)).join(", ");
  return rows
    .map((row) => `INSERT INTO ${qTable} (${qCols}) VALUES (${cols.map((c) => escapeSqlLiteral(row[c])).join(", ")});`)
    .join("\n");
}

export function formatSchemaMermaidEr(schema: DbSchemaResult): string {
  if (schema.kind === "redis") {
    return `erDiagram\n  REDIS_STORE {\n    string database "${schema.target}"\n  }`;
  }
  const lines: string[] = ["erDiagram"];
  const fkColsByTable = new Map<string, Set<string>>();
  for (const table of schema.tables) {
    const fromIdent = table.name.replace(/[^a-zA-Z0-9_]/g, "_") || "table";
    for (const fk of table.foreignKeys) {
      if (!fkColsByTable.has(table.name)) fkColsByTable.set(table.name, new Set());
      fkColsByTable.get(table.name)!.add(fk.column);
      const toIdent = fk.refTable.replace(/[^a-zA-Z0-9_]/g, "_") || "table";
      lines.push(`  ${fromIdent} }o--|| ${toIdent} : "${fk.column} -> ${fk.refColumn}"`);
    }
  }
  for (const table of schema.tables) {
    const tIdent = table.name.replace(/[^a-zA-Z0-9_]/g, "_") || "table";
    lines.push(`  ${tIdent} {`);
    for (const col of table.columns) {
      const cType = (col.type || "TEXT").replace(/[^a-zA-Z0-9_]/g, "_");
      const cName = col.name.replace(/[^a-zA-Z0-9_]/g, "_");
      const badges = [col.primaryKey ? "PK" : "", fkColsByTable.get(table.name)?.has(col.name) ? "FK" : ""].filter(Boolean).join(",");
      lines.push(`    ${cType} ${cName}${badges ? ` ${badges}` : ""}`);
    }
    lines.push("  }");
  }
  return lines.join("\n");
}

export async function handleDbCommand(
  trimmedLine: string,
  ctx: { workingDirectory: string; ask: (prompt: string) => Promise<string> }
): Promise<void> {
  const args = splitShellLikeArgs(trimmedLine);
  const sub = (args[1] || "help").toLowerCase();

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(`\n${pc.bold("Database Commands:")}`);
    console.log(`  ${pc.cyan("/db list")}                                    List saved connections & workspace DB files`);
    console.log(`  ${pc.cyan("/db connect <uri|path> [--name n] [--env local|staging|prod] [--readonly]")}`);
    console.log(`  ${pc.cyan("/db use <id|name>")}                           Set active database connection`);
    console.log(`  ${pc.cyan("/db remove <id|name>")}                        Remove saved database connection`);
    console.log(`  ${pc.cyan("/db schema [id|path]")}                        Inspect tables, columns & foreign keys`);
    console.log(`  ${pc.cyan("/db erd [id|path]")}                           Print Mermaid ER diagram from schema`);
    console.log(`  ${pc.cyan('/db query [id|path] "<sql>"')}                 Run SQL / Redis query (risk-gated)`);
    console.log(`  ${pc.cyan('/db export [id|path] <csv|json|sql> "<sql>" [--out file]')}`);
    console.log(`  ${pc.cyan("/db history [clear]")}                         Inspect or clear query history`);
    console.log(`  ${pc.cyan("/db audit [id|path]")}                         Audit PII, weak hashes & TLS hygiene\n`);
    return;
  }

  if (sub === "list" || sub === "ls") {
    const store = loadStore();
    console.log(`\n${pc.bold("Saved Database Connections:")}`);
    if (store.connections.length === 0) {
      console.log(pc.dim("  (none saved yet; use /db connect <sqlite-path-or-uri>)"));
    } else {
      for (const c of store.connections) {
        const active = c.id === store.activeId ? pc.green(" *active*") : "";
        const ro = c.readOnly ? pc.yellow(" [read-only]") : "";
        console.log(`  ${pc.cyan(c.id)} (${c.kind}/${c.environment})${ro}${active} -> ${pc.dim(formatMaskedConnectionTarget(c))}`);
      }
    }
    const discovered = discoverWorkspaceDatabases(ctx.workingDirectory);
    if (discovered.length > 0) {
      console.log(`\n${pc.bold("Workspace Discovered Targets:")}`);
      for (const item of discovered) {
        console.log(`  ${pc.cyan(item.kind.padEnd(8))} ${item.path}`);
      }
    }
    console.log("");
    return;
  }

  if (sub === "connect") {
    const rest = args.slice(2);
    let target = "";
    let name: string | undefined;
    let environment: DbEnvironment = "local";
    let readOnly = false;

    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--name" && rest[i + 1]) { name = rest[++i]; }
      else if (tok === "--env" && rest[i + 1]) {
        const val = rest[++i].toLowerCase();
        if (val === "local" || val === "staging" || val === "prod") environment = val;
      } else if (tok === "--readonly" || tok === "--ro") {
        readOnly = true;
      } else if (!target) {
        target = tok;
      }
    }

    if (!target) {
      console.log(`Usage: ${pc.cyan("/db connect <uri|sqlite-path> [--name alias] [--env local|staging|prod] [--readonly]")}\n`);
      return;
    }

    try {
      const { meta, secret } = parseConnectionTarget(target, ctx.workingDirectory, { name, environment, readOnly });
      const info = await testDatabaseConnection(meta, secret);
      const store = loadStore();
      store.connections = store.connections.filter((c) => c.id !== meta.id);
      store.connections.push(meta);
      store.activeId = meta.id;
      saveStore(store);
      saveSecret(meta.id, secret);
      console.log(`${pc.green("[OK]")} Connected & saved '${pc.cyan(meta.id)}' (${info}) [env=${meta.environment}${meta.readOnly ? ", read-only" : ""}]\n`);
    } catch (err: any) {
      console.log(`${pc.red("Error:")} ${maskDsn(err?.message || String(err))}\n`);
    }
    return;
  }

  if (sub === "use") {
    const ref = args[2];
    if (!ref) {
      console.log(`Usage: ${pc.cyan("/db use <id|name>")}\n`);
      return;
    }
    const store = loadStore();
    const match = store.connections.find((c) => c.id === ref || c.name === ref);
    if (!match) {
      console.log(`${pc.red("Error:")} Saved connection '${ref}' not found.\n`);
      return;
    }
    store.activeId = match.id;
    saveStore(store);
    console.log(`${pc.green("[OK]")} Active database switched to ${pc.cyan(match.id)}\n`);
    return;
  }

  if (sub === "remove" || sub === "disconnect" || sub === "rm") {
    const ref = args[2];
    const store = loadStore();
    const targetId = ref || store.activeId;
    if (!targetId) {
      console.log(`Usage: ${pc.cyan("/db remove <id|name>")}\n`);
      return;
    }
    const target = store.connections.find((c) => c.id === targetId || c.name === targetId);
    if (!target) {
      console.log(`${pc.red("Error:")} Saved connection '${targetId}' not found.\n`);
      return;
    }
    store.connections = store.connections.filter((c) => c.id !== target.id);
    if (store.activeId === target.id) {
      store.activeId = store.connections[0]?.id;
    }
    saveStore(store);
    saveSecret(target.id, undefined);
    console.log(`${pc.green("[OK]")} Removed database connection '${target.name}' (${target.id}).\n`);
    return;
  }

  if (sub === "schema") {
    try {
      const { meta, secret } = resolveTargetConnection(args[2], ctx.workingDirectory);
      const schema = await inspectDatabaseSchema(meta, secret);
      console.log(`\n${formatSchemaText(schema)}\n`);
    } catch (err: any) {
      console.log(`${pc.red("Error:")} ${maskDsn(err?.message || String(err))}\n`);
    }
    return;
  }

  if (sub === "audit") {
    try {
      const { meta, secret } = resolveTargetConnection(args[2], ctx.workingDirectory);
      const findings = await auditDatabaseSecurity(meta, secret);
      console.log(`\n${pc.bold(`Database Security Audit (${meta.name}):`)}`);
      if (findings.length === 0) {
        console.log(`  ${pc.green("[PASS]")} No database security issues detected.`);
      } else {
        for (const f of findings) {
          const badge = f.severity === "CRITICAL" ? pc.bgRed(pc.white(` ${f.severity} `))
            : f.severity === "HIGH" ? pc.red(`[${f.severity}]`)
            : f.severity === "MEDIUM" ? pc.yellow(`[${f.severity}]`)
            : pc.cyan(`[${f.severity}]`);
          console.log(`  ${badge} ${pc.bold(f.target)} (${f.category}): ${f.message}`);
          console.log(`       ${pc.dim("Fix:")} ${f.recommendation}`);
        }
      }
      console.log("");
    } catch (err: any) {
      console.log(`${pc.red("Error:")} ${maskDsn(err?.message || String(err))}\n`);
    }
    return;
  }

  if (sub === "query") {
    const rest = args.slice(2);
    if (rest.length === 0) {
      console.log(`Usage: ${pc.cyan('/db query [id|path] "<sql>"')}\n`);
      return;
    }

    let connRef: string | undefined;
    let queryParts = rest;
    const store = loadStore();
    if (rest.length >= 2) {
      const candidate = rest[0];
      const matchesSaved = store.connections.some((c) => c.id === candidate || c.name === candidate);
      const matchesFile = existsSync(resolve(ctx.workingDirectory, candidate));
      if (matchesSaved || matchesFile || candidate.includes("://")) {
        connRef = candidate;
        queryParts = rest.slice(1);
      }
    }

    const sql = queryParts.join(" ").trim();
    if (!sql) {
      console.log(`Usage: ${pc.cyan('/db query [id|path] "<sql>"')}\n`);
      return;
    }

    try {
      const { meta, secret } = resolveTargetConnection(connRef, ctx.workingDirectory);
      if (meta.readOnly && !isQueryReadOnly(sql, meta.kind)) {
        console.log(`${pc.red("[BLOCKED]")} Connection '${meta.name}' is read-only. Mutating queries are disallowed.\n`);
        return;
      }

      const risk = assessSqlRisk(sql, meta.kind);
      if (risk.destructive) {
        console.log(`\n${pc.bgRed(pc.white(" DESTRUCTIVE SQL "))} ${pc.red(risk.reason)}`);
        console.log(`  Target: ${pc.cyan(meta.name)} (${meta.environment})`);
        console.log(`  Query:  ${pc.bold(sql)}`);
        const answer = (await ctx.ask(`  ${pc.red("Execute destructive query?")} ${pc.dim("[y]es / [n]o (default n):")} `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log(pc.yellow("Cancelled destructive SQL execution.\n"));
          return;
        }
      }

      const res = await executeDatabaseQuery(meta, secret, sql, 500);
      if (res.columns.length > 0) {
        console.log(`\n${formatAsciiTable(res.columns, res.rows)}`);
        console.log(pc.dim(`${res.rowCount} row(s)${res.truncated ? " (truncated at 500)" : ""} in ${res.elapsedMs}ms\n`));
      } else {
        console.log(`${pc.green("[OK]")} Statement executed${res.changes !== undefined ? ` (${res.changes} row(s) affected)` : ""} in ${res.elapsedMs}ms\n`);
      }
    } catch (err: any) {
      console.log(`${pc.red("Error:")} ${maskDsn(err?.message || String(err))}\n`);
    }
    return;
  }

  if (sub === "history") {
    const action = (args[2] || "").toLowerCase();
    if (action === "clear") {
      clearDbHistory();
      console.log(`${pc.green("[OK]")} Cleared database query history.\n`);
      return;
    }
    const items = loadDbHistory();
    console.log(`\n${pc.bold("Recent Database Queries:")}`);
    if (items.length === 0) {
      console.log(pc.dim("  (no recent queries recorded)\n"));
      return;
    }
    for (const item of items.slice(0, 20)) {
      const status = item.error ? pc.red("ERR") : pc.green(`${item.rowCount} row(s)`);
      const ts = new Date(item.ranAt).toISOString().replace("T", " ").slice(0, 19);
      console.log(`  ${pc.dim(ts)} ${pc.cyan(item.connectionId)} ${status} ${pc.dim(`${item.durationMs}ms`)} -> ${item.sql}`);
    }
    console.log("");
    return;
  }

  if (sub === "erd" || sub === "diagram") {
    try {
      const { meta, secret } = resolveTargetConnection(args[2], ctx.workingDirectory);
      const schema = await inspectDatabaseSchema(meta, secret);
      console.log(`\n${formatSchemaMermaidEr(schema)}\n`);
    } catch (err: any) {
      console.log(`${pc.red("Error:")} ${maskDsn(err?.message || String(err))}\n`);
    }
    return;
  }

  if (sub === "export") {
    const rest = args.slice(2);
    let outPath: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--out" && rest[i + 1]) {
        outPath = rest[++i];
      } else {
        positional.push(rest[i]);
      }
    }
    const fmtIdx = positional.findIndex((tok) => {
      const low = tok.toLowerCase();
      return low === "csv" || low === "json" || low === "sql";
    });
    if (fmtIdx < 0 || !positional[fmtIdx + 1]) {
      console.log(`Usage: ${pc.cyan('/db export [id|path] <csv|json|sql> "<sql>" [--out file]')}\n`);
      return;
    }
    const connRef = fmtIdx > 0 ? positional[0] : undefined;
    const fmt = positional[fmtIdx].toLowerCase() as "csv" | "json" | "sql";
    const sql = positional.slice(fmtIdx + 1).join(" ").trim();
    try {
      const { meta, secret } = resolveTargetConnection(connRef, ctx.workingDirectory);
      if (!isQueryReadOnly(sql, meta.kind)) {
        console.log(`${pc.red("[BLOCKED]")} Export only permits read-only SELECT queries.\n`);
        return;
      }
      const res = await executeDatabaseQuery(meta, secret, sql, 5000);
      const tableMatch = sql.match(/\bFROM\s+[`"\[]?([a-zA-Z0-9_.]+)[`"\]]?/i);
      const tableName = tableMatch ? tableMatch[1].split(".").pop() || "query_result" : "query_result";
      const content = exportDbData(fmt, tableName, res.columns, res.rows, meta.kind);
      if (outPath) {
        const target = resolve(ctx.workingDirectory, outPath);
        const rel = relative(ctx.workingDirectory, target);
        if (isAbsolute(rel) || rel.startsWith("..") || rel === "") {
          console.log(`${pc.red("Error:")} Export path must stay inside workspace.\n`);
          return;
        }
        writeFileSync(target, content, "utf8");
        console.log(`${pc.green("[OK]")} Exported ${res.rowCount} row(s) (${fmt.toUpperCase()}) -> ${target}\n`);
      } else {
        console.log(`\n${content}\n`);
      }
    } catch (err: any) {
      console.log(`${pc.red("Error:")} ${maskDsn(err?.message || String(err))}\n`);
    }
    return;
  }

  console.log(`${pc.yellow("[WARN]")} Unknown /db subcommand '${sub}'. Run ${pc.cyan("/db help")} for usage.\n`);
}

export const dbListTool: Tool = {
  definition: {
    name: "db_list",
    description: "List saved database connections (credentials masked) and discover SQLite/ORM/Compose database targets in the workspace.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    const store = loadStore();
    const saved = store.connections.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      environment: c.environment,
      readOnly: c.readOnly,
      active: c.id === store.activeId,
      target: formatMaskedConnectionTarget(c),
    }));
    const discovered = discoverWorkspaceDatabases(context.workingDirectory);
    return {
      success: true,
      output: JSON.stringify({ saved, discovered }, null, 2),
    };
  },
};

export const dbInspectSchemaTool: Tool = {
  definition: {
    name: "db_inspect_schema",
    description: "Inspect database tables, columns, primary keys, and foreign keys for a saved connection ID or workspace SQLite path.",
    parameters: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Saved connection id/name or relative SQLite file path (optional if active connection exists)." },
      },
      required: [],
    },
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const { meta, secret } = resolveTargetConnection(params.connection, context.workingDirectory);
      const schema = await inspectDatabaseSchema(meta, secret);
      return { success: true, output: formatSchemaText(schema) };
    } catch (err: any) {
      return { success: false, output: "", error: maskDsn(err?.message || String(err)) };
    }
  },
};

export const dbAuditTool: Tool = {
  definition: {
    name: "db_audit",
    description: "Audit a database connection or SQLite file for PII columns, weak password hashes, TLS misconfigurations, and read-only safety.",
    parameters: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Saved connection id/name or relative SQLite file path (optional if active connection exists)." },
      },
      required: [],
    },
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const { meta, secret } = resolveTargetConnection(params.connection, context.workingDirectory);
      const findings = await auditDatabaseSecurity(meta, secret);
      return { success: true, output: JSON.stringify({ connection: meta.id, findings }, null, 2) };
    } catch (err: any) {
      return { success: false, output: "", error: maskDsn(err?.message || String(err)) };
    }
  },
};

export const dbQueryTool: Tool = {
  definition: {
    name: "db_query",
    description: "Execute a SQL query (or Redis command) against a saved connection or SQLite file. Read-only connections block writes; destructive SQL requires explicit interactive confirmation; sensitive columns are redacted in AI results.",
    parameters: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Saved connection id/name or SQLite file path (optional if an active connection is configured)." },
        query: { type: "string", description: "SQL statement or Redis command to run." },
        maxRows: { type: "number", description: "Maximum number of rows to return (default 200)." },
      },
      required: ["query"],
    },
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    const query = String(params.query || "").trim();
    if (!query) return { success: false, output: "", error: "db_query requires a non-empty query." };

    let meta: DbConnectionMeta;
    let secret: string | undefined;
    try {
      const resolved = resolveTargetConnection(params.connection, context.workingDirectory);
      meta = resolved.meta;
      secret = resolved.secret;
    } catch (err: any) {
      return { success: false, output: "", error: maskDsn(err?.message || String(err)) };
    }

    const readOnlyQuery = isQueryReadOnly(query, meta.kind);
    if (meta.readOnly && !readOnlyQuery) {
      return {
        success: false,
        output: "",
        error: `Connection '${meta.name}' is read-only. Mutating queries are blocked.`,
      };
    }

    const risk = assessSqlRisk(query, meta.kind);
    const sessionAllowed = !risk.destructive && context.sessionApprovedTools?.has("db_query");
    const needsApproval = risk.destructive
      ? true
      : readOnlyQuery
        ? context.autoApproveRead === false
        : (!context.autoApproveWrite && !sessionAllowed);

    if (needsApproval) {
      if (!context.requestApproval) {
        return {
          success: false,
          output: "",
          error: risk.destructive
            ? `Blocked destructive SQL (${risk.reason}). Interactive confirmation required.`
            : "Database mutation rejected: approval required (run interactively or enable auto-approve write).",
        };
      }
      const decision = await context.requestApproval({
        tool: "db_query",
        title: risk.destructive
          ? `Destructive SQL blocked for confirmation (${risk.reason})`
          : `Allow SQL mutation on ${meta.name} (${meta.environment})?`,
        detail: `${meta.name}: ${query}`,
        destructive: risk.destructive,
        sessionKey: risk.destructive ? undefined : "db_query",
      });
      if (decision === "deny" || (risk.destructive && decision !== "once")) {
        return { success: false, output: "", error: "SQL query declined by user." };
      }
      if (decision === "always" && !risk.destructive && !readOnlyQuery) {
        context.sessionApprovedTools?.add("db_query");
      }
    }

    try {
      const limit = Math.min(500, Math.max(1, Number(params.maxRows || 200)));
      const res = await executeDatabaseQuery(meta, secret, query, limit);
      const redactedRows = redactRowsForAi(res.columns, res.rows);
      return {
        success: true,
        output: JSON.stringify({
          connection: meta.id,
          columns: res.columns,
          rows: redactedRows,
          rowCount: res.rowCount,
          changes: res.changes,
          elapsedMs: res.elapsedMs,
        }, null, 2),
        truncated: res.truncated,
      };
    } catch (err: any) {
      return { success: false, output: "", error: maskDsn(err?.message || String(err)) };
    }
  },
};

export const dbExportTool: Tool = {
  definition: {
    name: "db_export",
    description: "Export rows from a read-only SQL query to CSV, JSON, or SQL INSERT format with secret column redaction.",
    parameters: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Saved connection id/name or SQLite file path (optional if an active connection is configured)." },
        query: { type: "string", description: "Read-only SELECT SQL query." },
        format: { type: "string", description: "Output format: csv, json, or sql.", enum: ["csv", "json", "sql"] },
        tableName: { type: "string", description: "Target table name for SQL INSERT statements (default query_result)." },
        maxRows: { type: "number", description: "Maximum number of rows to export (default 1000, max 5000)." },
      },
      required: ["query", "format"],
    },
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    const query = String(params.query || "").trim();
    const fmt = String(params.format || "csv").toLowerCase();
    if (!query || (fmt !== "csv" && fmt !== "json" && fmt !== "sql")) {
      return { success: false, output: "", error: "db_export requires query and format (csv|json|sql)." };
    }
    try {
      const { meta, secret } = resolveTargetConnection(params.connection, context.workingDirectory);
      if (!isQueryReadOnly(query, meta.kind)) {
        return { success: false, output: "", error: "db_export only permits read-only SELECT queries." };
      }
      const limit = Math.min(5000, Math.max(1, Number(params.maxRows || 1000)));
      const res = await executeDatabaseQuery(meta, secret, query, limit);
      const redactedRows = redactRowsForAi(res.columns, res.rows);
      const tableName = String(params.tableName || "query_result").trim() || "query_result";
      const content = exportDbData(fmt, tableName, res.columns, redactedRows, meta.kind);
      return {
        success: true,
        output: content,
        truncated: res.truncated,
      };
    } catch (err: any) {
      return { success: false, output: "", error: maskDsn(err?.message || String(err)) };
    }
  },
};
