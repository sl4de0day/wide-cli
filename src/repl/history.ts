import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_HISTORY_ENTRIES = 500;

function getHistoryPath(): string {
  return join(homedir(), ".wide", "cli-history");
}

function sanitizeHistoryLine(line: string): string {
  const trimmed = line.trim();
  if (/^\/key\s+\S+\s+\S+/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    return `${parts[0]} ${parts[1]} [REDACTED]`;
  }
  return trimmed;
}

export function loadCliHistory(): string[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-MAX_HISTORY_ENTRIES)
      .reverse();
  } catch {
    return [];
  }
}

export function appendCliHistory(line: string): void {
  const sanitized = sanitizeHistoryLine(line);
  if (!sanitized || sanitized === "exit" || sanitized === "quit" || sanitized === "/exit") {
    return;
  }
  const path = getHistoryPath();
  const dir = join(homedir(), ".wide");
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const existing = existsSync(path)
      ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
      : [];
    if (existing[existing.length - 1] === sanitized) {
      return;
    }
    existing.push(sanitized);
    const trimmed = existing.slice(-MAX_HISTORY_ENTRIES);
    writeFileSync(path, trimmed.join("\n") + "\n", "utf8");
  } catch {
  }
}
