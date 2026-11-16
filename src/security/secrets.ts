import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Finding } from "./scanner.js";

const execFileAsync = promisify(execFile);

const KNOWN_SECRET_PREFIX_RE = /^(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z\-_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9\-_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const KNOWN_PREFIX_DUMMY_RE = /(?:example|dummy|placeholder|your[_-]|changeme|replace[_-]?me|xxxxxx|000000)/i;
const PLACEHOLDER_RE = /(?:example|sample|dummy|placeholder|your[_-]|changeme|replace[_-]?me|test[_-]?(?:key|token|secret)|fake|redacted|localhost|000000|123456|xxxxxx|\$\{\{?|<[A-Z0-9_]+>)/i;
const HISTORY_SECRET_ASSIGN_RE = /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["'`]([A-Za-z0-9_+/=-]{16,})["'`]/i;
const KNOWN_TOKEN_INLINE_RE = /\b(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z\-_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9\-_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function shannonEntropy(value: string): number {
  const s = String(value || "");
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function isLikelyRealSecret(lineText: string, filePath = ""): boolean {
  const line = String(lineText || "");
  if (!line.trim()) return false;
  if (/process\.env\.|os\.environ|import\.meta\.env\.|\$\{\{?\s*secrets\./i.test(line)) return false;

  const isTestFile = /(?:^|[/\\])(?:test|tests|__tests__|spec|specs|fixtures?|mocks?)(?:[/\\]|$)|\.(?:test|spec)\.[jt]sx?$/i.test(filePath);
  const literalMatch = /["'`]([^"'`\r\n]{8,})["'`]/.exec(line) || /[:=]\s*([A-Za-z0-9_+/=-]{12,})/.exec(line);
  const candidate = literalMatch ? literalMatch[1].trim() : line.trim();

  if (KNOWN_SECRET_PREFIX_RE.test(candidate) || KNOWN_SECRET_PREFIX_RE.test(line) || KNOWN_TOKEN_INLINE_RE.test(line)) {
    return !KNOWN_PREFIX_DUMMY_RE.test(candidate);
  }

  if (PLACEHOLDER_RE.test(candidate)) return false;
  if (/^(.)\1{5,}$/.test(candidate)) return false;

  const entropy = shannonEntropy(candidate);
  if (candidate.length >= 16 && entropy < 2.8) return false;
  if (isTestFile && entropy < 3.4) return false;
  return true;
}

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
    const hasInlineToken = KNOWN_TOKEN_INLINE_RE.test(codeLine);
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
