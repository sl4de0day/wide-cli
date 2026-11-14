import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import fg from "fast-glob";

const MAX_FILE_BYTES = 40 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024;

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
  try {
    const entries = fg.sync("**/*", {
      cwd,
      onlyFiles: true,
      dot: false,
      deep: 3,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/target/**"],
    });
    const normalized = entries.map((e) => e.replace(/\\/g, "/"));
    if (!prefix) return normalized.slice(0, 40);
    const lower = prefix.toLowerCase();
    return normalized.filter((e) => e.toLowerCase().includes(lower)).slice(0, 30);
  } catch {
    return [];
  }
}
