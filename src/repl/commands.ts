import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Agent } from "../agent/index.js";
import { configManager, type ProviderName } from "../config/index.js";
import { PermissionStore, type PermissionTier } from "../config/permissions.js";
import {
  createOptionalProvider,
  createProvider,
  PROVIDER_PRESETS,
} from "../providers/index.js";
import { RuleLoader } from "../security/loader.js";
import { executeTool } from "../tools/index.js";
import { handleDbCommand } from "../tools/db.js";
import type { CliToolMode, PermissionProfile } from "../tools/types.js";
import { horizontalRule, padEndAnsi, termWidth } from "../ui/ansi.js";
import { formatColoredDiffPreview } from "../ui/diff.js";
import { glyphs, theme } from "../ui/theme.js";
import { askInlineText } from "../ui/tui/composer.js";
import { isMouseEnabled, setMouseEnabled } from "../ui/tui/keys.js";
import { runInteractiveSelect, type SelectOption } from "../ui/tui/select.js";
import { runTabbedPanel, type TabPane } from "../ui/tui/tabs.js";
import type { TurnCheckpointStore } from "./checkpoints.js";
import { copyToClipboard } from "./clipboard.js";
import { formatDoctorReport, runDoctorDiagnostics } from "./doctor.js";
import { initWideWorkspace } from "./init.js";
import { deleteSession, formatRelativeTime, listSessions, loadSession, saveSession } from "./sessions.js";
import { probeProviderStates, runInteractiveSetup, type PromptQuestionFn } from "./setup.js";

export interface SlashCommandMeta {
  command: string;
  usage: string;
  description: string;
  category: "Session" | "Model & Auth" | "Security" | "Workspace" | "Permissions";
}

export const SLASH_COMMANDS: SlashCommandMeta[] = [
  { command: "/help", usage: "/help", description: "Show grouped commands and keyboard shortcuts", category: "Session" },
  { command: "/status", usage: "/status", description: "Show session metrics, tokens, and active mode", category: "Session" },
  { command: "/context", usage: "/context", description: "Visualize context window breakdown and compact", category: "Session" },
  { command: "/compact", usage: "/compact", description: "Compact conversation history now", category: "Session" },
  { command: "/diff", usage: "/diff", description: "Inspect or revert files changed in this session", category: "Session" },
  { command: "/rewind", usage: "/rewind", description: "Roll back to a prior turn checkpoint", category: "Session" },
  { command: "/copy", usage: "/copy [code]", description: "Copy last assistant reply or code block to clipboard", category: "Session" },
  { command: "/sessions", usage: "/sessions", description: "Browse, resume, or delete saved chat sessions", category: "Session" },
  { command: "/resume", usage: "/resume [id]", description: "Load a saved chat session (picker if omitted)", category: "Session" },
  { command: "/save", usage: "/save", description: "Save current session snapshot immediately", category: "Session" },
  { command: "/new", usage: "/new", description: "Start a fresh conversation without clearing scrollback", category: "Session" },
  { command: "/clear", usage: "/clear", description: "Clear screen and start a fresh conversation", category: "Session" },
  { command: "/exit", usage: "/exit", description: "Exit Wide CLI cleanly", category: "Session" },

  { command: "/setup", usage: "/setup", description: "Interactive provider and model setup wizard", category: "Model & Auth" },
  { command: "/provider", usage: "/provider [name]", description: "Switch AI provider (interactive picker if omitted)", category: "Model & Auth" },
  { command: "/model", usage: "/model [provider] [model]", description: "Switch active model (searchable picker if omitted)", category: "Model & Auth" },
  { command: "/key", usage: "/key [provider] [apiKey]", description: "Store masked API key without leaving CLI", category: "Model & Auth" },
  { command: "/doctor", usage: "/doctor", description: "Run full environment, provider, and rules diagnostics", category: "Model & Auth" },
  { command: "/config", usage: "/config", description: "Show current Wide CLI configuration", category: "Model & Auth" },
  { command: "/mouse", usage: "/mouse [on|off|status]", description: "Toggle terminal mouse click and wheel interaction", category: "Session" },

  { command: "/permissions", usage: "/permissions [allow|ask|deny]", description: "Manage granular allow/ask/deny rules and profile", category: "Permissions" },
  { command: "/approve", usage: "/approve [read|write|run] [on|off]", description: "Inspect or toggle tool auto-approval policy", category: "Permissions" },
  { command: "/plan", usage: "/plan", description: "Toggle read-only Plan mode (no file/shell mutations)", category: "Permissions" },
  { command: "/mode", usage: "/mode [full|code|security]", description: "Switch assistant tool mode (picker if omitted)", category: "Permissions" },

  { command: "/scan", usage: "/scan [path]", description: "Run Wide SAST, taint flow, and OSV SCA scan", category: "Security" },
  { command: "/rules", usage: "/rules [list|sync|osv]", description: "Inspect or synchronize wide-rules and OSV bundle", category: "Security" },
  { command: "/db", usage: "/db [list|connect|schema|erd|query|export|history|audit]", description: "Manage databases, inspect schemas, and run audited queries", category: "Security" },
  { command: "/browser", usage: "/browser [on|off|status|close]", description: "Toggle browser automation tools or inspect active page", category: "Security" },

  { command: "/cd", usage: "/cd <directory>", description: "Change active workspace directory", category: "Workspace" },
  { command: "/init", usage: "/init", description: "Initialize .wide/rules, .wide/settings.json, and .wideignore", category: "Workspace" },
];

export interface CommandContext {
  agent: Agent;
  sessionId: string;
  setSessionId: (nextId: string) => void;
  sessionApprovedTools: Set<string>;
  permissionStore: PermissionStore;
  checkpoints: TurnCheckpointStore;
  ask: PromptQuestionFn;
  onRedrawHeader: () => void;
  onExit: () => Promise<void>;
}

const VALID_PROVIDERS: ProviderName[] = [
  "antigravity",
  "claude-code",
  "gemini",
  "claude",
  "ollama",
  "codex",
  "openai",
  "deepseek",
];

function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printHelp(): void {
  const cols = Math.min(termWidth(80) - 2, 96);
  console.log(`\n  ${theme.fgBold("Slash Commands:")}`);
  console.log(`  ${horizontalRule(Math.max(32, cols))}`);

  const categories: SlashCommandMeta["category"][] = [
    "Session",
    "Model & Auth",
    "Permissions",
    "Security",
    "Workspace",
  ];
  for (const cat of categories) {
    const items = SLASH_COMMANDS.filter((c) => c.category === cat);
    console.log(`\n  ${theme.accentBold(cat)}`);
    for (const item of items) {
      console.log(`    ${padEndAnsi(theme.info(item.usage), 34)} ${theme.muted(item.description)}`);
    }
  }

  console.log(`\n  ${theme.fgBold("Keyboard Shortcuts")}`);
  console.log(`  ${horizontalRule(Math.max(32, cols))}`);
  const shortcuts: Array<[string, string]> = [
    ["Shift+Tab", "Cycle permission profile (Ask -> Accept Edits -> Plan -> Auto)"],
    ["Ctrl+T", "Cycle Wide tool mode (full -> code -> security)"],
    ["Esc", "Interrupt active response or running tool call"],
    ["Esc + Esc", "Open turn rewind menu (on empty composer)"],
    ["Ctrl+O", "Toggle compact vs verbose tool output"],
    ["Ctrl+L", "Redraw terminal screen keeping conversation history"],
    ["Ctrl+R", "Reverse-search prompt history"],
    ["Ctrl+G", "Edit current draft in external $EDITOR"],
    ["Shift+Enter / Alt+Enter", "Insert newline in multi-line composer (Ctrl+J also works)"],
    ["!<command>", "Execute shell command directly with live destructive warning"],
    ["@<file>", "Fuzzy-attach workspace file contents to your prompt"],
    ["Ctrl+C (x2) / Ctrl+D", "Clear draft, or exit Wide CLI on empty composer"],
    ["Mouse Click / Wheel", "Click composer/menus/footer badges, scroll lists (Shift+drag copies text)"],
  ];
  for (const [k, desc] of shortcuts) {
    console.log(`    ${padEndAnsi(theme.accent(k), 34)} ${theme.muted(desc)}`);
  }
  console.log("");
}

function renderContextBar(percent: number, barWidth = 28): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * barWidth);
  const empty = Math.max(0, barWidth - filled);
  const fillColor = percent >= 85 ? theme.error : percent >= 60 ? theme.warn : theme.accent;
  return `${fillColor("█".repeat(filled))}${theme.border("░".repeat(empty))}`;
}

async function handleContextCommand(ctx: CommandContext): Promise<void> {
  const b = ctx.agent.getContextBreakdown();
  const cols = Math.min(termWidth(80) - 2, 88);
  console.log(`\n  ${theme.fgBold("Context Window Breakdown")}`);
  console.log(`  ${horizontalRule(Math.max(32, cols))}`);
  console.log(`  ${renderContextBar(b.fillPercent, 32)}  ${theme.fgBold(`${b.fillPercent}%`)} ${theme.muted(`(~${b.estimatedTokens.toLocaleString()} tokens, ${b.totalChars.toLocaleString()} / ${b.maxChars.toLocaleString()} chars)`)}`);
  console.log("");
  const rows: Array<[string, number]> = [
    ["System & Wide rules", b.systemChars],
    ["User prompts & @files", b.userChars],
    ["Assistant responses", b.assistantChars],
    ["Tool outputs", b.toolChars],
  ];
  for (const [label, chars] of rows) {
    const pct = b.totalChars > 0 ? Math.round((chars / b.totalChars) * 100) : 0;
    console.log(`    ${padEndAnsi(theme.fg(label), 24)} ${padEndAnsi(theme.info(`${chars.toLocaleString()} chars`), 16)} ${theme.faint(`${pct}%`)}`);
  }
  console.log(`\n  ${theme.faint(`Messages: ${b.messageCount} ${glyphs.middot} Run /compact to shrink earlier tool outputs.`)}\n`);
}

export async function handleRewindCommand(ctx: CommandContext): Promise<void> {
  const cps = ctx.checkpoints.getCheckpoints();
  if (cps.length === 0) {
    console.log(`  ${theme.faint("No turn checkpoints recorded in this session yet.")}\n`);
    return;
  }

  if (!isInteractiveTty()) {
    console.log(`\n  ${theme.fgBold("Turn Checkpoints:")}`);
    for (const cp of cps) {
      const filesNote = cp.changes.length > 0 ? ` (${cp.changes.length} file edit(s))` : "";
      console.log(`    #${cp.id} ${theme.info(cp.promptPreview)}${theme.faint(filesNote)}`);
    }
    console.log("");
    return;
  }

  const options: SelectOption<number>[] = [...cps].reverse().map((cp) => ({
    value: cp.id,
    label: `Turn #${cp.id}: ${cp.promptPreview}`,
    description: `${formatRelativeTime(cp.timestamp)}${cp.changes.length > 0 ? ` · ${cp.changes.length} file edit(s)` : ""}`,
    badge: cp.changes.length > 0 ? `${cp.changes.length} FILE${cp.changes.length > 1 ? "S" : ""}` : "CHAT",
    badgeTone: cp.changes.length > 0 ? "warn" : "muted",
  }));

  const selectedTurnId = await runInteractiveSelect({
    title: "Rewind to Checkpoint",
    subtitle: "Roll back conversation (and optionally undo file modifications) to before the chosen turn.",
    options,
  });
  if (selectedTurnId === null) return;

  const targetIdx = cps.findIndex((c) => c.id === selectedTurnId);
  const affectedFiles = new Set<string>();
  for (const t of cps.slice(targetIdx)) {
    for (const ch of t.changes) affectedFiles.add(ch.relPath);
  }

  let restoreFiles = false;
  if (affectedFiles.size > 0) {
    const mode = await runInteractiveSelect<"both" | "chat-only">({
      title: `Rewind Turn #${selectedTurnId}`,
      subtitle: `${affectedFiles.size} file(s) modified since this turn: ${[...affectedFiles].slice(0, 4).join(", ")}`,
      options: [
        { value: "both", label: "Restore files and rewind chat", description: "Undo disk modifications and truncate conversation", badge: "SAFE", badgeTone: "warn" },
        { value: "chat-only", label: "Rewind chat only", description: "Keep current files on disk as-is", badge: "KEEP FILES", badgeTone: "info" },
      ],
    });
    if (!mode) return;
    restoreFiles = mode === "both";
  }

  const res = ctx.checkpoints.rewindToTurn(selectedTurnId, restoreFiles);
  if (res.ok) {
    ctx.agent.truncateHistoryTo(res.messageCountTarget);
    const fileNote = res.restoredFiles.length > 0 ? ` and restored ${res.restoredFiles.length} file(s)` : "";
    console.log(`  ${theme.ok(glyphs.dot)} Rewound to before Turn #${selectedTurnId}${fileNote}.\n`);
  }
}

async function handleDiffCommand(ctx: CommandContext): Promise<void> {
  const changes = ctx.checkpoints.getAggregatedChanges();
  if (changes.length === 0) {
    console.log(`  ${theme.faint("No files have been modified in this session yet.")}\n`);
    return;
  }

  if (!isInteractiveTty()) {
    for (const ch of changes) {
      console.log(`\n  ${theme.fgBold(ch.relPath)} (${theme.ok(`+${ch.added}`)} ${theme.error(`-${ch.removed}`)})`);
      console.log(formatColoredDiffPreview(ch.relPath, ch.beforeContent, ch.afterContent, { maxLines: 60 }).preview);
    }
    console.log("");
    return;
  }

  while (true) {
    const current = ctx.checkpoints.getAggregatedChanges();
    if (current.length === 0) {
      console.log(`  ${theme.faint("All session file changes have been reverted.")}\n`);
      return;
    }
    const options: SelectOption<string>[] = current.map((ch) => ({
      value: ch.filePath,
      label: ch.relPath,
      description: `${ch.existedBefore ? "modified" : "created"} via ${ch.tool}`,
      badge: `+${ch.added} -${ch.removed}`,
      badgeTone: "accent",
    }));

    const picked = await runInteractiveSelect({
      title: `Session Changes (${current.length} file${current.length > 1 ? "s" : ""})`,
      subtitle: "Select a file to inspect its full Nord diff or revert it.",
      options,
    });
    if (!picked) return;

    const snap = current.find((c) => c.filePath === picked);
    if (!snap) return;

    const preview = formatColoredDiffPreview(snap.relPath, snap.beforeContent, snap.afterContent, { maxLines: 120 });
    console.log(`\n  ${theme.badge("DIFF", "accent")} ${theme.fgBold(snap.relPath)} ${theme.faint("(")}${theme.ok(`+${snap.added}`)} ${theme.error(`-${snap.removed}`)}${theme.faint(")")}`);
    console.log(preview.preview);
    console.log("");

    const action = await runInteractiveSelect<"back" | "revert" | "close">({
      title: snap.relPath,
      options: [
        { value: "back", label: "Back to modified files list" },
        { value: "revert", label: "Revert this file to pre-session state", badge: "UNDO", badgeTone: "warn" },
        { value: "close", label: "Close diff viewer" },
      ],
    });

    if (action === "revert") {
      const r = ctx.checkpoints.revertFile(snap.filePath);
      if (r.restored) {
        console.log(`  ${theme.ok(glyphs.dot)} Reverted ${theme.info(r.relPath)}.\n`);
      }
      continue;
    }
    if (action === "close" || action === null) return;
  }
}

async function handlePermissionsCommand(parts: string[], ctx: CommandContext): Promise<void> {
  if (parts.length >= 3) {
    const tier = parts[1].toLowerCase() as PermissionTier;
    const action = parts[2].toLowerCase();
    if (tier === "allow" || tier === "ask" || tier === "deny") {
      if (action === "add" && parts[3]) {
        const rule = parts.slice(3).join(" ");
        const ok = ctx.permissionStore.addRule(tier, rule, "project");
        console.log(
          ok
            ? `  ${theme.ok(glyphs.dot)} Added ${theme.info(rule)} to project ${tier} list.\n`
            : `  ${theme.error(glyphs.cross)} Invalid rule syntax. Use action(target), e.g. command(npm test) or write_file(src/).\n`,
        );
        return;
      }
      if ((action === "remove" || action === "rm" || action === "del") && parts[3]) {
        const rule = parts.slice(3).join(" ");
        const ok = ctx.permissionStore.removeRule(tier, rule, "project") || ctx.permissionStore.removeRule(tier, rule, "global");
        console.log(
          ok
            ? `  ${theme.ok(glyphs.dot)} Removed ${theme.info(rule)} from ${tier} list.\n`
            : `  ${theme.warn(glyphs.warn)} Rule '${rule}' not found.\n`,
        );
        return;
      }
    }
  }

  if (!isInteractiveTty()) {
    const merged = ctx.permissionStore.loadMerged();
    console.log(`\n  ${theme.fgBold("Permission Policy")} (${theme.info(ctx.agent.getPermissionProfile())})`);
    console.log(`    Allow:   ${merged.allow.length > 0 ? merged.allow.join(", ") : theme.faint("(none)")}`);
    console.log(`    Ask:     ${merged.ask.length > 0 ? merged.ask.join(", ") : theme.faint("(none)")}`);
    console.log(`    Deny:    ${merged.deny.length > 0 ? merged.deny.join(", ") : theme.faint("(none)")}`);
    console.log(`    Session: ${ctx.sessionApprovedTools.size > 0 ? [...ctx.sessionApprovedTools].join(", ") : theme.faint("(none)")}\n`);
    return;
  }

  const getTabs = (): TabPane[] => {
    const proj = ctx.permissionStore.loadScope("project");
    const glob = ctx.permissionStore.loadScope("global");
    const combine = (tier: PermissionTier) => [
      ...proj[tier].map((r) => ({ id: `project:${r}`, label: r, badge: "project" })),
      ...glob[tier].map((r) => ({ id: `global:${r}`, label: r, badge: "global" })),
    ];
    return [
      { id: "allow", title: "Allow", items: combine("allow"), emptyText: "No allow rules. Press 'a' to add e.g. command(npm test)." },
      { id: "ask", title: "Ask", items: combine("ask"), emptyText: "No explicit ask rules. Press 'a' to add e.g. command(*)." },
      { id: "deny", title: "Deny", items: combine("deny"), emptyText: "No deny rules. Press 'a' to add e.g. command(rm -rf)." },
      {
        id: "session",
        title: "Session",
        items: [...ctx.sessionApprovedTools].map((t) => ({ id: `session:${t}`, label: t, badge: "this session" })),
        emptyText: "No temporary session approvals yet.",
      },
    ];
  };

  await runTabbedPanel({
    title: `Permissions (${ctx.agent.getPermissionProfile().toUpperCase()})`,
    getTabs,
    actions: [
      {
        key: "a",
        label: "add rule",
        onTrigger: async (tab) => {
          if (tab.id === "session") return false;
          const rule = await askInlineText(`Add ${tab.id.toUpperCase()} rule (project scope)`, {
            placeholder: "e.g. command(npm test) or write_file(src/)",
          });
          if (rule && rule.trim()) {
            const added = ctx.permissionStore.addRule(tab.id as PermissionTier, rule.trim(), "project");
            if (!added) {
              console.log(`  ${theme.warn(glyphs.warn)} Invalid rule format. Expected action(target).`);
            }
          }
          return false;
        },
      },
      {
        key: "d",
        label: "delete",
        onTrigger: (tab, item) => {
          if (!item) return false;
          if (tab.id === "session") {
            ctx.sessionApprovedTools.delete(item.label);
            return false;
          }
          const scope = item.id.startsWith("global:") ? "global" : "project";
          ctx.permissionStore.removeRule(tab.id as PermissionTier, item.label, scope);
          return false;
        },
      },
    ],
  });
}

function handleApproveCommand(parts: string[], ctx: CommandContext): void {
  const cfg = configManager.get();
  if (parts.length === 1) {
    console.log(`\n  ${theme.fgBold("Approval Policy:")} ${theme.badge(ctx.agent.getPermissionProfile().toUpperCase(), "accent")}`);
    console.log(`    Read files:   ${cfg.autoApproveRead ? theme.ok("auto") : theme.warn("ask")}`);
    console.log(`    Write/Edit:   ${cfg.autoApproveWrite ? theme.ok("auto") : theme.warn("ask")}`);
    console.log(`    Shell run:    ${cfg.autoApproveRun ? theme.ok("auto") : theme.warn("ask")}`);
    if (ctx.sessionApprovedTools.size > 0) {
      console.log(`    Session pass: ${theme.info([...ctx.sessionApprovedTools].join(", "))}`);
    }
    console.log(`    ${theme.faint("Tip: Press Shift+Tab to cycle Ask / Accept Edits / Plan / Auto, or run /permissions.")}\n`);
    return;
  }

  const target = parts[1]?.toLowerCase();
  const mode = parts[2]?.toLowerCase();
  const boolVal =
    mode === "on" || mode === "auto" || mode === "true"
      ? true
      : mode === "off" || mode === "ask" || mode === "false"
        ? false
        : null;

  if (!target || boolVal === null) {
    console.log(`  Usage: ${theme.info("/approve <read|write|run> <on|off>")}\n`);
    return;
  }

  if (target === "read") configManager.set("autoApproveRead", boolVal);
  else if (target === "write") configManager.set("autoApproveWrite", boolVal);
  else if (target === "run") configManager.set("autoApproveRun", boolVal);
  else {
    console.log(`  Unknown target '${target}'. Choose read, write, or run.\n`);
    return;
  }
  console.log(`  ${theme.ok(glyphs.dot)} Auto-approve '${target}' set to ${boolVal ? theme.ok("on") : theme.warn("off")}\n`);
}

async function handleModelCommand(parts: string[], agent: Agent): Promise<void> {
  const cfg = configManager.get();

  if (parts.length === 1) {
    if (isInteractiveTty()) {
      const states = await probeProviderStates();
      const activeState = states.find((s) => s.name === cfg.provider);
      const models = activeState?.models || PROVIDER_PRESETS[cfg.provider];
      const options: SelectOption<string>[] = models.map((m) => ({
        value: m,
        label: m,
        badge: m === cfg.model ? "ACTIVE" : undefined,
        badgeTone: "ok",
      }));
      options.push({
        value: "__custom__",
        label: "Custom model identifier...",
        description: `Enter any ${cfg.provider} model ID`,
      });
      const picked = await runInteractiveSelect({
        title: `Select Model (${cfg.provider})`,
        subtitle: `Current: ${cfg.provider}/${cfg.model}`,
        options,
        initialIndex: Math.max(0, models.indexOf(cfg.model)),
        searchable: models.length > 6,
      });
      if (!picked) return;
      let targetModel = picked;
      if (picked === "__custom__") {
        const entered = await askInlineText(`Model ID for ${cfg.provider}`, { placeholder: cfg.model });
        if (!entered || !entered.trim()) return;
        targetModel = entered.trim();
      }
      configManager.set("model", targetModel);
      const instance = createOptionalProvider(cfg.provider, targetModel);
      agent.setProvider(instance);
      console.log(
        instance
          ? `  ${theme.ok(glyphs.dot)} Switched model to ${theme.info(`${cfg.provider}/${targetModel}`)}\n`
          : `  ${theme.warn(glyphs.warn)} Saved model '${targetModel}', credentials needed for '${cfg.provider}'.\n`,
      );
      return;
    }

    const states = await probeProviderStates();
    const activeState = states.find((s) => s.name === cfg.provider);
    const models = activeState?.models || PROVIDER_PRESETS[cfg.provider];
    console.log(`\n  Active: ${theme.info(`${cfg.provider}/${cfg.model}`)} ${agent.hasProvider() ? theme.ok("(ready)") : theme.warn("(key missing)")}`);
    console.log(`  Presets: ${models.map((m) => theme.info(m)).join(", ")}`);
    console.log(`  Switch with ${theme.info("/model <model_name>")} or ${theme.info("/model <provider> <model_name>")}\n`);
    return;
  }

  if (parts.length === 2) {
    const modelName = parts[1];
    configManager.set("model", modelName);
    const provider = createOptionalProvider(cfg.provider, modelName);
    agent.setProvider(provider);
    if (provider) {
      console.log(`  ${theme.ok(glyphs.dot)} Switched model to ${theme.info(`${cfg.provider}/${modelName}`)}\n`);
    } else {
      console.log(`  ${theme.warn(glyphs.warn)} Saved model '${modelName}', but credentials for '${cfg.provider}' are missing. Run ${theme.info(`/key ${cfg.provider}`)}\n`);
    }
    return;
  }

  const prov = parts[1].toLowerCase() as ProviderName;
  const mod = parts[2];
  if (!VALID_PROVIDERS.includes(prov)) {
    console.log(`  ${theme.error(glyphs.cross)} Unsupported provider '${prov}'. Valid: ${VALID_PROVIDERS.join(", ")}\n`);
    return;
  }

  configManager.set("provider", prov);
  configManager.set("model", mod);
  const provider = createOptionalProvider(prov, mod);
  agent.setProvider(provider);
  if (provider) {
    console.log(`  ${theme.ok(glyphs.dot)} Model switched to ${theme.info(`${prov}/${mod}`)}\n`);
  } else {
    console.log(`  ${theme.warn(glyphs.warn)} Set ${prov}/${mod}. Run ${theme.info(`/key ${prov}`)} to authenticate.\n`);
  }
}

async function handleSessionsPicker(ctx: CommandContext): Promise<void> {
  const sessions = listSessions(20);
  if (sessions.length === 0) {
    console.log(`  ${theme.faint("No saved sessions found yet.")}\n`);
    return;
  }

  if (!isInteractiveTty()) {
    console.log(`\n  ${theme.fgBold("Saved Sessions:")}`);
    for (const s of sessions) {
      const active = s.id === ctx.sessionId ? theme.ok(" (current)") : "";
      console.log(`    ${theme.info(s.id)} ${theme.faint(`[${s.provider}/${s.model} · ${formatRelativeTime(s.updatedAt)}]`)} ${s.title}${active}`);
    }
    console.log(`\n  Use ${theme.info("/resume <id>")} to load a session.\n`);
    return;
  }

  const options: SelectOption<string>[] = sessions.map((s) => ({
    value: s.id,
    label: s.title,
    description: `${s.provider}/${s.model} ${glyphs.middot} ${s.messages.length} msgs ${glyphs.middot} ${formatRelativeTime(s.updatedAt)}`,
    badge: s.id === ctx.sessionId ? "CURRENT" : undefined,
    badgeTone: "ok",
  }));

  const pickedId = await runInteractiveSelect({
    title: "Saved Sessions",
    subtitle: "Press Enter to resume a session or 'd' to delete.",
    options,
    searchable: true,
    allowDelete: true,
    onDelete: (item) => deleteSession(item.value),
  });
  if (!pickedId) return;

  const loaded = loadSession(pickedId);
  if (loaded) {
    ctx.setSessionId(loaded.id);
    ctx.agent.loadMessages(loaded.messages);
    ctx.checkpoints.clear();
    console.log(`  ${theme.ok(glyphs.dot)} Resumed session ${theme.info(loaded.id)} (${loaded.messages.length} messages).\n`);
  }
}

export async function handleSlashCommand(trimmed: string, ctx: CommandContext): Promise<boolean> {
  if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit" || trimmed === "/quit") {
    await ctx.onExit();
    return true;
  }

  if (!trimmed.startsWith("/")) {
    return false;
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const cmd = parts[0].toLowerCase();

  if (cmd === "/help") {
    printHelp();
    return true;
  }

  if (cmd === "/new") {
    ctx.agent.clearHistory();
    ctx.sessionApprovedTools.clear();
    ctx.checkpoints.clear();
    console.log(`  ${theme.ok(glyphs.dot)} Started a fresh conversation.\n`);
    return true;
  }

  if (cmd === "/clear") {
    console.clear();
    ctx.agent.clearHistory();
    ctx.sessionApprovedTools.clear();
    ctx.checkpoints.clear();
    ctx.onRedrawHeader();
    console.log(`  ${theme.ok(glyphs.dot)} Screen and conversation context cleared.\n`);
    return true;
  }

  if (cmd === "/setup") {
    await runInteractiveSetup(ctx.ask, ctx.agent, false);
    return true;
  }

  if (cmd === "/doctor") {
    const checks = await runDoctorDiagnostics(ctx.agent.getWorkingDirectory());
    console.log(formatDoctorReport(checks));
    return true;
  }

  if (cmd === "/context") {
    await handleContextCommand(ctx);
    return true;
  }

  if (cmd === "/diff") {
    await handleDiffCommand(ctx);
    return true;
  }

  if (cmd === "/rewind") {
    await handleRewindCommand(ctx);
    return true;
  }

  if (cmd === "/copy") {
    const mode = (parts[1] || "").toLowerCase();
    const content = mode === "code" ? ctx.agent.getLastCodeBlock() : ctx.agent.getLastAssistantText();
    if (!content) {
      console.log(`  ${theme.warn(glyphs.warn)} ${mode === "code" ? "No code block found in the last assistant response." : "No assistant response to copy yet."}\n`);
      return true;
    }
    const res = copyToClipboard(content);
    if (res.ok) {
      console.log(`  ${theme.ok(glyphs.dot)} Copied ${mode === "code" ? "last code block" : "last response"} (${content.length} chars) to clipboard.\n`);
    } else {
      console.log(`  ${theme.error(glyphs.cross)} ${res.error}\n`);
    }
    return true;
  }

  if (cmd === "/init") {
    const res = initWideWorkspace(ctx.agent.getWorkingDirectory());
    const stackLabel = res.detectedStack.length > 0 ? res.detectedStack.join(", ") : "generic";
    console.log(`  ${theme.ok(glyphs.dot)} Initialized Wide workspace (${theme.muted(`stack: ${stackLabel}`)})`);
    if (res.created.length > 0) console.log(`    Created: ${theme.info(res.created.join(", "))}`);
    if (res.skipped.length > 0) console.log(`    Existing (kept): ${theme.faint(res.skipped.join(", "))}`);
    console.log("");
    return true;
  }

  if (cmd === "/plan") {
    const next: PermissionProfile = ctx.agent.getPermissionProfile() === "plan" ? "accept-edits" : "plan";
    ctx.agent.setPermissionProfile(next);
    console.log(
      next === "plan"
        ? `  ${theme.info(glyphs.dot)} Plan mode enabled (read-only analysis). Press Shift+Tab or run /plan to exit.\n`
        : `  ${theme.ok(glyphs.dot)} Exited Plan mode -> active profile: ${theme.info(next)}.\n`,
    );
    return true;
  }

  if (cmd === "/permissions") {
    await handlePermissionsCommand(parts, ctx);
    return true;
  }

  if (cmd === "/provider") {
    if (parts.length < 2) {
      if (isInteractiveTty()) {
        const states = await probeProviderStates();
        const current = configManager.get().provider;
        const picked = await runInteractiveSelect<ProviderName>({
          title: "Switch AI Provider",
          options: states.map((s) => ({
            value: s.name,
            label: s.label,
            description: s.detail,
            badge: s.name === current ? "ACTIVE" : s.badge,
            badgeTone: s.name === current ? "accent" : s.badgeTone,
          })),
          initialIndex: Math.max(0, states.findIndex((s) => s.name === current)),
        });
        if (!picked) return true;
        parts.push(picked);
      } else {
        const current = configManager.get().provider;
        console.log(`\n  Active provider: ${theme.info(current)}`);
        console.log(`  Available: ${VALID_PROVIDERS.map((p) => (p === current ? theme.accentBold(p) : theme.faint(p))).join(", ")}\n`);
        return true;
      }
    }
    const prov = parts[1].toLowerCase() as ProviderName;
    if (!VALID_PROVIDERS.includes(prov)) {
      console.log(`  ${theme.error(glyphs.cross)} Unsupported provider '${prov}'. Valid: ${VALID_PROVIDERS.join(", ")}\n`);
      return true;
    }
    const nextModel = PROVIDER_PRESETS[prov][0];
    configManager.set("provider", prov);
    configManager.set("model", nextModel);
    const instance = createOptionalProvider(prov, nextModel);
    ctx.agent.setProvider(instance);
    if (instance) {
      console.log(`  ${theme.ok(glyphs.dot)} Provider switched to ${theme.info(`${prov}/${nextModel}`)}\n`);
    } else if (prov === "claude-code") {
      console.log(`  ${theme.warn(glyphs.warn)} Provider set to '${prov}'. Run ${theme.info("claude auth login")} to sign in.\n`);
    } else if (prov === "antigravity") {
      console.log(`  ${theme.warn(glyphs.warn)} Provider set to '${prov}'. Run ${theme.info("agy")} to sign in.\n`);
    } else if (prov === "codex") {
      console.log(`  ${theme.warn(glyphs.warn)} Provider set to '${prov}'. Run ${theme.info("codex login")} to sign in.\n`);
    } else {
      console.log(`  ${theme.warn(glyphs.warn)} Provider set to '${prov}' (${nextModel}). Run ${theme.info(`/key ${prov}`)} to authenticate.\n`);
    }
    return true;
  }

  if (cmd === "/model") {
    await handleModelCommand(parts, ctx.agent);
    return true;
  }

  if (cmd === "/key") {
    const prov = (parts[1] || configManager.get().provider).toLowerCase() as ProviderName;
    if (!VALID_PROVIDERS.includes(prov) || prov === "ollama" || prov === "claude-code" || prov === "antigravity" || prov === "codex") {
      console.log(`  Usage: ${theme.info("/key <gemini|claude|deepseek|openai> [apiKey]")}\n`);
      return true;
    }
    let key = parts[2] || "";
    if (!key) {
      if (isInteractiveTty()) {
        const entered = await askInlineText(`${prov} API Key`, {
          masked: true,
          placeholder: "Paste API key (masked input)",
        });
        key = (entered || "").trim();
      } else {
        key = (await ctx.ask(`  ${theme.accent(`Enter ${prov} API key:`)} `)).trim();
      }
    }
    if (!key) {
      console.log(`  ${theme.warn(glyphs.warn)} Cancelled: no API key entered.\n`);
      return true;
    }
    configManager.setApiKey(prov, key);
    const cfg = configManager.get();
    if (cfg.provider === prov) {
      ctx.agent.setProvider(createProvider(prov, cfg.model));
    }
    console.log(`  ${theme.ok(glyphs.dot)} API key saved securely for '${prov}'.\n`);
    return true;
  }

  if (cmd === "/config") {
    const cfg = configManager.get();
    console.log(`\n  ${theme.fgBold("Wide CLI Configuration:")}`);
    console.log(`    Provider:        ${theme.info(cfg.provider)} ${ctx.agent.hasProvider() ? theme.ok("(ready)") : theme.warn("(unconfigured)")}`);
    console.log(`    Model:           ${theme.info(cfg.model)}`);
    console.log(`    Permission Mode: ${theme.accent(ctx.agent.getPermissionProfile())}`);
    console.log(`    Tool Mode:       ${theme.accent(ctx.agent.getToolMode())}`);
    console.log(`    Mouse TUI:       ${isMouseEnabled() ? theme.ok("on") : theme.warn("off")}`);
    console.log(`    Ollama URL:      ${theme.faint(cfg.ollamaBaseUrl)}`);
    console.log(`    Auto-Approve:    Read=${cfg.autoApproveRead}, Write=${cfg.autoApproveWrite}, Run=${cfg.autoApproveRun}`);
    console.log(`    Max Iterations:  ${cfg.maxIterations}`);
    console.log(`    Workspace:       ${theme.faint(ctx.agent.getWorkingDirectory())}\n`);
    return true;
  }

  if (cmd === "/mouse") {
    const sub = (parts[1] || "status").toLowerCase();
    if (sub === "on" || sub === "enable" || sub === "true") {
      setMouseEnabled(true);
      configManager.set("mouse", true);
      console.log(`  ${theme.ok(glyphs.dot)} Terminal mouse interaction ${theme.ok("ON")} ${theme.faint("(hold Shift+drag to select text)")}\n`);
      return true;
    }
    if (sub === "off" || sub === "disable" || sub === "false") {
      setMouseEnabled(false);
      configManager.set("mouse", false);
      console.log(`  ${theme.ok(glyphs.dot)} Terminal mouse interaction ${theme.warn("OFF")}\n`);
      return true;
    }
    console.log(`  ${theme.faint("Mouse interaction:")} ${isMouseEnabled() ? theme.ok("ON") : theme.warn("OFF")} ${theme.faint("(/mouse on | /mouse off)")}\n`);
    return true;
  }

  if (cmd === "/approve") {
    handleApproveCommand(parts, ctx);
    return true;
  }

  if (cmd === "/scan") {
    const target = parts[1] || ".";
    const res = await executeTool("run_security_scan", { path: target }, { workingDirectory: ctx.agent.getWorkingDirectory() });
    console.log(res.output || res.error || "");
    return true;
  }

  if (cmd === "/rules") {
    const sub = (parts[1] || "list").toLowerCase();
    if (sub === "sync" || sub === "update") {
      console.log(`  ${theme.info("Synchronizing Wide security rules and OSV advisories...")}`);
      try {
        const res = await RuleLoader.updateRules();
        const reloaded = ctx.agent.reloadAgentRules();
        console.log(`  ${theme.ok(glyphs.dot)} Synchronized ${res.count} rules and ${res.osvCount} OSV advisories; ${reloaded.length} AI agent rule(s) active.\n`);
      } catch (err: any) {
        console.log(`  ${theme.error(glyphs.cross)} ${err.message}\n`);
      }
      return true;
    }
    if (sub === "advisories" || sub === "osv") {
      const db = RuleLoader.loadAdvisories(ctx.agent.getWorkingDirectory());
      const counts = Object.entries(db?.stats?.byEcosystem || {})
        .filter(([, n]) => Number(n) > 0)
        .map(([k, n]) => `${k}:${n}`)
        .join(", ");
      console.log(`\n  ${theme.fgBold("Loaded OSV Advisories:")} ${theme.info(String(db?.stats?.total || 0))}${counts ? ` (${counts})` : ""}\n`);
      return true;
    }
    const rules = ctx.agent.getAgentRules();
    const info = RuleLoader.getAgentRulesPath();
    console.log(`\n  ${theme.fgBold(`Active AI Agent Rules (${rules.length}) [${info.active}]:`)}`);
    for (const r of rules) {
      console.log(`    ${theme.info(r.id)} ${theme.severity(r.severity)} ${theme.muted(r.message)}`);
    }
    console.log("");
    return true;
  }

  if (cmd === "/db") {
    await handleDbCommand(trimmed, {
      workingDirectory: ctx.agent.getWorkingDirectory(),
      ask: ctx.ask,
    });
    return true;
  }

  if (cmd === "/mode") {
    let requested = parts[1]?.toLowerCase() as CliToolMode | undefined;
    if (!requested) {
      if (isInteractiveTty()) {
        const picked = await runInteractiveSelect<CliToolMode>({
          title: "Select Tool Mode",
          options: [
            { value: "full", label: "Full", description: "Coding, security scanning, HTTP recon, DB, and browser tools", badge: ctx.agent.getToolMode() === "full" ? "ACTIVE" : undefined, badgeTone: "ok" },
            { value: "code", label: "Code", description: "Focused software engineering tools (no active recon/fuzzing)", badge: ctx.agent.getToolMode() === "code" ? "ACTIVE" : undefined, badgeTone: "ok" },
            { value: "security", label: "Security", description: "AppSec auditing & recon (source code write tools disabled)", badge: ctx.agent.getToolMode() === "security" ? "ACTIVE" : undefined, badgeTone: "ok" },
          ],
        });
        if (!picked) return true;
        requested = picked;
      } else {
        console.log(`\n  ${theme.fgBold("Assistant Tool Mode:")} ${theme.info(ctx.agent.getToolMode())}`);
        console.log(`  Usage: ${theme.info("/mode <full|code|security>")}\n`);
        return true;
      }
    }
    if (requested !== "full" && requested !== "code" && requested !== "security") {
      console.log(`  ${theme.warn(glyphs.warn)} Invalid mode '${parts[1]}'. Choose: full, code, or security.\n`);
      return true;
    }
    ctx.agent.setToolMode(requested);
    configManager.set("toolMode", requested);
    console.log(`  ${theme.ok(glyphs.dot)} Tool mode switched to ${theme.info(requested)}.\n`);
    return true;
  }

  if (cmd === "/browser") {
    const sub = (parts[1] || "status").toLowerCase();
    if (sub === "on" || sub === "enable") {
      ctx.agent.setAllowBrowser(true);
      configManager.set("allowBrowser", true);
      console.log(`  ${theme.ok(glyphs.dot)} Browser tools ${theme.info("ON")}.\n`);
      return true;
    }
    if (sub === "off" || sub === "disable") {
      ctx.agent.setAllowBrowser(false);
      configManager.set("allowBrowser", false);
      try {
        await executeTool("browser_close", {}, { workingDirectory: ctx.agent.getWorkingDirectory() });
      } catch {}
      console.log(`  ${theme.ok(glyphs.dot)} Browser tools ${theme.warn("OFF")}.\n`);
      return true;
    }
    if (sub === "close") {
      const res = await executeTool("browser_close", {}, { workingDirectory: ctx.agent.getWorkingDirectory() });
      console.log(`  ${theme.ok(glyphs.dot)} ${res.output}\n`);
      return true;
    }
    const enabled = ctx.agent.getAllowBrowser();
    console.log(`  ${theme.faint("Browser Toggle:")} ${enabled ? theme.ok("ON") : theme.warn("OFF")}`);
    if (!enabled) {
      console.log(`  Use ${theme.info("/browser on")} to enable browser automation tools.\n`);
      return true;
    }
    const res = await executeTool("browser_extract", {}, { workingDirectory: ctx.agent.getWorkingDirectory() });
    if (res.success) {
      console.log(`  ${theme.ok(glyphs.dot)} Active browser session:\n${res.output.slice(0, 600)}\n`);
    } else {
      console.log(`  ${theme.faint("No active browser session. Ask Wide to open a URL or use browser_open.")}\n`);
    }
    return true;
  }

  if (cmd === "/cd") {
    const targetDir = parts.slice(1).join(" ").trim();
    if (!targetDir) {
      console.log(`  ${theme.faint("Current directory:")} ${ctx.agent.getWorkingDirectory()}\n`);
      return true;
    }
    const resolved = resolve(ctx.agent.getWorkingDirectory(), targetDir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      console.log(`  ${theme.error(glyphs.cross)} Directory not found: ${resolved}\n`);
      return true;
    }
    ctx.agent.setWorkingDirectory(resolved);
    ctx.permissionStore.setWorkspaceDir(resolved);
    console.log(`  ${theme.ok(glyphs.dot)} Workspace changed to ${theme.info(resolved)}\n`);
    return true;
  }

  if (cmd === "/compact") {
    const { before, after } = ctx.agent.compactNow();
    console.log(`  ${theme.ok(glyphs.dot)} Context compacted (${before} -> ${after} messages).\n`);
    return true;
  }

  if (cmd === "/sessions") {
    await handleSessionsPicker(ctx);
    return true;
  }

  if (cmd === "/resume") {
    const targetId = parts[1];
    if (!targetId) {
      await handleSessionsPicker(ctx);
      return true;
    }
    const loaded = loadSession(targetId);
    if (!loaded) {
      console.log(`  ${theme.error(glyphs.cross)} Session '${targetId}' not found.\n`);
      return true;
    }
    ctx.setSessionId(loaded.id);
    ctx.agent.loadMessages(loaded.messages);
    ctx.checkpoints.clear();
    console.log(`  ${theme.ok(glyphs.dot)} Resumed session ${theme.info(loaded.id)} (${loaded.messages.length} messages).\n`);
    return true;
  }

  if (cmd === "/status") {
    const cfg = configManager.get();
    const stats = ctx.agent.getStats();
    const ctxInfo = ctx.agent.getContextBreakdown();
    console.log(`\n  ${theme.fgBold("Session Status:")}`);
    console.log(`    Session ID:   ${theme.info(ctx.sessionId)}`);
    console.log(`    Provider:     ${theme.info(`${cfg.provider}/${cfg.model}`)} ${ctx.agent.hasProvider() ? theme.ok("(ready)") : theme.warn("(unconfigured)")}`);
    console.log(`    Mode:         ${theme.accent(ctx.agent.getToolMode())} ${theme.faint(glyphs.middot)} Permissions: ${theme.accent(ctx.agent.getPermissionProfile())} ${theme.faint(glyphs.middot)} Browser: ${ctx.agent.getAllowBrowser() ? theme.ok("ON") : theme.warn("OFF")}`);
    console.log(`    Context:      ${renderContextBar(ctxInfo.fillPercent, 18)} ${ctxInfo.fillPercent}% (~${ctxInfo.estimatedTokens.toLocaleString()} tokens)`);
    console.log(`    Workspace:    ${theme.faint(ctx.agent.getWorkingDirectory())}`);
    console.log(`    History:      ${stats.turns} turns, ${stats.toolCalls} tool calls, ${stats.messageCount} messages`);
    if (stats.inputTokens > 0 || stats.outputTokens > 0) {
      console.log(`    Usage:        ${stats.inputTokens.toLocaleString()} in / ${stats.outputTokens.toLocaleString()} out tokens`);
    }
    console.log(`    Agent Rules:  ${stats.ruleCount} active rule(s)\n`);
    return true;
  }

  if (cmd === "/save") {
    const cfg = configManager.get();
    saveSession(ctx.sessionId, {
      workingDirectory: ctx.agent.getWorkingDirectory(),
      provider: cfg.provider,
      model: cfg.model,
      messages: ctx.agent.getMessages(),
    });
    console.log(`  ${theme.ok(glyphs.dot)} Saved session ${theme.info(ctx.sessionId)}\n`);
    return true;
  }

  console.log(`  ${theme.warn(glyphs.warn)} Unknown command '${cmd}'. Type ${theme.info("/help")} for available commands.\n`);
  return true;
}
