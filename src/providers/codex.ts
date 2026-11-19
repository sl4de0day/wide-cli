import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ToolDefinition } from "../tools/types.js";
import { filterCliToolsForClaudeMcp, startCliToolBridge, type CliBridgeHandle } from "./claude-code.js";
import type { ChatMessage, LLMProvider, ProviderResponse } from "./types.js";

const EFFORT_SUFFIX_RE = /^(.*?)-(minimal|low|medium|high|xhigh|max|ultra)$/i;
const CODEX_STRIPPED_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "CODEX_API_KEY",
]);
const CODEX_RPC_TIMEOUT_MS = 15000;

export interface CodexNotificationOutcome {
  done: boolean;
  sessionNotFound: boolean;
  isError: boolean;
  errorMessage?: string;
}

export function sanitizeCodexEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (CODEX_STRIPPED_ENV_KEYS.has(key.toUpperCase())) continue;
    out[key] = value;
  }
  return out;
}

export function parseCodexModelAndEffort(rawModel?: string): { model: string; effort?: string } {
  const clean = String(rawModel ?? "").trim();
  if (!clean || clean.toLowerCase() === "default") {
    return { model: "" };
  }
  const match = EFFORT_SUFFIX_RE.exec(clean);
  if (match && match[1]) {
    return {
      model: match[1],
      effort: match[2].toLowerCase(),
    };
  }
  return { model: clean };
}

export class CodexStreamAccumulator {
  public resultText = "";
  public isError = false;
  public errorMessage = "";
  private chunks: string[] = [];
  private streamedItems = new Set<string>();

  public resetTurn(): void {
    this.resultText = "";
    this.isError = false;
    this.errorMessage = "";
    this.chunks = [];
    this.streamedItems.clear();
  }

  public getFullText(): string {
    return this.chunks.join("") || this.resultText;
  }

  public feedNotification(
    method: string,
    params: Record<string, any> = {},
    onChunk: (chunk: string) => void = () => {},
  ): CodexNotificationOutcome {
    if (method === "item/agentMessage/delta") {
      const itemId = String(params.itemId ?? "");
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (itemId) this.streamedItems.add(itemId);
      if (delta) {
        this.chunks.push(delta);
        onChunk(delta);
      }
      return { done: false, sessionNotFound: false, isError: false };
    }

    if (method === "item/completed") {
      const item = params.item && typeof params.item === "object" ? params.item : null;
      if (item && item.type === "agentMessage") {
        const itemId = String(item.id ?? "");
        const text = typeof item.text === "string" ? item.text : "";
        if (text && (!itemId || !this.streamedItems.has(itemId))) {
          this.chunks.push(text);
          onChunk(text);
        }
        if (text) {
          this.resultText = text;
        }
      }
      return { done: false, sessionNotFound: false, isError: false };
    }

    if (method === "turn/completed") {
      const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
      const status = String(turn.status ?? "completed").toLowerCase();
      if (status === "failed") {
        const err = turn.error && typeof turn.error === "object" ? turn.error : {};
        const msg =
          String(err.message || err.additionalDetails || "Codex turn failed.").trim() ||
          "Codex turn failed.";
        this.isError = true;
        this.errorMessage = msg;
        const lower = msg.toLowerCase();
        const sessionNotFound =
          lower.includes("thread not found") ||
          lower.includes("no rollout found") ||
          (lower.includes("thread") && lower.includes("not found")) ||
          (lower.includes("session") && lower.includes("not found"));
        return { done: true, sessionNotFound, isError: true, errorMessage: msg };
      }
      return { done: true, sessionNotFound: false, isError: false };
    }

    if (method === "error") {
      const err = params.error && typeof params.error === "object" ? params.error : {};
      const msg =
        String(err.message || params.message || "Codex CLI error.").trim() || "Codex CLI error.";
      this.isError = true;
      this.errorMessage = msg;
      const lower = msg.toLowerCase();
      const sessionNotFound =
        lower.includes("thread not found") ||
        lower.includes("no rollout found") ||
        (lower.includes("thread") && lower.includes("not found")) ||
        (lower.includes("session") && lower.includes("not found"));
      return { done: true, sessionNotFound, isError: true, errorMessage: msg };
    }

    return { done: false, sessionNotFound: false, isError: false };
  }
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
        const preferred =
          lines.find((line) => /\.(cmd|exe)$/i.test(line)) ||
          lines.find((line) => /\.(js|mjs|cjs)$/i.test(line));
        return resolveLocate(preferred || lines[0]);
      }
      return resolveLocate(lines[0]);
    });
  });
}

export async function codexBinaryPath(): Promise<string> {
  const override = String(process.env.WIDE_CODEX_PATH ?? "").trim();
  if (override) {
    try {
      if (statSync(override).isFile()) return override;
    } catch {}
  }

  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [
          process.env.APPDATA ? join(process.env.APPDATA, "npm", "codex.cmd") : "",
          process.env.APPDATA ? join(process.env.APPDATA, "npm", "codex.exe") : "",
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "codex", "codex.exe") : "",
          join(home, ".codex", "bin", "codex.exe"),
          join(home, ".local", "bin", "codex.exe"),
        ]
      : [
          join(home, ".local", "bin", "codex"),
          join(home, ".codex", "bin", "codex"),
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          "/usr/bin/codex",
        ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }

  const found = await whereExecutable(process.platform === "win32" ? "codex.cmd" : "codex");
  if (found && existsSync(found)) return found;
  if (process.platform === "win32") {
    const exeFound = await whereExecutable("codex.exe");
    if (exeFound && existsSync(exeFound)) return exeFound;
  }
  return "";
}

function resolveCmdShim(binPath: string): string {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(binPath)) return "";
  try {
    const raw = readFileSync(binPath, "utf8");
    const match = /"%~dp0\\([^"\r\n]+\.(?:js|mjs|cjs))"/i.exec(raw);
    if (!match) return "";
    const target = resolve(dirname(binPath), match[1]);
    if (existsSync(target)) return target;
  } catch {}
  return "";
}

function buildSpawnSpec(binPath: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (/\.(js|mjs|cjs)$/i.test(binPath)) {
    return { command: process.execPath, args: [binPath, ...args], shell: false };
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath)) {
    const script = resolveCmdShim(binPath);
    if (script) {
      return { command: process.execPath, args: [script, ...args], shell: false };
    }
    return { command: "cmd.exe", args: ["/d", "/c", binPath, ...args], shell: false };
  }
  return { command: binPath, args, shell: false };
}

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexProvider implements LLMProvider {
  public name = "codex";
  public model: string;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private bridge: CliBridgeHandle | null = null;
  private activeTools: ToolDefinition[] = [];
  private threadId = "";
  private syncedMessageCount = 0;
  private workerSignature = "";
  private nextRpcId = 1;
  private pendingRpc = new Map<number, PendingRpc>();
  private stdoutBuf = "";
  private activeStderr: string[] = [];
  private activeAccumulator = new CodexStreamAccumulator();
  private activeChunkCb: (chunk: string) => void = () => {};
  private activeTurnFinish: ((res: { content: string; retryFresh?: boolean; error?: string }) => void) | null = null;

  constructor(model = "default") {
    this.model = model || "default";
  }

  public dispose(): void {
    for (const entry of this.pendingRpc.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Codex worker disposed."));
    }
    this.pendingRpc.clear();
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

  private formatPrompt(
    systemPrompt: string,
    messages: ChatMessage[],
    lastUserIdx: number,
    includeHistory: boolean,
  ): string {
    const sections: string[] = [];
    if (includeHistory && systemPrompt.trim()) {
      sections.push(systemPrompt.trim());
    }
    if (includeHistory && lastUserIdx > 0) {
      const historyLines: string[] = [];
      for (const msg of messages.slice(0, lastUserIdx)) {
        if (msg.role === "system" || !msg.content.trim()) continue;
        historyLines.push(
          `${msg.role === "assistant" ? "Assistant" : "User"}: ${msg.content.trim().slice(0, 2000)}`,
        );
      }
      if (historyLines.length > 0) {
        sections.push(`[Previous conversation context]\n${historyLines.join("\n\n")}\n[End of previous context]`);
      }
    }
    const lastUserText = lastUserIdx >= 0 ? messages[lastUserIdx].content : messages.map((m) => m.content).join("\n");
    sections.push(lastUserText);
    return sections.join("\n\n");
  }

  private rpcWrite(payload: Record<string, unknown>, proc: ChildProcessWithoutNullStreams | null = this.proc): void {
    if (!proc || !proc.stdin.writable) {
      throw new Error("Codex worker stdin is closed.");
    }
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rpcCall(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = CODEX_RPC_TIMEOUT_MS,
  ): Promise<any> {
    const id = this.nextRpcId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        rejectCall(new Error(`Codex RPC '${method}' timed out.`));
      }, timeoutMs);
      this.pendingRpc.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try {
        this.rpcWrite({ jsonrpc: "2.0", id, method, params });
      } catch (err: any) {
        this.pendingRpc.delete(id);
        clearTimeout(timer);
        rejectCall(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private spawnWorker(binPath: string, sig: string, allowDiskWrites: boolean): void {
    this.workerSignature = sig;
    this.stdoutBuf = "";
    const cliArgs = ["app-server", "--listen", "stdio://"];
    if (this.bridge) {
      cliArgs.push(
        "-c",
        `mcp_servers.wide.url="${this.bridge.mcpUrl}"`,
        "-c",
        `mcp_servers.wide.bearer_token_env_var="WIDE_CODEX_MCP_TOKEN"`,
      );
    }
    const spec = buildSpawnSpec(binPath, cliArgs);
    const workerEnv = {
      ...sanitizeCodexEnv(process.env),
      ...(this.bridge ? { WIDE_CODEX_MCP_TOKEN: this.bridge.token } : {}),
    };
    this.proc = spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: workerEnv,
      windowsHide: true,
      shell: spec.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const handleLine = (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(trimmed) as Record<string, any>;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.id !== undefined && msg.id !== null && typeof msg.method !== "string") {
        const entry = this.pendingRpc.get(Number(msg.id));
        if (!entry) return;
        this.pendingRpc.delete(Number(msg.id));
        clearTimeout(entry.timer);
        if (msg.error) {
          const errMsg =
            typeof msg.error === "object" ? msg.error.message || JSON.stringify(msg.error) : String(msg.error);
          entry.reject(new Error(errMsg));
        } else {
          entry.resolve(msg.result ?? {});
        }
        return;
      }

      if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
        try {
          this.rpcWrite({
            jsonrpc: "2.0",
            id: msg.id,
            result: msg.method.includes("requestApproval")
              ? { decision: allowDiskWrites ? "accept" : "decline" }
              : {},
          });
        } catch {}
        return;
      }

      if (typeof msg.method === "string" && this.activeTurnFinish) {
        const outcome = this.activeAccumulator.feedNotification(
          msg.method,
          (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, any>,
          this.activeChunkCb,
        );
        if (outcome.done) {
          const finish = this.activeTurnFinish;
          this.activeTurnFinish = null;
          if (outcome.sessionNotFound) {
            finish({ content: "", retryFresh: true, error: outcome.errorMessage });
          } else if (outcome.isError) {
            finish({ content: "", error: outcome.errorMessage || "Codex CLI execution failed." });
          } else {
            finish({ content: this.activeAccumulator.getFullText() });
          }
        }
      }
    };

    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBuf += chunk.toString("utf8");
      const lines = this.stdoutBuf.split(/\r?\n/);
      this.stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) handleLine(line);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      this.activeStderr.push(chunk.toString("utf8"));
    });

    this.proc.on("close", (code) => {
      if (this.stdoutBuf.trim()) {
        handleLine(this.stdoutBuf);
        this.stdoutBuf = "";
      }
      for (const entry of this.pendingRpc.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Codex exited unexpectedly (code ${code ?? "unknown"}).`));
      }
      this.pendingRpc.clear();
      if (this.activeTurnFinish) {
        const finish = this.activeTurnFinish;
        this.activeTurnFinish = null;
        const errText =
          this.activeStderr.join("").trim() || `Codex exited unexpectedly (code ${code ?? "unknown"}).`;
        const lower = errText.toLowerCase();
        finish({
          content: "",
          retryFresh:
            lower.includes("thread not found") ||
            lower.includes("no rollout found") ||
            (lower.includes("thread") && lower.includes("not found")) ||
            (lower.includes("session") && lower.includes("not found")),
          error: errText,
        });
      }
      this.proc = null;
    });
  }

  private async initializeWorkerAndThread(
    allowDiskWrites: boolean,
    systemPrompt: string,
    tryResumeId: string,
  ): Promise<{ usedResume: boolean }> {
    const { model } = parseCodexModelAndEffort(this.model);
    await this.rpcCall("initialize", {
      clientInfo: { name: "wide-cli", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.rpcWrite({ jsonrpc: "2.0", method: "initialized", params: {} });

    const accountRes = await this.rpcCall("account/read", { refreshToken: false });
    const accType = String(accountRes?.account?.type ?? "").trim();
    if (accType !== "chatgpt") {
      throw new Error("OpenAI Codex CLI is not signed in with a ChatGPT subscription. Run 'codex login' to sign in.");
    }

    const sandbox = allowDiskWrites ? "workspace-write" : "read-only";
    if (tryResumeId) {
      try {
        const resumed = await this.rpcCall("thread/resume", {
          threadId: tryResumeId,
          cwd: process.cwd(),
          ...(model ? { model } : {}),
          approvalPolicy: "never",
          sandbox,
        });
        this.threadId = String(resumed?.thread?.id || tryResumeId).trim();
        return { usedResume: true };
      } catch (err: any) {
        const lower = String(err?.message || err).toLowerCase();
        if (!lower.includes("not found") && !lower.includes("no rollout")) {
          throw err;
        }
      }
    }

    const mcpTools = filterCliToolsForClaudeMcp(this.activeTools);
    const mcpHint =
      mcpTools.length > 0
        ? `Additional Wide CLI / Security / Browser / DB tools are attached on MCP server "wide": ${mcpTools.map((t) => t.name).join(", ")}.`
        : "";
    const devInstructions = [systemPrompt.trim(), mcpHint].filter(Boolean).join("\n\n");

    const started = await this.rpcCall("thread/start", {
      cwd: process.cwd(),
      ...(model ? { model } : {}),
      approvalPolicy: "never",
      sandbox,
      ...(devInstructions ? { developerInstructions: devInstructions } : {}),
    });
    const newId = String(started?.thread?.id || "").trim();
    if (!newId) {
      throw new Error("Codex app-server did not return a thread ID.");
    }
    this.threadId = newId;
    return { usedResume: false };
  }

  private sendTurn(
    promptText: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<{ content: string; retryFresh?: boolean; error?: string }> {
    const { model, effort } = parseCodexModelAndEffort(this.model);
    return new Promise((resolveTurn) => {
      if (!this.proc || !this.proc.stdin.writable || !this.threadId) {
        resolveTurn({ content: "", error: "Codex worker process is not running." });
        return;
      }

      this.activeAccumulator.resetTurn();
      this.activeChunkCb = onChunk;
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

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.activeTurnFinish = (res) => {
        cleanup();
        resolveTurn(res);
      };

      this.rpcCall("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: promptText || "Continue.", text_elements: [] }],
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        cwd: process.cwd(),
        approvalPolicy: "never",
      }).catch((err: any) => {
        if (this.activeTurnFinish) {
          const finish = this.activeTurnFinish;
          this.activeTurnFinish = null;
          const msg = String(err?.message || err);
          const lower = msg.toLowerCase();
          finish({
            content: "",
            retryFresh: lower.includes("not found") || lower.includes("no rollout"),
            error: msg,
          });
        }
      });
    });
  }

  private async runOneShot(
    binPath: string,
    promptText: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const spec = buildSpawnSpec(binPath, ["app-server", "--listen", "stdio://"]);
    const { model, effort } = parseCodexModelAndEffort(this.model);
    const pending = new Map<number, PendingRpc>();
    let rpcSeq = 1;
    let buf = "";
    let stderr = "";
    let settled = false;

    const child = spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: sanitizeCodexEnv(process.env),
      windowsHide: true,
      shell: spec.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const acc = new CodexStreamAccumulator();

    return await new Promise((resolveShot, rejectShot) => {
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(err || new Error("Codex closed"));
        }
        pending.clear();
        try {
          child.stdin.end();
        } catch {}
        try {
          child.kill("SIGKILL");
        } catch {}
        if (err) return rejectShot(err);
        if (acc.isError) return rejectShot(new Error(acc.errorMessage || "Codex CLI execution failed."));
        return resolveShot({ content: acc.getFullText() });
      };

      const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        const id = rpcSeq++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`Codex RPC '${method}' timed out.`));
          }, CODEX_RPC_TIMEOUT_MS);
          pending.set(id, { resolve: res, reject: rej, timer });
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      };

      const onAbort = () => finish(new Error("Aborted"));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const handleLine = (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return;
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(trimmed) as Record<string, any>;
        } catch {
          return;
        }
        if (msg.id !== undefined && msg.id !== null && typeof msg.method !== "string") {
          const entry = pending.get(Number(msg.id));
          if (!entry) return;
          pending.delete(Number(msg.id));
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            entry.resolve(msg.result ?? {});
          }
          return;
        }
        if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { decision: "decline" } })}\n`);
          return;
        }
        if (typeof msg.method === "string") {
          const out = acc.feedNotification(
            msg.method,
            (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, any>,
            onChunk,
          );
          if (out.done) finish();
        }
      };

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) handleLine(line);
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => finish(err));
      child.on("close", (code) => {
        if (buf.trim()) handleLine(buf);
        if (!settled) {
          finish(new Error(stderr.trim() || `Codex exited with code ${code ?? "unknown"}`));
        }
      });

      (async () => {
        await call("initialize", {
          clientInfo: { name: "wide-cli", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        const accountRes = await call("account/read", { refreshToken: false });
        if (String(accountRes?.account?.type ?? "").trim() !== "chatgpt") {
          throw new Error("OpenAI Codex CLI is not signed in with a ChatGPT subscription. Run 'codex login' to sign in.");
        }
        const started = await call("thread/start", {
          cwd: process.cwd(),
          ...(model ? { model } : {}),
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
        });
        const threadId = String(started?.thread?.id || "").trim();
        if (!threadId) throw new Error("Codex app-server did not return a thread ID.");
        await call("turn/start", {
          threadId,
          input: [{ type: "text", text: promptText || "Continue.", text_elements: [] }],
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          cwd: process.cwd(),
          approvalPolicy: "never",
        });
      })().catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  }

  public async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const binPath = await codexBinaryPath();
    if (!binPath) {
      throw new Error("OpenAI Codex CLI is not installed. Run 'npm install -g @openai/codex' and 'codex login' to sign in.");
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
      return await this.runOneShot(binPath, promptText, onChunk, signal);
    }

    const allowDiskWrites = tools.some((t) => t.name === "write_file" || t.name === "edit_file");
    this.activeTools = tools;
    const mcpTools = filterCliToolsForClaudeMcp(tools);
    const sig = JSON.stringify([this.model.trim(), allowDiskWrites, mcpTools.map((t) => t.name)]);

    if (messages.length <= this.syncedMessageCount && this.syncedMessageCount > 0) {
      this.dispose();
      this.threadId = "";
      this.syncedMessageCount = 0;
    }

    if (!this.proc || !this.proc.stdin.writable || this.workerSignature !== sig) {
      this.dispose();
      const useResume = Boolean(this.threadId && this.syncedMessageCount > 0);
      if (mcpTools.length > 0) {
        this.bridge = await startCliToolBridge(() => this.activeTools);
      }
      this.spawnWorker(binPath, sig, allowDiskWrites);
      const { usedResume } = await this.initializeWorkerAndThread(
        allowDiskWrites,
        systemMsg,
        useResume ? this.threadId : "",
      );
      const firstPrompt = this.formatPrompt(systemMsg, messages, lastUserIdx, !usedResume);
      const res = await this.sendTurn(firstPrompt, onChunk, signal);
      if (res.retryFresh) {
        this.dispose();
        this.threadId = "";
        this.syncedMessageCount = 0;
        if (mcpTools.length > 0) {
          this.bridge = await startCliToolBridge(() => this.activeTools);
        }
        this.spawnWorker(binPath, sig, allowDiskWrites);
        await this.initializeWorkerAndThread(allowDiskWrites, systemMsg, "");
        const retryPrompt = this.formatPrompt(systemMsg, messages, lastUserIdx, true);
        const retryRes = await this.sendTurn(retryPrompt, onChunk, signal);
        if (retryRes.error) throw new Error(retryRes.error);
        this.syncedMessageCount = messages.length + 1;
        return { content: retryRes.content };
      }
      if (res.error) throw new Error(res.error);
      this.syncedMessageCount = messages.length + 1;
      return { content: res.content };
    }

    const nextPrompt = lastUserIdx >= 0 ? messages[lastUserIdx].content : messages.map((m) => m.content).join("\n");
    const res = await this.sendTurn(nextPrompt, onChunk, signal);
    if (res.retryFresh) {
      this.dispose();
      this.threadId = "";
      this.syncedMessageCount = 0;
      this.spawnWorker(binPath, sig, allowDiskWrites);
      await this.initializeWorkerAndThread(allowDiskWrites, systemMsg, "");
      const retryPrompt = this.formatPrompt(systemMsg, messages, lastUserIdx, true);
      const retryRes = await this.sendTurn(retryPrompt, onChunk, signal);
      if (retryRes.error) throw new Error(retryRes.error);
      this.syncedMessageCount = messages.length + 1;
      return { content: retryRes.content };
    }
    if (res.error) throw new Error(res.error);
    this.syncedMessageCount = messages.length + 1;
    return { content: res.content };
  }
}
