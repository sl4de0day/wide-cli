import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../tools/types.js";
import { filterCliToolsForClaudeMcp, startCliToolBridge, type CliBridgeHandle } from "./claude-code.js";
import type { ChatMessage, LLMProvider, ProviderEvent, ProviderResponse } from "./types.js";

const EFFORT_SUFFIX_RE = /^(.*?)-(low|medium|high|xhigh|max)$/i;

export interface AntigravityCliEventResult {
  done: boolean;
  sessionNotFound: boolean;
  conversationId?: string;
}

export class AntigravityStreamAccumulator {
  public conversationId = "";
  public resultText = "";
  public isError = false;
  private chunks: string[] = [];

  public resetTurn(): void {
    this.resultText = "";
    this.isError = false;
    this.chunks = [];
  }

  public getFullText(): string {
    return this.chunks.join("") || this.resultText;
  }

  public feedLine(
    line: string,
    onChunk: (chunk: string) => void,
    onEvent?: (event: ProviderEvent) => void,
  ): AntigravityCliEventResult {
    const trimmed = String(line ?? "").trim();
    if (!trimmed) {
      return { done: false, sessionNotFound: false };
    }
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(trimmed) as Record<string, any>;
    } catch {
      return { done: false, sessionNotFound: false };
    }
    if (!parsed || typeof parsed !== "object") {
      return { done: false, sessionNotFound: false };
    }

    const eventType = String(parsed.event ?? "");
    const cid = String(parsed.conversation_id ?? parsed.step_update?.conversation_id ?? parsed.result?.conversation_id ?? "").trim();
    if (cid) {
      this.conversationId = cid;
    }

    if (eventType === "init") {
      onEvent?.({ type: "status", label: "Connected to Antigravity" });
      return { done: false, sessionNotFound: false, ...(cid ? { conversationId: cid } : {}) };
    }

    if (eventType === "step_update") {
      const su = parsed.step_update;
      if (su && typeof su === "object") {
        if (su.step_type === "agent_response") {
          const delta = typeof su.text_delta === "string" ? su.text_delta : "";
          if (delta) {
            this.chunks.push(delta);
            onChunk(delta);
          }
        } else if (su.step_type === "thinking" || su.step_type === "thought" || su.step_type === "reasoning") {
          onEvent?.({ type: "thinking", label: "Reasoning..." });
        } else if (su.step_type) {
          const toolLabel = String(su.tool_name ?? su.name ?? su.step_type).replace(/_/g, " ");
          const status = String(su.status ?? "").toLowerCase();
          if (status === "done" || status === "completed" || status === "error" || status === "failed") {
            onEvent?.({ type: "tool_end", label: toolLabel, success: status !== "error" && status !== "failed" });
          } else {
            const detail = typeof su.summary === "string" ? su.summary : typeof su.path === "string" ? su.path : undefined;
            onEvent?.({ type: "tool_start", label: toolLabel, detail });
          }
        }
      }
      return { done: false, sessionNotFound: false };
    }

    if (eventType === "result") {
      const res = parsed.result && typeof parsed.result === "object" ? parsed.result : {};
      const status = String(res.status ?? "").toUpperCase();
      const errText = typeof res.error === "string" ? res.error : typeof res.message === "string" ? res.message : "";
      const responseText = typeof res.response === "string" ? res.response : "";
      this.isError = status === "ERROR" || Boolean(res.is_error) || Boolean(errText);
      this.resultText = this.isError ? (errText || responseText || "Antigravity CLI execution failed.") : responseText;
      if (!this.isError && this.chunks.length === 0 && responseText) {
        this.chunks.push(responseText);
        onChunk(responseText);
      }
      const lower = this.resultText.toLowerCase();
      const sessionNotFound =
        lower.includes("conversation not found") ||
        lower.includes("no conversation found") ||
        (lower.includes("session") && lower.includes("not found"));
      return {
        done: true,
        sessionNotFound,
        ...(cid ? { conversationId: cid } : {}),
      };
    }

    return { done: false, sessionNotFound: false };
  }
}

export function buildAntigravityCliArgs(opts: {
  conversationId?: string;
  model?: string;
  allowWrites?: boolean;
}): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  const convId = String(opts.conversationId ?? "").trim();
  if (convId) {
    args.push("--conversation", convId);
  }
  const cleanModel = String(opts.model ?? "").trim();
  if (cleanModel && cleanModel.toLowerCase() !== "default") {
    const match = EFFORT_SUFFIX_RE.exec(cleanModel);
    if (match) {
      args.push("--model", cleanModel, "--effort", match[2].toLowerCase());
    } else {
      args.push("--model", cleanModel);
    }
  }
  if (opts.allowWrites) {
    args.push("--mode", "accept-edits", "--dangerously-skip-permissions");
  } else {
    args.push("--mode", "plan");
  }
  args.push("--print=");
  return args;
}

function whereExecutable(name: string): Promise<string> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolveLocate) => {
    execFile(locator, [name], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolveLocate("");
      const lines = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) return resolveLocate("");
      if (process.platform === "win32") {
        const exe = lines.find((line) => /\.exe$/i.test(line)) || lines.find((line) => /\.(cmd|bat)$/i.test(line));
        return resolveLocate(exe || lines[0]);
      }
      return resolveLocate(lines[0]);
    });
  });
}

export interface AntigravityStatus {
  installed: boolean;
  signedIn: boolean;
  version: string;
  path: string;
  models: string[];
}

export async function antigravityBinaryPath(): Promise<string> {
  const override = String(process.env.WIDE_AGY_PATH ?? "").trim();
  if (override) {
    try {
      if (statSync(override).isFile()) return override;
    } catch {}
  }

  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : "",
          join(home, "AppData", "Local", "agy", "bin", "agy.exe"),
          join(home, ".agy", "bin", "agy.exe"),
          join(home, ".local", "bin", "agy.exe"),
          join(home, ".gemini", "bin", "agy.exe"),
          join(home, ".gemini", "antigravity", "bin", "agy.exe"),
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "agy", "agy.exe") : "",
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Antigravity", "bin", "agy.exe") : "",
          join(home, "AppData", "Local", "Programs", "agy", "agy.exe"),
          join(home, "AppData", "Local", "Programs", "Antigravity", "bin", "agy.exe"),
          process.env.APPDATA ? join(process.env.APPDATA, "npm", "agy.cmd") : "",
        ]
      : [
          join(home, ".local", "bin", "agy"),
          join(home, ".agy", "bin", "agy"),
          join(home, ".gemini", "bin", "agy"),
          "/usr/local/bin/agy",
          "/opt/homebrew/bin/agy",
          "/usr/bin/agy",
        ];

  for (const candidate of new Set(candidates)) {
    if (candidate && existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }

  const names = process.platform === "win32" ? ["agy", "agy.exe", "agy.cmd"] : ["agy"];
  for (const name of names) {
    const found = await whereExecutable(name);
    if (found && existsSync(found)) return found;
  }
  return "";
}

function buildSpawnSpec(binPath: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (/\.(js|mjs|cjs)$/i.test(binPath)) {
    return { command: process.execPath, args: [binPath, ...args], shell: false };
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath)) {
    return { command: "cmd.exe", args: ["/d", "/c", binPath, ...args], shell: false };
  }
  return { command: binPath, args, shell: false };
}

function execCapture(
  binPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  const spec = buildSpawnSpec(binPath, args);
  return new Promise((resolveCapture) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveCapture({ ok, stdout, stderr, timedOut });
    };
    try {
      const child = spawn(spec.command, spec.args, {
        windowsHide: true,
        shell: spec.shell,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {}
        finish(false);
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(!timedOut && code === 0);
      });
    } catch {
      finish(false);
    }
  });
}

export function parseAntigravityModelIds(stdout: string): string[] {
  const ids: string[] = [];
  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^fetching\b/i.test(trimmed)) continue;
    const id = String(trimmed.split(/\t+/)[0] ?? "").trim();
    if (!id || /\s/.test(id) || id.startsWith("-")) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function hasLocalAntigravityAuthFile(): boolean {
  const home = homedir();
  const candidates = [
    join(home, ".gemini", "antigravity", "antigravity_state.pbtxt"),
    join(home, ".gemini", "antigravity-cli", "jetski_state.pbtxt"),
  ];
  for (const candidate of candidates) {
    try {
      const st = statSync(candidate);
      if (st.isFile() && st.size > 0) return true;
    } catch {}
  }
  return false;
}

export async function checkAntigravityStatus(binPath?: string): Promise<AntigravityStatus> {
  const exe = binPath || (await antigravityBinaryPath());
  if (!exe) {
    return { installed: false, signedIn: false, version: "", path: "", models: [] };
  }
  const [verRes, modelsRes] = await Promise.all([
    execCapture(exe, ["--version"], 5000),
    execCapture(exe, ["models"], 15000),
  ]);
  const versionText = `${verRes.stdout}\n${verRes.stderr}`.trim();
  const versionMatch = /v?(\d+\.\d+(?:\.\d+)*)/i.exec(versionText);
  const version = versionMatch ? versionMatch[1] : versionText.split(/\r?\n/)[0]?.trim() || "";
  const models = parseAntigravityModelIds(modelsRes.stdout);
  const combinedErr = `${modelsRes.stdout}\n${modelsRes.stderr}`.toLowerCase();
  const isAuthError =
    !modelsRes.ok &&
    /(not\s+logged\s+in|not\s+authenticated|unauthenticated|sign\s+in|login\s+required|unauthorized|401)/i.test(
      combinedErr,
    );
  const signedIn = isAuthError
    ? false
    : modelsRes.ok && models.length > 0
      ? true
      : modelsRes.ok || modelsRes.timedOut
        ? hasLocalAntigravityAuthFile()
        : false;
  return {
    installed: true,
    signedIn,
    version,
    path: exe,
    models,
  };
}

export class AntigravityProvider implements LLMProvider {
  public name = "antigravity";
  public model: string;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private bridge: CliBridgeHandle | null = null;
  private activeTools: ToolDefinition[] = [];
  private conversationId = "";
  private syncedMessageCount = 0;
  private workerSignature = "";
  private activeTurnFinish: ((res: { content: string; retryFresh?: boolean; error?: string }) => void) | null = null;
  private activeAccumulator = new AntigravityStreamAccumulator();
  private activeChunkCb: (chunk: string) => void = () => {};
  private activeEventCb: ((event: ProviderEvent) => void) | undefined;
  private activeStderr: string[] = [];
  private stdoutBuf = "";

  constructor(model = "default") {
    this.model = model || "default";
  }

  public dispose(): void {
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {}
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      this.proc = null;
    }
    if (this.bridge) {
      this.bridge.close();
      this.bridge = null;
    }
  }

  private normalizeModelArg(): string {
    const clean = this.model.trim();
    if (!clean || clean.toLowerCase() === "default") return "";
    return clean;
  }

  private formatPrompt(systemPrompt: string, messages: ChatMessage[], lastUserIdx: number, includeHistory: boolean): string {
    const sections: string[] = [];
    if (includeHistory && systemPrompt.trim()) {
      sections.push(systemPrompt.trim());
    }
    if (includeHistory) {
      const mcpTools = filterCliToolsForClaudeMcp(this.activeTools);
      if (mcpTools.length > 0) {
        sections.push(
          `[Wide Security & CLI MCP Tools]\nThe 'wide' MCP server provides additional tools: ${mcpTools.map((t) => t.name).join(", ")}.`,
        );
      }
    }
    if (includeHistory && lastUserIdx > 0) {
      const historyLines: string[] = [];
      for (const msg of messages.slice(0, lastUserIdx)) {
        if (msg.role === "system" || !msg.content.trim()) continue;
        historyLines.push(`${msg.role === "assistant" ? "Assistant" : "User"}: ${msg.content.trim().slice(0, 2000)}`);
      }
      if (historyLines.length > 0) {
        sections.push(`[Previous conversation context]\n${historyLines.join("\n\n")}\n[End of previous context]`);
      }
    }
    const lastUserText = lastUserIdx >= 0 ? messages[lastUserIdx].content : messages.map((m) => m.content).join("\n");
    sections.push(lastUserText);
    return sections.join("\n\n");
  }

  public async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<ProviderResponse> {
    const binPath = await antigravityBinaryPath();
    if (!binPath) {
      throw new Error("Antigravity CLI is not installed. Install 'agy' and run 'agy' to sign in.");
    }

    const systemMsg = messages.find((m) => m.role === "system")?.content || "";
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    if (tools.length === 0) {
      const promptText = this.formatPrompt(systemMsg, messages, lastUserIdx, true);
      return await this.runOneShot(binPath, promptText, onChunk, signal, onEvent);
    }

    const allowDiskWrites = tools.some((t) => t.name === "write_file" || t.name === "edit_file");
    this.activeTools = tools;
    const mcpTools = filterCliToolsForClaudeMcp(tools);
    const sig = JSON.stringify([this.normalizeModelArg(), allowDiskWrites, mcpTools.map((t) => t.name)]);

    if (messages.length <= this.syncedMessageCount && this.syncedMessageCount > 0) {
      this.dispose();
      this.conversationId = "";
      this.syncedMessageCount = 0;
    }

    if (!this.proc || !this.proc.stdin.writable || this.workerSignature !== sig) { // wide-ignore wide/timing-secret-nonconst-eq
      this.dispose();
      const useResume = Boolean(this.conversationId && this.syncedMessageCount > 0);
      if (mcpTools.length > 0) {
        this.bridge = await startCliToolBridge(() => this.activeTools);
      }
      this.spawnWorker(binPath, sig, allowDiskWrites, useResume ? this.conversationId : "");
      const firstPrompt = this.formatPrompt(systemMsg, messages, lastUserIdx, !useResume);
      const res = await this.sendTurn(firstPrompt, onChunk, signal, onEvent);
      if (res.retryFresh) {
        this.dispose();
        this.conversationId = "";
        this.syncedMessageCount = 0;
        this.spawnWorker(binPath, sig, allowDiskWrites, "");
        const retryPrompt = this.formatPrompt(systemMsg, messages, lastUserIdx, true);
        const retryRes = await this.sendTurn(retryPrompt, onChunk, signal, onEvent);
        if (retryRes.error) throw new Error(retryRes.error);
        this.syncedMessageCount = messages.length + 1;
        return { content: retryRes.content };
      }
      if (res.error) throw new Error(res.error);
      this.syncedMessageCount = messages.length + 1;
      return { content: res.content };
    }

    const nextPrompt = lastUserIdx >= 0 ? messages[lastUserIdx].content : messages.map((m) => m.content).join("\n");
    const res = await this.sendTurn(nextPrompt, onChunk, signal, onEvent);
    if (res.retryFresh) {
      this.dispose();
      this.conversationId = "";
      this.syncedMessageCount = 0;
      this.spawnWorker(binPath, sig, allowDiskWrites, "");
      const retryPrompt = this.formatPrompt(systemMsg, messages, lastUserIdx, true);
      const retryRes = await this.sendTurn(retryPrompt, onChunk, signal, onEvent);
      if (retryRes.error) throw new Error(retryRes.error);
      this.syncedMessageCount = messages.length + 1;
      return { content: retryRes.content };
    }
    if (res.error) throw new Error(res.error);
    this.syncedMessageCount = messages.length + 1;
    return { content: res.content };
  }

  private spawnWorker(binPath: string, sig: string, allowDiskWrites: boolean, conversationId: string): void {
    this.workerSignature = sig;
    const args = buildAntigravityCliArgs({
      conversationId,
      model: this.normalizeModelArg(),
      allowWrites: allowDiskWrites,
    });
    const spec = buildSpawnSpec(binPath, args);
    this.proc = spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      windowsHide: true,
      shell: spec.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("error", (err) => {
      if (this.activeTurnFinish) {
        const finish = this.activeTurnFinish;
        this.activeTurnFinish = null;
        finish({ content: "", error: String(err?.message || err) });
      }
      this.proc = null;
    });
    this.stdoutBuf = "";

    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBuf += chunk.toString("utf8");
      const lines = this.stdoutBuf.split(/\r?\n/);
      this.stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!this.activeTurnFinish) continue;
        const { done, sessionNotFound } = this.activeAccumulator.feedLine(line, this.activeChunkCb, this.activeEventCb);
        if (this.activeAccumulator.conversationId) {
          this.conversationId = this.activeAccumulator.conversationId;
        }
        if (done) {
          const finish = this.activeTurnFinish;
          this.activeTurnFinish = null;
          if (sessionNotFound) {
            finish({ content: "", retryFresh: true, error: this.activeAccumulator.resultText });
          } else if (this.activeAccumulator.isError) {
            finish({ content: "", error: this.activeAccumulator.resultText || "Antigravity CLI execution failed." });
          } else {
            finish({ content: this.activeAccumulator.getFullText() });
          }
        }
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      this.activeStderr.push(chunk.toString("utf8"));
    });

    this.proc.on("close", (code) => {
      if (this.stdoutBuf.trim() && this.activeTurnFinish) {
        this.activeAccumulator.feedLine(this.stdoutBuf, this.activeChunkCb, this.activeEventCb);
        this.stdoutBuf = "";
      }
      if (this.activeTurnFinish) {
        const finish = this.activeTurnFinish;
        this.activeTurnFinish = null;
        const errText = this.activeStderr.join("").trim() || `Antigravity exited unexpectedly (code ${code ?? "unknown"}).`;
        const lower = errText.toLowerCase();
        finish({
          content: "",
          retryFresh:
            lower.includes("conversation not found") ||
            lower.includes("no conversation found") ||
            (lower.includes("session") && lower.includes("not found")),
          error: errText,
        });
      }
      this.proc = null;
    });
  }

  private sendTurn(
    promptText: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<{ content: string; retryFresh?: boolean; error?: string }> {
    return new Promise((resolveTurn) => {
      if (!this.proc || !this.proc.stdin.writable) {
        resolveTurn({ content: "", error: "Antigravity worker process is not running." });
        return;
      }

      this.activeAccumulator.resetTurn();
      this.activeChunkCb = onChunk;
      this.activeEventCb = onEvent;
      this.activeStderr = [];

      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        if (this.activeTurnFinish) {
          const finish = this.activeTurnFinish;
          this.activeTurnFinish = null;
          cleanup();
          this.dispose();
          finish({ content: "", error: "Aborted" });
        }
      };

      this.activeTurnFinish = (res) => {
        cleanup();
        resolveTurn(res);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const line = JSON.stringify({
        event: "user",
        message: { role: "user", content: promptText },
      });
      try {
        this.proc.stdin.write(`${line}\n`);
      } catch (err: any) {
        if (this.activeTurnFinish) {
          const finish = this.activeTurnFinish;
          this.activeTurnFinish = null;
          cleanup();
          finish({ content: "", error: String(err?.message || err) });
        }
      }
    });
  }

  private async runOneShot(
    binPath: string,
    promptText: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<ProviderResponse> {
    const cliArgs = buildAntigravityCliArgs({
      model: this.normalizeModelArg(),
      allowWrites: false,
    });
    const spec = buildSpawnSpec(binPath, cliArgs);

    return await new Promise((resolveShot, rejectShot) => {
      const acc = new AntigravityStreamAccumulator();
      let buf = "";
      let stderr = "";
      let settled = false;

      const child = spawn(spec.command, spec.args, {
        cwd: process.cwd(),
        windowsHide: true,
        shell: spec.shell,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err) return rejectShot(err);
        if (acc.isError) return rejectShot(new Error(acc.resultText || "Antigravity CLI execution failed."));
        return resolveShot({ content: acc.getFullText() });
      };

      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish(new Error("Aborted"));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          acc.feedLine(line, onChunk, onEvent);
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => finish(err));

      child.on("close", (code) => {
        if (buf.trim()) acc.feedLine(buf, onChunk, onEvent);
        if (code !== 0 && !acc.getFullText() && !acc.isError) {
          return finish(new Error(stderr.trim() || `Antigravity exited with code ${code ?? "unknown"}`));
        }
        finish();
      });

      const line = JSON.stringify({
        event: "user",
        message: { role: "user", content: promptText },
      });
      try {
        child.stdin.write(`${line}\n`);
        child.stdin.end();
      } catch {}
    });
  }
}
