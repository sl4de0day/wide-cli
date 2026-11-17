import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { SecurityScanner, type Finding } from "./security/scanner.js";

export interface HookInstallOptions {
  failOn?: string;
  force?: boolean;
  cwd?: string;
}

export interface HookUninstallOptions {
  cwd?: string;
}

export interface HookRunOptions {
  failOn?: string;
  rulesPath?: string;
  cwd?: string;
}

const SEVERITY_RANKS: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1
};

export function findGitDir(cwd = process.cwd()): string {
  try {
    const gitDirRaw = execSync("git rev-parse --git-dir", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (gitDirRaw) {
      return resolve(cwd, gitDirRaw);
    }
  } catch {}
  const fallback = resolve(cwd, ".git");
  if (existsSync(fallback)) {
    return fallback;
  }
  throw new Error(`Directory '${cwd}' is not inside a git repository.`);
}

export function installPreCommitHook(opts: HookInstallOptions = {}): {
  installed: boolean;
  hookPath: string;
  message: string;
} {
  const cwd = opts.cwd || process.cwd();
  const gitDir = findGitDir(cwd);
  const hooksDir = resolve(gitDir, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }
  const hookPath = resolve(hooksDir, "pre-commit");
  const failOn = (opts.failOn || "HIGH").toUpperCase();

  if (existsSync(hookPath) && !opts.force) {
    const existingContent = readFileSync(hookPath, "utf8");
    if (!existingContent.includes("wide hook run")) {
      return {
        installed: false,
        hookPath,
        message: "A pre-commit hook already exists. Use --force to overwrite."
      };
    }
  }

  const script = [
    "#!/usr/bin/env sh",
    "if command -v wide >/dev/null 2>&1; then",
    `  wide hook run --fail-on ${failOn}`,
    "  exit $?",
    "elif command -v npx >/dev/null 2>&1; then",
    `  npx wide hook run --fail-on ${failOn}`,
    "  exit $?",
    "fi"
  ].join("\n") + "\n";

  writeFileSync(hookPath, script, "utf8");
  try {
    chmodSync(hookPath, 0o755);
  } catch {}

  return {
    installed: true,
    hookPath,
    message: `Pre-commit hook installed to ${hookPath} with severity threshold ${failOn}.`
  };
}

export function uninstallPreCommitHook(opts: HookUninstallOptions = {}): {
  uninstalled: boolean;
  hookPath: string;
  message: string;
} {
  const cwd = opts.cwd || process.cwd();
  const gitDir = findGitDir(cwd);
  const hookPath = resolve(gitDir, "hooks", "pre-commit");

  if (!existsSync(hookPath)) {
    return {
      uninstalled: false,
      hookPath,
      message: "No pre-commit hook found."
    };
  }

  const content = readFileSync(hookPath, "utf8");
  if (!content.includes("wide hook run")) {
    return {
      uninstalled: false,
      hookPath,
      message: "Existing pre-commit hook was not created by Wide; left unchanged."
    };
  }

  unlinkSync(hookPath);
  return {
    uninstalled: true,
    hookPath,
    message: `Removed pre-commit hook from ${hookPath}.`
  };
}

export async function runPreCommitHook(opts: HookRunOptions = {}): Promise<{
  blocked: boolean;
  findings: Finding[];
  totalFilesScanned: number;
}> {
  const cwd = opts.cwd || process.cwd();
  const failOn = (opts.failOn || "HIGH").toUpperCase();
  const minRank = SEVERITY_RANKS[failOn] || 3;

  let stagedRaw = "";
  try {
    stagedRaw = execSync("git diff --cached --name-only --diff-filter=ACMR", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (err: any) {
    throw new Error(`Failed to list staged git changes: ${err.message}`);
  }

  const stagedFiles = stagedRaw
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  if (stagedFiles.length === 0) {
    console.log(pc.green("[OK] No staged files to check."));
    return { blocked: false, findings: [], totalFilesScanned: 0 };
  }

  const existingFiles = stagedFiles.filter((f) => existsSync(resolve(cwd, f)));
  if (existingFiles.length === 0) {
    console.log(pc.green("[OK] No existing staged files to check."));
    return { blocked: false, findings: [], totalFilesScanned: 0 };
  }

  const scanner = new SecurityScanner(cwd, opts.rulesPath);
  const result = await scanner.scanFiles(existingFiles, "ALL");

  const blockingFindings = result.findings.filter(
    (f) => (SEVERITY_RANKS[f.severity] || 0) >= minRank
  );

  if (blockingFindings.length > 0) {
    console.log(
      pc.bold(
        pc.red(
          `\n[WIDE HOOK] Security check failed: ${blockingFindings.length} issue(s) at or above ${failOn} severity:`
        )
      )
    );
    for (const f of blockingFindings) {
      const sevBadge =
        f.severity === "CRITICAL"
          ? pc.bgRed(pc.white(` ${f.severity} `))
          : pc.red(`[${f.severity}]`);
      console.log(`  ${sevBadge} ${pc.bold(f.file)}:${f.line} - ${f.message} (${pc.dim(f.id)})`);
      if (f.snippet) {
        console.log(`    ${pc.dim(f.snippet.trim())}`);
      }
    }
    console.log(
      pc.yellow(
        "\nCommit blocked. Address the security vulnerabilities or suppress with '// wide-ignore <rule-id>' before committing.\n"
      )
    );
    return {
      blocked: true,
      findings: blockingFindings,
      totalFilesScanned: result.totalFilesScanned
    };
  }

  console.log(
    pc.green(
      `[OK] Wide pre-commit check passed (${result.totalFilesScanned} staged file(s) scanned, 0 blocking findings).`
    )
  );
  return {
    blocked: false,
    findings: result.findings,
    totalFilesScanned: result.totalFilesScanned
  };
}
