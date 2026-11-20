import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containsKnownToken, isLikelyRealSecret, shannonEntropy } from "../vendor/wide-engine/index.js";
import type { Finding } from "./scanner.js";

export { isLikelyRealSecret, shannonEntropy };

const execFileAsync = promisify(execFile);

const HISTORY_SECRET_ASSIGN_RE = /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["'`]([A-Za-z0-9_+/=-]{16,})["'`]/i;

function maskSecretPreview(rawLine: string): string {
  return rawLine
    .replace(/(["'`])([A-Za-z0-9_+/=-]{8})[A-Za-z0-9_+/=-]{4,}(["'`])/g, "$1$2***$3")
    .trim()
    .slice(0, 160);
}

export async function scanGitHistorySecrets(workspaceDir: string, maxCommits = 30): Promise<Finding[]> {
  let stdout = "";
  try {
    const res = await execFileAsync(
      "git",
      ["log", `-n`, `${Math.max(1, Math.min(maxCommits, 100))}`, "-p", "--no-color", "--unified=0"],
      { cwd: workspaceDir, maxBuffer: 8 * 1024 * 1024, timeout: 15000 }
    );
    stdout = res.stdout || "";
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  let currentCommit = "";
  let currentFile = "";
  let newLineNo = 1;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("commit ")) {
      currentCommit = line.slice(7, 15).trim();
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch) {
      newLineNo = parseInt(hunkMatch[1], 10) || 1;
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    const codeLine = line.slice(1);
    const hasInlineToken = containsKnownToken(codeLine);
    const hasAssignToken = HISTORY_SECRET_ASSIGN_RE.test(codeLine);
    if ((hasInlineToken || hasAssignToken) && isLikelyRealSecret(codeLine, currentFile)) {
      const key = `${currentCommit}:${currentFile}:${newLineNo}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({
          id: `wide/git-history-secret`,
          ruleId: `wide/git-history-secret`,
          cwe: "CWE-798",
          category: "SECRETS",
          severity: "CRITICAL",
          file: `${currentFile || "git-history"}@${currentCommit}`,
          line: newLineNo,
          snippet: maskSecretPreview(codeLine),
          message: `Credential leaked in git commit history (${currentCommit}) in ${currentFile}.`,
          remediation: "Revoke and rotate the exposed credential immediately, and purge it from git history.",
          source: "git-history"
        });
      }
    }
    newLineNo++;
  }

  return findings;
}
