import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import type { Agent } from "../agent/index.js";
import { configManager, type ProviderName } from "../config/index.js";
import {
  createOptionalProvider,
  createProvider,
  listOllamaModels,
  PROVIDER_PRESETS,
} from "../providers/index.js";
import { RuleLoader } from "../security/loader.js";
import { executeTool } from "../tools/index.js";
import { handleDbCommand } from "../tools/db.js";
import { printBanner } from "../ui/banner.js";
import { listSessions, loadSession, saveSession } from "./sessions.js";
import { runInteractiveSetup, type PromptQuestionFn } from "./setup.js";

export interface SlashCommandMeta {
  command: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandMeta[] = [
  { command: "/help", usage: "/help", description: "Show available commands and shortcuts" },
  { command: "/setup", usage: "/setup", description: "Launch interactive provider and key setup" },
  { command: "/provider", usage: "/provider [name]", description: "Show or switch AI provider" },
  { command: "/model", usage: "/model [provider] [model]", description: "List models or switch active model" },
  { command: "/key", usage: "/key <provider> [apiKey]", description: "Configure API key without leaving CLI" },
  { command: "/config", usage: "/config", description: "Show current configuration" },
  { command: "/approve", usage: "/approve [read|write|run] [on|off]", description: "Inspect or toggle tool approval policy" },
  { command: "/mode", usage: "/mode [full|code|security]", description: "Inspect or switch assistant tool mode" },
  { command: "/scan", usage: "/scan [path]", description: "Run Wide SAST security scan in workspace" },
  { command: "/rules", usage: "/rules [list|sync]", description: "Inspect or synchronize wide-rules" },
  { command: "/db", usage: "/db [list|connect|schema|erd|query|export|history|audit]", description: "Manage databases, inspect schemas, export data, and run queries" },
  { command: "/browser", usage: "/browser [on|off|status|close]", description: "Toggle browser tools or inspect/close browser session" },
  { command: "/cd", usage: "/cd <directory>", description: "Change active workspace directory" },
  { command: "/compact", usage: "/compact", description: "Compact conversation context" },
  { command: "/sessions", usage: "/sessions", description: "List saved chat sessions" },
  { command: "/resume", usage: "/resume <id>", description: "Load a saved chat session" },
  { command: "/status", usage: "/status", description: "Show current session stats and model status" },
  { command: "/clear", usage: "/clear", description: "Clear screen and reset conversation history" },
  { command: "/exit", usage: "/exit", description: "Exit Wide CLI" },
];

export interface CommandContext {
  agent: Agent;
  sessionId: string;
  setSessionId: (nextId: string) => void;
  sessionApprovedTools: Set<string>;
  ask: PromptQuestionFn;
  onExit: () => Promise<void>;
}

const VALID_PROVIDERS: ProviderName[] = ["gemini", "ollama", "claude", "claude-code", "antigravity", "codex", "deepseek", "openai"];

function printHelp(): void {
  console.log(`\n${pc.bold("Slash Commands:")}`);
  for (const item of SLASH_COMMANDS) {
    console.log(`  ${pc.cyan(item.usage.padEnd(32))} ${pc.dim(item.description)}`);
  }
  console.log(`\n${pc.bold("Shortcuts:")}`);
  console.log(`  ${pc.cyan("!<command>".padEnd(32))} ${pc.dim("Run a shell command directly (e.g. !git status)")}`);
  console.log(`  ${pc.cyan("@<file>".padEnd(32))} ${pc.dim("Attach file contents to your prompt (e.g. @src/index.ts)")}`);
  console.log(`  ${pc.cyan("\\ at line end".padEnd(32))} ${pc.dim("Continue prompt onto the next line")}`);
  console.log(`  ${pc.cyan("Ctrl+C".padEnd(32))} ${pc.dim("Cancel active response without exiting Wide")}`);
  console.log(`  ${pc.cyan("Tab".padEnd(32))} ${pc.dim("Autocomplete /commands and @files")}\n`);
}

function handleApproveCommand(parts: string[], sessionApprovedTools: Set<string>): void {
  const cfg = configManager.get();
  if (parts.length === 1) {
    console.log(`\n${pc.bold("Approval Policy:")}`);
    console.log(`  Read files:   ${cfg.autoApproveRead ? pc.green("auto") : pc.yellow("ask")}`);
    console.log(`  Write/Edit:   ${cfg.autoApproveWrite ? pc.green("auto") : pc.yellow("ask")}`);
    console.log(`  Shell run:    ${cfg.autoApproveRun ? pc.green("auto") : pc.yellow("ask")}`);
    if (sessionApprovedTools.size > 0) {
      console.log(`  Session pass: ${pc.cyan([...sessionApprovedTools].join(", "))}`);
    }
    console.log("");
    return;
  }

  const target = parts[1]?.toLowerCase();
  const mode = parts[2]?.toLowerCase();
  const boolVal = mode === "on" || mode === "auto" || mode === "true" ? true : mode === "off" || mode === "ask" || mode === "false" ? false : null;

  if (!target || boolVal === null) {
    console.log(`Usage: ${pc.cyan("/approve <read|write|run> <on|off>")}\n`);
    return;
  }

  if (target === "read") configManager.set("autoApproveRead", boolVal);
  else if (target === "write") configManager.set("autoApproveWrite", boolVal);
  else if (target === "run") configManager.set("autoApproveRun", boolVal);
  else {
    console.log(`Unknown target '${target}'. Choose read, write, or run.\n`);
    return;
  }
  console.log(`${pc.green("[OK]")} Auto-approve '${target}' set to ${boolVal ? pc.green("on") : pc.yellow("off")}\n`);
}

async function handleModelCommand(parts: string[], agent: Agent): Promise<void> {
  const cfg = configManager.get();

  if (parts.length === 1) {
    console.log(`\n  Active: ${pc.cyan(`${cfg.provider}/${cfg.model}`)} ${agent.hasProvider() ? pc.green("(ready)") : pc.yellow("(key missing)")}`);
    if (cfg.provider === "ollama") {
      const probe = await listOllamaModels(cfg.ollamaBaseUrl);
      if (probe.reachable && probe.models.length > 0) {
        console.log(`  Ollama models: ${probe.models.map((m) => pc.cyan(m)).join(", ")}`);
      } else {
        console.log(`  Presets: ${PROVIDER_PRESETS.ollama.map((m) => pc.dim(m)).join(", ")}`);
      }
    } else {
      console.log(`  Presets: ${PROVIDER_PRESETS[cfg.provider].map((m) => pc.cyan(m)).join(", ")}`);
    }
    console.log(`  Switch with ${pc.cyan("/model <model_name>")} or ${pc.cyan("/model <provider> <model_name>")}\n`);
    return;
  }

  if (parts.length === 2) {
    const modelName = parts[1];
    configManager.set("model", modelName);
    const provider = createOptionalProvider(cfg.provider, modelName);
    agent.setProvider(provider);
    if (provider) {
      console.log(`${pc.green("[OK]")} Switched model to ${cfg.provider}/${modelName}\n`);
    } else {
      console.log(`${pc.yellow("[WARN]")} Saved model '${modelName}', but API key for '${cfg.provider}' is not set. Run ${pc.cyan(`/key ${cfg.provider} <KEY>`)}\n`);
    }
    return;
  }

  const prov = parts[1].toLowerCase() as ProviderName;
  const mod = parts[2];
  if (!VALID_PROVIDERS.includes(prov)) {
    console.log(`${pc.red("Error:")} Unsupported provider '${prov}'. Valid: ${VALID_PROVIDERS.join(", ")}\n`);
    return;
  }

  configManager.set("provider", prov);
  configManager.set("model", mod);
  const provider = createOptionalProvider(prov, mod);
  agent.setProvider(provider);
  if (provider) {
    console.log(`${pc.green("[OK]")} Model switched to ${prov}/${mod}\n`);
  } else {
    console.log(`${pc.yellow("[WARN]")} Set ${prov}/${mod}. Add key with ${pc.cyan(`/key ${prov} <YOUR_KEY>`)}\n`);
  }
}

export async function handleSlashCommand(trimmed: string, ctx: CommandContext): Promise<boolean> {
  if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit") {
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

  if (cmd === "/clear") {
    console.clear();
    printBanner();
    ctx.agent.clearHistory();
    ctx.sessionApprovedTools.clear();
    console.log(`${pc.green("[OK]")} Screen and conversation context cleared.\n`);
    return true;
  }

  if (cmd === "/setup") {
    await runInteractiveSetup(ctx.ask, ctx.agent, false);
    return true;
  }

  if (cmd === "/provider") {
    if (parts.length < 2) {
      const current = configManager.get().provider;
      console.log(`\n  Active provider: ${pc.cyan(current)}`);
      console.log(`  Available: ${VALID_PROVIDERS.map((p) => (p === current ? pc.bold(pc.cyan(p)) : pc.dim(p))).join(", ")}\n`);
      return true;
    }
    const prov = parts[1].toLowerCase() as ProviderName;
    if (!VALID_PROVIDERS.includes(prov)) {
      console.log(`${pc.red("Error:")} Unsupported provider '${prov}'. Valid: ${VALID_PROVIDERS.join(", ")}\n`);
      return true;
    }
    const nextModel = PROVIDER_PRESETS[prov][0];
    configManager.set("provider", prov);
    configManager.set("model", nextModel);
    const instance = createOptionalProvider(prov, nextModel);
    ctx.agent.setProvider(instance);
    if (instance) {
      console.log(`${pc.green("[OK]")} Provider switched to ${pc.cyan(`${prov}/${nextModel}`)}\n`);
    } else if (prov === "claude-code") {
      console.log(`${pc.yellow("[WARN]")} Provider set to '${prov}'. Run ${pc.cyan("claude auth login")} in your terminal to sign in.\n`);
    } else if (prov === "antigravity") {
      console.log(`${pc.yellow("[WARN]")} Provider set to '${prov}'. Run ${pc.cyan("agy")} in your terminal to sign in.\n`);
    } else if (prov === "codex") {
      console.log(`${pc.yellow("[WARN]")} Provider set to '${prov}'. Run ${pc.cyan("codex login")} in your terminal to sign in.\n`);
    } else {
      console.log(`${pc.yellow("[WARN]")} Provider set to '${prov}' (${nextModel}). Run ${pc.cyan(`/key ${prov} <YOUR_KEY>`)} to authenticate.\n`);
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
      console.log(`Usage: ${pc.cyan("/key <gemini|claude|deepseek|openai> [apiKey]")}\n`);
      return true;
    }
    const key = parts[2] || (await ctx.ask(`  ${pc.cyan(`Enter ${prov} API key:`)} `)).trim();
    if (!key) {
      console.log(pc.yellow("  Cancelled: no API key entered.\n"));
      return true;
    }
    configManager.setApiKey(prov, key);
    const cfg = configManager.get();
    if (cfg.provider === prov) {
      ctx.agent.setProvider(createProvider(prov, cfg.model));
    }
    console.log(`${pc.green("[OK]")} API key saved for '${prov}'.\n`);
    return true;
  }

  if (cmd === "/config") {
    const cfg = configManager.get();
    console.log(`\n${pc.bold("Wide CLI Configuration:")}`);
    console.log(`  Provider:        ${pc.cyan(cfg.provider)} ${ctx.agent.hasProvider() ? pc.green("(ready)") : pc.yellow("(unconfigured)")}`);
    console.log(`  Model:           ${pc.cyan(cfg.model)}`);
    console.log(`  Ollama URL:      ${pc.dim(cfg.ollamaBaseUrl)}`);
    console.log(`  Auto-Approve:    Read=${cfg.autoApproveRead}, Write=${cfg.autoApproveWrite}, Run=${cfg.autoApproveRun}`);
    console.log(`  Max Iterations:  ${cfg.maxIterations}`);
    console.log(`  Workspace:       ${pc.dim(ctx.agent.getWorkingDirectory())}\n`);
    return true;
  }

  if (cmd === "/approve") {
    handleApproveCommand(parts, ctx.sessionApprovedTools);
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
      console.log(pc.cyan("Synchronizing Wide security rules and OSV advisories..."));
      try {
        const res = await RuleLoader.updateRules();
        const reloaded = ctx.agent.reloadAgentRules();
        console.log(`${pc.green("[OK]")} Synchronized ${res.count} rules and ${res.osvCount} OSV advisories; ${reloaded.length} AI agent rule(s) active.\n`);
      } catch (err: any) {
        console.log(`${pc.red("Error:")} ${err.message}\n`);
      }
      return true;
    }
    if (sub === "advisories" || sub === "osv") {
      const db = RuleLoader.loadAdvisories(ctx.agent.getWorkingDirectory());
      const counts = Object.entries(db?.stats?.byEcosystem || {})
        .filter(([, n]) => Number(n) > 0)
        .map(([k, n]) => `${k}:${n}`)
        .join(", ");
      console.log(`\n${pc.bold("Loaded OSV Advisories:")} ${pc.cyan(String(db?.stats?.total || 0))}${counts ? ` (${counts})` : ""}\n`);
      return true;
    }
    const rules = ctx.agent.getAgentRules();
    const info = RuleLoader.getAgentRulesPath();
    console.log(`\n${pc.bold(`Active AI Agent Rules (${rules.length}) [${info.active}]:`)}`);
    for (const r of rules) {
      console.log(`  ${pc.cyan(r.id)} [${pc.yellow(r.severity)}] ${pc.dim(r.message)}`);
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
    const requested = parts[1]?.toLowerCase();
    if (!requested) {
      console.log(`\n${pc.bold("Assistant Tool Mode:")} ${pc.cyan(ctx.agent.getToolMode())}`);
      console.log(`  Usage: ${pc.cyan("/mode <full|code|security>")}\n`);
      return true;
    }
    if (requested !== "full" && requested !== "code" && requested !== "security") {
      console.log(`${pc.yellow("[WARN]")} Invalid mode '${parts[1]}'. Choose: full, code, or security.\n`);
      return true;
    }
    ctx.agent.setToolMode(requested);
    configManager.set("toolMode", requested);
    console.log(`${pc.green("[OK]")} Tool mode switched to ${pc.cyan(requested)}.\n`);
    return true;
  }

  if (cmd === "/browser") {
    const sub = (parts[1] || "status").toLowerCase();
    if (sub === "on" || sub === "enable") {
      ctx.agent.setAllowBrowser(true);
      configManager.set("allowBrowser", true);
      console.log(`${pc.green("[OK]")} Browser tools ${pc.cyan("ON")}.\n`);
      return true;
    }
    if (sub === "off" || sub === "disable") {
      ctx.agent.setAllowBrowser(false);
      configManager.set("allowBrowser", false);
      try {
        await executeTool("browser_close", {}, { workingDirectory: ctx.agent.getWorkingDirectory() });
      } catch {
      }
      console.log(`${pc.green("[OK]")} Browser tools ${pc.yellow("OFF")}.\n`);
      return true;
    }
    if (sub === "close") {
      const res = await executeTool("browser_close", {}, { workingDirectory: ctx.agent.getWorkingDirectory() });
      console.log(`${pc.green("[OK]")} ${res.output}\n`);
      return true;
    }
    const enabled = ctx.agent.getAllowBrowser();
    console.log(`${pc.dim("Browser Toggle:")} ${enabled ? pc.green("ON") : pc.yellow("OFF")}`);
    if (!enabled) {
      console.log(`Use ${pc.cyan("/browser on")} to enable browser automation tools.\n`);
      return true;
    }
    const res = await executeTool("browser_extract", {}, { workingDirectory: ctx.agent.getWorkingDirectory() });
    if (res.success) {
      console.log(`${pc.green("[OK]")} Active browser session:\n${res.output.slice(0, 600)}\n`);
    } else {
      console.log(pc.dim("No active browser session. Ask the AI to open a URL or use browser_open.\n"));
    }
    return true;
  }

  if (cmd === "/cd") {
    const targetDir = parts.slice(1).join(" ").trim();
    if (!targetDir) {
      console.log(`${pc.dim("Current directory:")} ${ctx.agent.getWorkingDirectory()}\n`);
      return true;
    }
    const resolved = resolve(ctx.agent.getWorkingDirectory(), targetDir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      console.log(`${pc.red("Error:")} Directory not found: ${resolved}\n`);
      return true;
    }
    ctx.agent.setWorkingDirectory(resolved);
    console.log(`${pc.green("[OK]")} Workspace changed to ${pc.cyan(resolved)}\n`);
    return true;
  }

  if (cmd === "/compact") {
    const { before, after } = ctx.agent.compactNow();
    console.log(`${pc.green("[OK]")} Context compacted (${before} -> ${after} messages).\n`);
    return true;
  }

  if (cmd === "/sessions") {
    const sessions = listSessions(15);
    if (sessions.length === 0) {
      console.log(pc.dim("\nNo saved sessions found yet.\n"));
      return true;
    }
    console.log(`\n${pc.bold("Saved Sessions:")}`);
    for (const s of sessions) {
      const active = s.id === ctx.sessionId ? pc.green(" (current)") : "";
      console.log(`  ${pc.cyan(s.id)} ${pc.dim(`[${s.provider}/${s.model}]`)} ${s.title}${active}`);
    }
    console.log(`\n  Use ${pc.cyan("/resume <id>")} to load a session.\n`);
    return true;
  }

  if (cmd === "/resume") {
    const targetId = parts[1];
    if (!targetId) {
      console.log(`Usage: ${pc.cyan("/resume <sessionId>")}. Run ${pc.cyan("/sessions")} to list IDs.\n`);
      return true;
    }
    const loaded = loadSession(targetId);
    if (!loaded) {
      console.log(`${pc.red("Error:")} Session '${targetId}' not found.\n`);
      return true;
    }
    ctx.setSessionId(loaded.id);
    ctx.agent.loadMessages(loaded.messages);
    console.log(`${pc.green("[OK]")} Resumed session ${pc.cyan(loaded.id)} (${loaded.messages.length} messages).\n`);
    return true;
  }

  if (cmd === "/status") {
    const cfg = configManager.get();
    const stats = ctx.agent.getStats();
    console.log(`\n${pc.bold("Session Status:")}`);
    console.log(`  Session ID:   ${pc.cyan(ctx.sessionId)}`);
    console.log(`  Provider:     ${pc.cyan(`${cfg.provider}/${cfg.model}`)} ${ctx.agent.hasProvider() ? pc.green("(ready)") : pc.yellow("(unconfigured)")}`);
    console.log(`  Mode:         ${pc.cyan(ctx.agent.getToolMode())} ${pc.dim("|")} Browser: ${ctx.agent.getAllowBrowser() ? pc.green("ON") : pc.yellow("OFF")}`);
    console.log(`  Workspace:    ${pc.dim(ctx.agent.getWorkingDirectory())}`);
    console.log(`  History:      ${stats.turns} turns, ${stats.toolCalls} tool calls, ${stats.messageCount} messages`);
    console.log(`  Agent Rules:  ${stats.ruleCount} active rule(s)\n`);
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
    console.log(`${pc.green("[OK]")} Saved session ${pc.cyan(ctx.sessionId)}\n`);
    return true;
  }

  console.log(`${pc.yellow("[WARN]")} Unknown command '${cmd}'. Type ${pc.cyan("/help")} for available commands.\n`);
  return true;
}
