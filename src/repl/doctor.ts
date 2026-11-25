import { existsSync } from "node:fs";
import { configManager, type ProviderName } from "../config/index.js";
import { checkAntigravityStatus, checkClaudeCodeAuth, listOllamaModels } from "../providers/index.js";
import { RuleLoader } from "../security/loader.js";
import { horizontalRule, padEndAnsi, termHeight, termWidth } from "../ui/ansi.js";
import { detectColorDepth, glyphs, supportsUnicode, theme } from "../ui/theme.js";
import { isMouseEnabled } from "../ui/tui/keys.js";
import { refreshGitStatus } from "../ui/tui/statusbar.js";

export interface DoctorCheckItem {
  category: string;
  name: string;
  status: "ok" | "warn" | "error" | "info";
  detail: string;
}

export async function runDoctorDiagnostics(cwd: string, version = "0.9.251126"): Promise<DoctorCheckItem[]> {
  const cfg = configManager.get();
  const [git, ollama, claudeAuth, agyStatus] = await Promise.all([
    refreshGitStatus(cwd),
    listOllamaModels(cfg.ollamaBaseUrl),
    checkClaudeCodeAuth(),
    checkAntigravityStatus(),
  ]);

  const items: DoctorCheckItem[] = [];
  const depth = detectColorDepth();

  items.push({
    category: "Environment",
    name: "Wide CLI",
    status: "ok",
    detail: `v${version} on Node ${process.version} (${process.platform}/${process.arch})`,
  });
  items.push({
    category: "Environment",
    name: "Terminal",
    status: process.stdout.isTTY ? "ok" : "info",
    detail: `${process.stdout.isTTY ? "TTY" : "non-TTY"} ${glyphs.middot} ${termWidth()}x${termHeight()} ${glyphs.middot} color:${depth} ${glyphs.middot} unicode:${supportsUnicode() ? "yes" : "ascii"} ${glyphs.middot} mouse:${isMouseEnabled() ? "on" : "off"}`,
  });
  items.push({
    category: "Environment",
    name: "Workspace",
    status: git.branch ? "ok" : "info",
    detail: git.branch ? `${cwd} (git:${git.branch}${git.dirty ? ", modified" : ", clean"})` : `${cwd} (not a git repo)`,
  });

  const rules = RuleLoader.loadRules(undefined, cwd);
  const advisories = RuleLoader.loadAdvisories(cwd);
  const cachePath = RuleLoader.getCachePath();
  items.push({
    category: "Security Engine",
    name: "Rules & OSV",
    status: rules.length > 0 ? "ok" : "warn",
    detail: `${rules.length} rules ${glyphs.middot} ${advisories?.stats?.total || 0} OSV advisories ${glyphs.middot} cache:${existsSync(cachePath) ? "synced" : "bundled"}`,
  });

  const agentRulesInfo = RuleLoader.getAgentRulesPath();
  items.push({
    category: "Security Engine",
    name: "Agent Guardrails",
    status: "ok",
    detail: `source:${agentRulesInfo.active}`,
  });

  const activeReady = configManager.hasProviderCredentials(cfg.provider);
  items.push({
    category: "Providers",
    name: "Active",
    status: activeReady ? "ok" : "warn",
    detail: `${cfg.provider}/${cfg.model} (${activeReady ? "configured" : "needs auth"})`,
  });

  items.push({
    category: "Providers",
    name: "antigravity",
    status: agyStatus.signedIn ? "ok" : agyStatus.installed ? "warn" : "info",
    detail: agyStatus.signedIn
      ? `v${agyStatus.version || "cli"} signed in (${agyStatus.models.length} model(s))`
      : agyStatus.installed
        ? `installed (v${agyStatus.version || "cli"}), run 'agy' to sign in`
        : "not installed",
  });

  items.push({
    category: "Providers",
    name: "claude-code",
    status: claudeAuth?.loggedIn ? "ok" : claudeAuth ? "warn" : "info",
    detail: claudeAuth?.loggedIn
      ? `signed in${claudeAuth.subscriptionType ? ` (${claudeAuth.subscriptionType})` : ""}`
      : claudeAuth
        ? "installed, run 'claude auth login'"
        : "not installed",
  });

  items.push({
    category: "Providers",
    name: "ollama",
    status: ollama.reachable ? "ok" : "info",
    detail: ollama.reachable
      ? `running at ${cfg.ollamaBaseUrl} (${ollama.models.length} model(s))`
      : `not reachable at ${cfg.ollamaBaseUrl}`,
  });

  const apiProviders: Array<Exclude<ProviderName, "ollama" | "claude-code" | "antigravity" | "codex">> = [
    "gemini",
    "claude",
    "openai",
    "deepseek",
  ];
  const configuredKeys = apiProviders.filter((p) => Boolean(configManager.getApiKey(p)));
  items.push({
    category: "Providers",
    name: "API Keys",
    status: configuredKeys.length > 0 ? "ok" : "info",
    detail: configuredKeys.length > 0 ? `configured: ${configuredKeys.join(", ")}` : "none saved (use /key or /setup)",
  });

  return items;
}

export function formatDoctorReport(items: readonly DoctorCheckItem[]): string {
  const cols = Math.min(termWidth(80) - 2, 96);
  const lines: string[] = ["", `  ${theme.fgBold("Wide Diagnostics")}`, `  ${horizontalRule(Math.max(32, cols))}`];

  let lastCat = "";
  for (const item of items) {
    if (item.category !== lastCat) {
      if (lastCat) lines.push("");
      lines.push(`  ${theme.accentBold(item.category)}`);
      lastCat = item.category;
    }
    const icon =
      item.status === "ok"
        ? theme.ok(glyphs.dot)
        : item.status === "warn"
          ? theme.warn(glyphs.warn)
          : item.status === "error"
            ? theme.error(glyphs.cross)
            : theme.faint(glyphs.circle);
    lines.push(`    ${icon} ${padEndAnsi(theme.fg(item.name), 18)} ${theme.muted(item.detail)}`);
  }

  lines.push("");
  return lines.join("\n");
}
