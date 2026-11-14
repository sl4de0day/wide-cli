import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../providers/types.js";

export interface SavedSession {
  id: string;
  updatedAt: string;
  workingDirectory: string;
  provider: string;
  model: string;
  title: string;
  messages: ChatMessage[];
}

const MAX_SAVED_SESSIONS = 30;

function getSessionsDir(): string {
  return join(homedir(), ".wide", "sessions");
}

function ensureSessionsDir(): string {
  const dir = getSessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function extractTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "(Empty session)";
  const singleLine = firstUser.content.replace(/\s+/g, " ").trim();
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

function pruneOldSessions(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const full = join(dir, name);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of entries.slice(MAX_SAVED_SESSIONS)) {
      try {
        unlinkSync(stale.full);
      } catch {
      }
    }
  } catch {
  }
}

export function createSessionId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export function saveSession(
  id: string,
  payload: {
    workingDirectory: string;
    provider: string;
    model: string;
    messages: ChatMessage[];
  }
): void {
  const nonSystem = payload.messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 0) return;

  const cleanId = sanitizeSessionId(id);
  if (!cleanId) return;

  try {
    const dir = ensureSessionsDir();
    const record: SavedSession = {
      id: cleanId,
      updatedAt: new Date().toISOString(),
      workingDirectory: payload.workingDirectory,
      provider: payload.provider,
      model: payload.model,
      title: extractTitle(nonSystem),
      messages: nonSystem,
    };
    writeFileSync(join(dir, `${cleanId}.json`), JSON.stringify(record, null, 2), "utf8");
    pruneOldSessions(dir);
  } catch {
  }
}

export function listSessions(limit = 15): SavedSession[] {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return [];

  const records: SavedSession[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as SavedSession;
      if (parsed && parsed.id && Array.isArray(parsed.messages)) {
        records.push(parsed);
      }
    } catch {
    }
  }

  return records
    .sort((a, b) => Date.parse(b.updatedAt || "0") - Date.parse(a.updatedAt || "0"))
    .slice(0, limit);
}

export function loadSession(id: string): SavedSession | null {
  const cleanId = sanitizeSessionId(id);
  if (!cleanId) return null;
  const dir = getSessionsDir();
  const exact = join(dir, `${cleanId}.json`);
  if (existsSync(exact)) {
    try {
      return JSON.parse(readFileSync(exact, "utf8")) as SavedSession;
    } catch {
      return null;
    }
  }

  const matches = listSessions(50).filter((s) => s.id.startsWith(cleanId));
  return matches.length === 1 ? matches[0] : null;
}

export function loadLatestSession(): SavedSession | null {
  const sessions = listSessions(1);
  return sessions[0] || null;
}
