import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import fg from "fast-glob";

const MAX_FILE_BYTES = 40 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024;
const COMPLETION_CACHE_TTL_MS = 5000;
const COMPLETION_GLOB_OPTIONS = {
  onlyFiles: true,
  dot: false,
  deep: 3,
  suppressErrors: true,
  ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/target/**"],
};

interface CompletionCacheEntry {
  files: string[];
  fetchedAt: number;
  refreshing: boolean;
}

const completionCache = new Map<string, CompletionCacheEntry>();

function filterCompletionPaths(entries: string[], prefix: string): string[] {
  if (!prefix) return entries.slice(0, 40);
  const lower = prefix.toLowerCase();
  return entries.filter((e) => e.toLowerCase().includes(lower)).slice(0, 30);
}

export async function warmWorkspacePathsCache(cwd: string): Promise<void> {
  const key = resolve(cwd);
  const existing = completionCache.get(key);
  if (existing?.refreshing) return;
  const entry: CompletionCacheEntry = existing || { files: [], fetchedAt: 0, refreshing: false };
  entry.refreshing = true;
  completionCache.set(key, entry);
  try {
    const entries = await fg("**/*", { ...COMPLETION_GLOB_OPTIONS, cwd: key });
    entry.files = entries.map((e) => e.replace(/\\/g, "/"));
    entry.fetchedAt = Date.now();
  } catch {
  } finally {
    entry.refreshing = false;
  }
}

export interface ExpandedMentionPrompt {
  prompt: string;
  attachedFiles: string[];
}

export function expandAtFileMentions(input: string, cwd: string): ExpandedMentionPrompt {
  const mentionPattern = /(?:^|\s)@([^\s"']+|"[^"]+"|'[^']+')/g;
  const attachedFiles: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(input)) !== null) {
    const rawToken = match[1].replace(/^['"]|['"]$/g, "");
    if (!rawToken) continue;

    const fullPath = resolve(cwd, rawToken);
    if (seen.has(fullPath) || !existsSync(fullPath)) continue;

    try {
      const st = statSync(fullPath);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      if (totalBytes + st.size > MAX_TOTAL_BYTES) continue;

      const content = readFileSync(fullPath, "utf8");
      if (content.includes("\u0000")) continue;

      seen.add(fullPath);
      totalBytes += st.size;
      const rel = relative(cwd, fullPath).replace(/\\/g, "/") || rawToken;
      attachedFiles.push(rel);
      blocks.push(`<attached_file path="${rel}">\n${content}\n</attached_file>`);
    } catch {
    }
  }

  if (blocks.length === 0) {
    return { prompt: input, attachedFiles: [] };
  }

  return {
    prompt: `${input}\n\n${blocks.join("\n\n")}`,
    attachedFiles,
  };
}

export function listWorkspacePathsForCompletion(cwd: string, prefix = ""): string[] {
  const key = resolve(cwd);
  const now = Date.now();
  const cached = completionCache.get(key);
  if (cached) {
    if (now - cached.fetchedAt > COMPLETION_CACHE_TTL_MS && !cached.refreshing) {
      void warmWorkspacePathsCache(key);
    }
    return filterCompletionPaths(cached.files, prefix);
  }
  try {
    const entries = fg.sync("**/*", { ...COMPLETION_GLOB_OPTIONS, cwd: key });
    const normalized = entries.map((e) => e.replace(/\\/g, "/"));
    completionCache.set(key, { files: normalized, fetchedAt: now, refreshing: false });
    return filterCompletionPaths(normalized, prefix);
  } catch {
    return [];
  }
}
