import { execFile } from "node:child_process";
import { displayWidth, padEndAnsi, truncateAnsi } from "../ansi.js";
import { glyphs, theme } from "../theme.js";
import type { CliToolMode, PermissionProfile } from "../../tools/types.js";

export interface GitStatusInfo {
  branch: string;
  dirty: boolean;
  modifiedFiles: Set<string>;
  fetchedAt: number;
}

export interface StatusFooterRegion {
  id: string;
  startCol: number;
  endCol: number;
}

const gitCache = new Map<string, GitStatusInfo>();
const GIT_TTL_MS = 4000;

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolveGit) => {
    execFile("git", args, { cwd, timeout: 1500, windowsHide: true }, (err, stdout) => {
      if (err) resolveGit(null);
      else resolveGit(String(stdout || ""));
    });
  });
}

export async function refreshGitStatus(cwd: string): Promise<GitStatusInfo> {
  const [branchOut, statusOut] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["status", "--porcelain"]),
  ]);
  const branch = (branchOut || "").trim();
  const modifiedFiles = new Set<string>();
  let dirty = false;
  if (statusOut) {
    for (const raw of statusOut.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      dirty = true;
      const pathPart = raw.slice(3).trim().replace(/^"|"$/g, "");
      const finalPath = pathPart.includes(" -> ") ? pathPart.split(" -> ").pop()!.trim() : pathPart;
      if (finalPath) modifiedFiles.add(finalPath.replace(/\\/g, "/"));
    }
  }
  const info: GitStatusInfo = { branch, dirty, modifiedFiles, fetchedAt: Date.now() };
  gitCache.set(cwd, info);
  return info;
}

export function getCachedGitStatus(cwd: string): GitStatusInfo | null {
  const cached = gitCache.get(cwd);
  if (!cached) {
    void refreshGitStatus(cwd);
    return null;
  }
  if (Date.now() - cached.fetchedAt > GIT_TTL_MS) {
    void refreshGitStatus(cwd);
  }
  return cached;
}

export interface StatusBarState {
  providerLabel: string;
  providerReady: boolean;
  toolMode: CliToolMode;
  permissionProfile: PermissionProfile;
  contextPercent: number;
  ruleCount: number;
  verbose: boolean;
  gitBranch?: string;
  gitDirty?: boolean;
  shellMode?: boolean;
  destructiveHint?: string;
}

function formatPermBadge(profile: PermissionProfile): string {
  if (profile === "plan") return theme.infoBold("PLAN");
  if (profile === "auto") return theme.highBold("AUTO");
  if (profile === "accept-edits") return theme.ok("EDITS");
  return theme.warn("ASK");
}

function formatToolMode(mode: CliToolMode): string {
  if (mode === "security") return theme.high("SEC");
  if (mode === "code") return theme.info("CODE");
  return theme.accent("FULL");
}

function formatCtx(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const label = `ctx ${clamped}%`;
  if (clamped >= 85) return theme.error(label);
  if (clamped >= 60) return theme.warn(label);
  return theme.faint(label);
}

export function renderStatusFooterWithRegions(
  state: StatusBarState,
  maxWidth: number,
): { line: string; regions: StatusFooterRegion[] } {
  const sep = theme.faint(` ${glyphs.middot} `);
  const sepW = displayWidth(sep);
  const regions: StatusFooterRegion[] = [];

  if (state.shellMode) {
    const badge = state.destructiveHint
      ? `${theme.pill("DESTRUCTIVE", "error")} ${theme.error(state.destructiveHint)}`
      : `${theme.badge("SHELL", "warn")} ${theme.muted("Direct command execution in workspace")}`;
    const right = maxWidth >= 82 ? theme.faint("Enter run · Esc cancel") : "";
    if (!right) return { line: `  ${truncateAnsi(badge, Math.max(20, maxWidth - 2))}`, regions };
    const leftW = displayWidth(badge);
    const rightW = displayWidth(right);
    const gap = Math.max(2, maxWidth - 2 - leftW - rightW);
    return { line: truncateAnsi(`  ${badge}${" ".repeat(gap)}${right}`, maxWidth), regions };
  }

  const modelPart = state.providerReady
    ? theme.info(state.providerLabel)
    : theme.warn("unconfigured (/setup)");

  const leftItems: Array<{ id?: string; text: string }> = [
    { id: "model", text: modelPart },
    { id: "perm", text: formatPermBadge(state.permissionProfile) },
  ];
  if (maxWidth >= 56) {
    leftItems.push({ id: "mode", text: formatToolMode(state.toolMode) });
  }
  if (maxWidth >= 72 && state.gitBranch) {
    leftItems.push({ text: theme.muted(`git:${state.gitBranch}${state.gitDirty ? "*" : ""}`) });
  }
  leftItems.push({ id: "ctx", text: formatCtx(state.contextPercent) });
  if (maxWidth >= 94 && state.ruleCount > 0) {
    leftItems.push({ text: theme.faint(`${state.ruleCount} rules`) });
  }
  if (state.verbose && maxWidth >= 80) {
    leftItems.push({ id: "verbose", text: theme.accent("verbose") });
  }

  let col = 2;
  for (let i = 0; i < leftItems.length; i++) {
    const it = leftItems[i];
    const w = displayWidth(it.text);
    if (it.id && col + w <= maxWidth) {
      regions.push({ id: it.id, startCol: col, endCol: col + w });
    }
    col += w;
    if (i < leftItems.length - 1) col += sepW;
  }

  const left = leftItems.map((it) => it.text).join(sep);

  const rightItems: Array<{ id?: string; text: string }> =
    maxWidth >= 118
      ? [
          { id: "perm", text: theme.faint("Shift+Tab mode") },
          { id: "mode", text: theme.faint("Ctrl+T tools") },
          { id: "slash-hint", text: theme.faint("/ cmds") },
          { id: "file-hint", text: theme.faint("@ files") },
        ]
      : maxWidth >= 98
        ? [
            { id: "perm", text: theme.faint("Shift+Tab mode") },
            { id: "slash-hint", text: theme.faint("/ cmds") },
            { id: "file-hint", text: theme.faint("@ files") },
          ]
        : [];

  if (rightItems.length === 0) {
    return { line: `  ${truncateAnsi(left, Math.max(20, maxWidth - 2))}`, regions };
  }

  const right = rightItems.map((it) => it.text).join(sep);
  const leftW = displayWidth(left);
  const rightW = displayWidth(right);
  const avail = maxWidth - 2;
  if (leftW + rightW + 2 > avail) {
    return { line: `  ${truncateAnsi(left, avail)}`, regions };
  }

  let rCol = 2 + (avail - rightW);
  for (let i = 0; i < rightItems.length; i++) {
    const it = rightItems[i];
    const w = displayWidth(it.text);
    if (it.id) {
      regions.push({ id: it.id, startCol: rCol, endCol: rCol + w });
    }
    rCol += w;
    if (i < rightItems.length - 1) rCol += sepW;
  }

  return { line: `  ${padEndAnsi(left, avail - rightW)}${right}`, regions };
}

export function renderStatusFooter(state: StatusBarState, maxWidth: number): string {
  return renderStatusFooterWithRegions(state, maxWidth).line;
}
