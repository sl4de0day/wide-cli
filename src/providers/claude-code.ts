import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configManager } from "../config/index.js";
import { executeTool } from "../tools/index.js";
import type { ToolDefinition } from "../tools/types.js";
import type { ChatMessage, LLMProvider, ProviderEvent, ProviderResponse } from "./types.js";

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
  email: string;
  subscriptionType: string;
}

export const CLI_NATIVE_OVERLAP_TOOLS = new Set<string>([
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "create_dir",
  "list_dir",
  "search_files",
  "run_command",
]);

export function filterCliToolsForClaudeMcp(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => !CLI_NATIVE_OVERLAP_TOOLS.has(t.name));
}

export function parseClaudeAuthJson(stdout: string): ClaudeAuthStatus | null {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const loggedIn =
    typeof rec.loggedIn === "boolean"
      ? rec.loggedIn
      : typeof rec.logged_in === "boolean"
        ? rec.logged_in
        : false;
  return {
    loggedIn,
    authMethod: String(rec.authMethod ?? rec.auth_method ?? "").trim(),
    apiProvider: String(rec.apiProvider ?? rec.api_provider ?? "").trim(),
    email: String(rec.email ?? "").trim(),
    subscriptionType: String(rec.subscriptionType ?? rec.subscription_type ?? "").trim(),
  };
}

function sanitizedClaudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  return env;
}

async function whereExecutable(cmd: string): Promise<string> {
  const tool = process.platform === "win32" ? "where.exe" : "which";
  return await new Promise((resolvePath) => {
    let done = false;
    const finish = (val: string) => {
      if (done) return;
      done = true;
      resolvePath(val);
    };
    try {
      const child = spawn(tool, [cmd], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish("");
      }, 3000);
      let stdout = "";
      child.stdout.on("data", (c) => {
        stdout += c.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish("");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          finish("");
          return;
        }
        const lines = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (process.platform === "win32") {
          finish(
            lines.find((l) => /\.(cmd|exe)$/i.test(l)) ||
              lines.find((l) => /\.(js|mjs|cjs)$/i.test(l)) ||
              lines[0] ||
              "",
          );
        } else {
          finish(lines[0] || "");
        }
      });
    } catch {
      finish("");
    }
  });
}

export async function claudeCodeBinaryPath(): Promise<string> {
  const override = String(process.env.WIDE_CLAUDE_PATH || "").trim();
  if (override && existsSync(override)) return override;

  const home = homedir();
  const candidates =
    process.platform === "win32"
      ? [
          process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : "",
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.exe") : "",
          join(home, ".claude", "local", "claude.exe"),
          join(home, ".local", "bin", "claude.exe"),
        ]
      : [
          join(home, ".claude", "local", "claude"),
          join(home, ".local", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          "/usr/bin/claude",
        ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  const found = await whereExecutable(process.platform === "win32" ? "claude.cmd" : "claude");
  if (found && existsSync(found)) return found;
  if (process.platform === "win32") {
    const exe = await whereExecutable("claude.exe");
    if (exe && existsSync(exe)) return exe;
  }
  return "";
}

function resolveCmdShimScript(binPath: string): string {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(binPath)) return "";
  try {
    const content = readFileSync(binPath, "utf8");
    const match = /"%~dp0\\([^"\r\n]+\.(?:js|mjs|cjs))"/i.exec(content);
    if (!match) return "";
    const resolved = resolve(dirname(binPath), match[1]);
    if (existsSync(resolved)) return resolved;
  } catch {}
  return "";
}

function buildSpawnSpec(binPath: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (/\.(js|mjs|cjs)$/i.test(binPath)) {
    return { command: process.execPath, args: [binPath, ...args], shell: false };
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath)) {
    const script = resolveCmdShimScript(binPath);
    if (script) {
      return { command: process.execPath, args: [script, ...args], shell: false };
    }
    return { command: "cmd.exe", args: ["/d", "/c", binPath, ...args], shell: false };
  }
  return { command: binPath, args, shell: false };
}

export async function checkClaudeCodeAuth(binPath?: string): Promise<ClaudeAuthStatus | null> {
  const exe = binPath || (await claudeCodeBinaryPath());
  if (!exe) return null;
  const spec = buildSpawnSpec(exe, ["auth", "status", "--json"]);
  return await new Promise((resolveAuth) => {
    let settled = false;
    let stdout = "";
    const finish = (val: ClaudeAuthStatus | null) => {
      if (settled) return;
      settled = true;
      resolveAuth(val);
    };
    try {
      const child = spawn(spec.command, spec.args, {
        env: sanitizedClaudeEnv(),
        windowsHide: true,
        shell: spec.shell,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish(null);
      }, 6000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        finish(parseClaudeAuthJson(stdout));
      });
    } catch {
      finish(null);
    }
  });
}

function buildStdioMcpScriptSource(port: number, token: string): string {
  return [
    "'use strict';",
    "const http = require('node:http');",
    "const readline = require('node:readline');",
    `const PORT = ${JSON.stringify(port)};`,
    `const TOKEN = ${JSON.stringify(token)};`,
    "function req(method, path, body) {",
    "  return new Promise((resolve, reject) => {",
    "    const data = body === undefined ? null : JSON.stringify(body);",
    "    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: {",
    "      authorization: 'Bearer ' + TOKEN,",
    "      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),",
    "    }}, (res) => {",
    "      let raw = '';",
    "      res.on('data', (c) => { raw += c.toString('utf8'); });",
    "      res.on('end', () => {",
    "        try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }",
    "      });",
    "    });",
    "    r.on('error', reject);",
    "    if (data) r.write(data);",
    "    r.end();",
    "  });",
    "}",
    "function reply(id, result) {",
    "  if (id === undefined || id === null) return;",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
    "}",
    "function replyErr(id, code, message) {",
    "  if (id === undefined || id === null) return;",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n');",
    "}",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "rl.on('line', async (line) => {",
    "  const trimmed = line.trim();",
    "  if (!trimmed) return;",
    "  let msg;",
    "  try { msg = JSON.parse(trimmed); } catch { return; }",
    "  const { id, method, params } = msg;",
    "  if (method === 'initialize') {",
    "    reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wide', version: '1.0.0' } });",
    "    return;",
    "  }",
    "  if (method === 'notifications/initialized') return;",
    "  if (method === 'tools/list') {",
    "    try {",
    "      const data = await req('GET', '/tools');",
    "      reply(id, { tools: Array.isArray(data.tools) ? data.tools : [] });",
    "    } catch (e) {",
    "      replyErr(id, -32603, String(e && e.message || e));",
    "    }",
    "    return;",
    "  }",
    "  if (method === 'tools/call') {",
    "    try {",
    "      const name = String(params && params.name || '');",
    "      const args = (params && params.arguments) || {};",
    "      const data = await req('POST', '/tool', { name, arguments: args });",
    "      reply(id, { content: [{ type: 'text', text: String(data.result ?? '') }], isError: Boolean(data.isError) });",
    "    } catch (e) {",
    "      reply(id, { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true });",
    "    }",
    "    return;",
    "  }",
    "  replyErr(id, -32601, 'Method not found');",
    "});",
  ].join("\n");
}

export interface CliBridgeHandle {
  port: number;
  token: string;
  mcpUrl: string;
  close(): void;
}

export async function startCliToolBridge(getTools: () => ToolDefinition[]): Promise<CliBridgeHandle> {
  const token = randomBytes(18).toString("hex");
  const server: Server = createServer((req, res) => {
    if (String(req.headers.authorization || "") !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const reqPath = String(req.url || "/").split("?")[0];
    if (req.method === "GET" && reqPath === "/tools") {
      const specs = filterCliToolsForClaudeMcp(getTools()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters || { type: "object", properties: {} },
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: specs }));
      return;
    }
    if (req.method === "DELETE" && reqPath === "/mcp") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && reqPath === "/mcp") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      req.on("end", async () => {
        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(body || "{}") as Record<string, any>;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
          return;
        }
        const id = parsed.id;
        const method = String(parsed.method || "");
        const params = (parsed.params && typeof parsed.params === "object" ? parsed.params : {}) as Record<string, any>;
        if (id === undefined || id === null || method.startsWith("notifications/")) {
          res.writeHead(202);
          res.end();
          return;
        }
        if (method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: String(params.protocolVersion || "2025-03-26"),
                capabilities: { tools: {} },
                serverInfo: { name: "wide", version: "2.0.0" },
              },
            }),
          );
          return;
        }
        if (method === "ping") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
          return;
        }
        if (method === "tools/list") {
          const specs = filterCliToolsForClaudeMcp(getTools()).map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.parameters || { type: "object", properties: {} },
          }));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: specs } }));
          return;
        }
        if (method === "tools/call") {
          const name = String(params.name || "").trim();
          const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
          const allowed = filterCliToolsForClaudeMcp(getTools());
          if (!allowed.some((t) => t.name === name)) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Tool "${name}" is disabled or handled natively.` }],
                  isError: true,
                },
              }),
            );
            return;
          }
          try {
            const cfg = configManager.get();
            const out = await executeTool(name, args, {
              workingDirectory: process.cwd(),
              toolMode: cfg.toolMode || "full",
              allowBrowser: cfg.allowBrowser !== false,
              strictValidation: true,
              autoApproveRead: cfg.autoApproveRead,
              autoApproveWrite: cfg.autoApproveWrite,
              autoApproveRun: cfg.autoApproveRun,
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: String(out.output || out.error || "") }],
                  isError: !out.success,
                },
              }),
            );
          } catch (err: any) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: String(err?.message || err) }],
                  isError: true,
                },
              }),
            );
          }
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }));
      });
      return;
    }
    if (req.method === "POST" && reqPath === "/tool") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}") as { name?: string; arguments?: Record<string, any> };
          const name = String(parsed.name || "").trim();
          const args = parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {};
          const allowed = filterCliToolsForClaudeMcp(getTools());
          if (!allowed.some((t) => t.name === name)) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ result: `Tool "${name}" is disabled or handled natively by Claude Code.`, isError: true }));
            return;
          }
          const cfg = configManager.get();
          const out = await executeTool(name, args, {
            workingDirectory: process.cwd(),
            toolMode: cfg.toolMode || "full",
            allowBrowser: cfg.allowBrowser !== false,
            strictValidation: true,
            autoApproveRead: cfg.autoApproveRead,
            autoApproveWrite: cfg.autoApproveWrite,
            autoApproveRun: cfg.autoApproveRun,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ result: String(out.output || out.error || ""), isError: !out.success }));
        } catch (err: any) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ result: String(err?.message || err), isError: true }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return await new Promise((resolveBridge, rejectBridge) => {
    server.once("error", rejectBridge);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectBridge);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveBridge({
        port,
        token,
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        close: () => {
          try {
            server.close();
          } catch {}
        },
      });
    });
  });
}

export class ClaudeStreamAccumulator {
  private streamedText = "";
  private rootTextTotal = "";
  public sessionId = "";
  public isError = false;
  public resultText = "";

  resetTurn(): void {
    this.streamedText = "";
    this.rootTextTotal = "";
    this.isError = false;
    this.resultText = "";
  }

  getFullText(): string {
    return this.rootTextTotal || this.resultText;
  }

  feedLine(
    line: string,
    onChunk: (text: string) => void,
    onEvent?: (event: ProviderEvent) => void,
  ): { done: boolean; sessionNotFound: boolean } {
    const trimmed = line.trim();
    if (!trimmed) return { done: false, sessionNotFound: false };
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { done: false, sessionNotFound: false };
    }
    if (!obj || typeof obj !== "object") return { done: false, sessionNotFound: false };
    if (typeof obj.session_id === "string" && obj.session_id.trim()) {
      this.sessionId = obj.session_id.trim();
    }

    if (obj.type === "stream_event" && obj.event && !obj.parent_tool_use_id) {
      const ev = obj.event;
      if (ev.type === "message_start") {
        this.streamedText = "";
      } else if (ev.type === "content_block_start" && ev.content_block) {
        if (ev.content_block.type === "thinking") {
          onEvent?.({ type: "thinking", label: "Reasoning..." });
        } else if (ev.content_block.type === "tool_use" && ev.content_block.name) {
          onEvent?.({ type: "tool_start", label: String(ev.content_block.name) });
        }
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        this.streamedText += ev.delta.text;
        this.rootTextTotal += ev.delta.text;
        onChunk(ev.delta.text);
      }
      return { done: false, sessionNotFound: false };
    }

    if (obj.type === "assistant" && Array.isArray(obj.message?.content) && !obj.parent_tool_use_id) {
      let full = "";
      for (const b of obj.message.content) {
        if (b && b.type === "text" && typeof b.text === "string") {
          full += b.text;
        } else if (b && b.type === "tool_use" && b.name) {
          onEvent?.({ type: "tool_start", label: String(b.name) });
        }
      }
      if (full) {
        if (!this.streamedText) {
          this.rootTextTotal += full;
          onChunk(full);
        } else if (full.length > this.streamedText.length && full.startsWith(this.streamedText)) {
          const suffix = full.slice(this.streamedText.length);
          if (suffix) {
            this.rootTextTotal += suffix;
            onChunk(suffix);
          }
        }
      }
      this.streamedText = "";
      return { done: false, sessionNotFound: false };
    }

    if (obj.type === "user" && Array.isArray(obj.message?.content)) {
      for (const b of obj.message.content) {
        if (b && b.type === "tool_result") {
          onEvent?.({ type: "tool_end", label: "tool", success: !b.is_error });
        }
      }
      return { done: false, sessionNotFound: false };
    }

    if (obj.type === "result") {
      if (obj.usage && typeof obj.usage === "object") {
        onEvent?.({
          type: "usage",
          inputTokens: Number(obj.usage.input_tokens || 0),
          outputTokens: Number(obj.usage.output_tokens || 0),
        });
      }
      this.isError = Boolean(obj.is_error || String(obj.subtype || "").startsWith("error"));
      const rawErrors = Array.isArray(obj.errors) ? obj.errors.join("\n") : "";
      this.resultText = typeof obj.result === "string" && obj.result ? obj.result : rawErrors;
      if (!this.isError && !this.rootTextTotal && this.resultText) {
        this.rootTextTotal = this.resultText;
        onChunk(this.resultText);
      }
      const lower = this.resultText.toLowerCase();
      const sessionNotFound =
        this.isError &&
        (lower.includes("no conversation found") ||
          lower.includes("could not resume") ||
          (lower.includes("session") && lower.includes("not found")));
      return { done: true, sessionNotFound };
    }

    return { done: false, sessionNotFound: false };
  }
}

export class ClaudeCodeProvider implements LLMProvider {
  public name = "claude-code";
  public model: string;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private bridge: CliBridgeHandle | null = null;
  private tempFiles: string[] = [];
  private activeTools: ToolDefinition[] = [];
  private claudeSessionId = "";
  private syncedMessageCount = 0;
  private workerSignature = "";
  private authVerified = false;
  private activeTurnFinish: ((res: { content: string; retryFresh?: boolean; error?: string }) => void) | null = null;
  private activeAccumulator = new ClaudeStreamAccumulator();
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
    for (const file of this.tempFiles) {
      try {
        unlinkSync(file);
      } catch {}
    }
    this.tempFiles = [];
  }

  private normalizeModelArg(): string {
    const clean = this.model.trim();
    if (!clean || clean.toLowerCase() === "default") return "";
    return clean;
  }

  private formatPriorHistory(messages: ChatMessage[], lastUserIdx: number): string {
    const lines: string[] = [];
    for (const msg of messages.slice(0, lastUserIdx)) {
      if (msg.role === "system" || !msg.content.trim()) continue;
      lines.push(`${msg.role === "assistant" ? "Assistant" : "User"}: ${msg.content.trim().slice(0, 2000)}`);
    }
    if (lines.length === 0) return "";
    return `[Previous conversation context]\n${lines.join("\n\n")}\n[End of previous context]\n\n`;
  }

  public async chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<ProviderResponse> {
    const binPath = await claudeCodeBinaryPath();
    if (!binPath) {
      throw new Error(
        "Claude Code CLI is not installed. Run 'npm install -g @anthropic-ai/claude-code' and 'claude auth login'.",
      );
    }

    if (!this.authVerified && !process.env.WIDE_CLAUDE_SKIP_AUTH_CHECK) {
      const auth = await checkClaudeCodeAuth(binPath);
      if (auth && !auth.loggedIn && !process.env.ANTHROPIC_API_KEY) {
        throw new Error("Claude Code is not signed in. Run 'claude auth login' in your terminal first.");
      }
      this.authVerified = true;
    }

    const systemMsg = messages.find((m) => m.role === "system")?.content || "";
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const lastUserText = lastUserIdx >= 0 ? messages[lastUserIdx].content : messages.map((m) => m.content).join("\n");

    const oneShotCompletion = tools.length === 0;
    if (oneShotCompletion) {
      return await this.runOneShot(binPath, systemMsg, lastUserText, onChunk, signal, onEvent);
    }

    const allowDiskWrites = tools.some((t) => t.name === "write_file" || t.name === "edit_file");
    const mcpTools = filterCliToolsForClaudeMcp(tools);
    const sig = JSON.stringify([this.normalizeModelArg(), allowDiskWrites, mcpTools.map((t) => t.name)]);

    if (messages.length <= this.syncedMessageCount && this.syncedMessageCount > 0) {
      this.dispose();
      this.claudeSessionId = "";
      this.syncedMessageCount = 0;
    }

    if (!this.proc || !this.proc.stdin.writable || this.workerSignature !== sig) { // wide-ignore wide/timing-secret-nonconst-eq
      this.dispose();
      this.activeTools = tools;
      const useResume = Boolean(this.claudeSessionId && this.syncedMessageCount > 0);
      await this.spawnPersistentWorker(binPath, sig, systemMsg, allowDiskWrites, mcpTools, useResume);
      const firstPrompt = useResume ? lastUserText : `${this.formatPriorHistory(messages, lastUserIdx)}${lastUserText}`;
      const res = await this.sendTurn(firstPrompt, onChunk, signal, onEvent);
      if (res.retryFresh) {
        this.dispose();
        this.claudeSessionId = "";
        this.syncedMessageCount = 0;
        await this.spawnPersistentWorker(binPath, sig, systemMsg, allowDiskWrites, mcpTools, false);
        const retryPrompt = `${this.formatPriorHistory(messages, lastUserIdx)}${lastUserText}`;
        const retryRes = await this.sendTurn(retryPrompt, onChunk, signal, onEvent);
        if (retryRes.error) throw new Error(retryRes.error);
        this.syncedMessageCount = messages.length;
        return { content: retryRes.content };
      }
      if (res.error) throw new Error(res.error);
      this.syncedMessageCount = messages.length;
      return { content: res.content };
    }

    this.activeTools = tools;
    const res = await this.sendTurn(lastUserText, onChunk, signal, onEvent);
    if (res.error) throw new Error(res.error);
    this.syncedMessageCount = messages.length;
    return { content: res.content };
  }

  private async spawnPersistentWorker(
    binPath: string,
    signature: string,
    systemPrompt: string,
    allowDiskWrites: boolean,
    mcpTools: ToolDefinition[],
    resume: boolean,
  ): Promise<void> {
    this.workerSignature = signature;
    if (!resume || !this.claudeSessionId) {
      this.claudeSessionId = randomUUID();
    }

    const dir = join(tmpdir(), "wide-cli-cc");
    mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;

    let mcpConfigPath = "";
    if (mcpTools.length > 0) {
      this.bridge = await startCliToolBridge(() => this.activeTools);
      const mcpScriptPath = join(dir, `mcp-${stamp}.cjs`);
      writeFileSync(mcpScriptPath, buildStdioMcpScriptSource(this.bridge.port, this.bridge.token), "utf8");
      this.tempFiles.push(mcpScriptPath);
      mcpConfigPath = join(dir, `mcp-${stamp}.json`);
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            wide: {
              command: process.execPath,
              args: [mcpScriptPath],
            },
          },
        }),
        "utf8",
      );
      this.tempFiles.push(mcpConfigPath);
    }

    let promptFilePath = "";
    const mcpHint =
      mcpTools.length > 0
        ? `Additional Wide CLI / Security / Browser / DB tools are attached on MCP server "wide": ${mcpTools.map((t) => t.name).join(", ")}.`
        : "";
    const fullSystem = [systemPrompt.trim(), mcpHint].filter(Boolean).join("\n\n");
    if (fullSystem) {
      promptFilePath = join(dir, `sys-${stamp}.txt`);
      writeFileSync(promptFilePath, fullSystem, "utf8");
      this.tempFiles.push(promptFilePath);
    }

    const cliArgs: string[] = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (resume) {
      cliArgs.push("--resume", this.claudeSessionId);
    } else {
      cliArgs.push("--session-id", this.claudeSessionId);
    }
    if (promptFilePath) {
      cliArgs.push("--append-system-prompt-file", promptFilePath);
    }
    if (mcpConfigPath) {
      cliArgs.push("--mcp-config", mcpConfigPath);
    }
    const modelArg = this.normalizeModelArg();
    if (modelArg) {
      cliArgs.push("--model", modelArg);
    }
    if (allowDiskWrites) {
      cliArgs.push("--permission-mode", "bypassPermissions");
    } else {
      cliArgs.push("--permission-mode", "bypassPermissions", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit");
    }

    const spec = buildSpawnSpec(binPath, cliArgs);
    this.proc = spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: sanitizedClaudeEnv(),
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
        if (this.activeAccumulator.sessionId) {
          this.claudeSessionId = this.activeAccumulator.sessionId;
        }
        if (done) {
          const finish = this.activeTurnFinish;
          this.activeTurnFinish = null;
          if (sessionNotFound) {
            finish({ content: "", retryFresh: true, error: this.activeAccumulator.resultText });
          } else if (this.activeAccumulator.isError) {
            finish({ content: "", error: this.activeAccumulator.resultText || "Claude Code execution failed." });
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
        const errText = this.activeStderr.join("").trim() || `Claude Code exited unexpectedly (code ${code ?? "unknown"}).`;
        const lower = errText.toLowerCase();
        finish({
          content: "",
          retryFresh: lower.includes("no conversation found") || (lower.includes("session") && lower.includes("not found")),
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
        resolveTurn({ content: "", error: "Claude Code worker process is not running." });
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
        type: "user",
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
    systemPrompt: string,
    userPrompt: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<ProviderResponse> {
    const cliArgs = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--no-session-persistence",
    ];
    const modelArg = this.normalizeModelArg();
    if (modelArg) {
      cliArgs.push("--model", modelArg);
    }

    let promptFile = "";
    if (systemPrompt.trim()) {
      const dir = join(tmpdir(), "wide-cli-cc");
      mkdirSync(dir, { recursive: true });
      promptFile = join(dir, `oneshot-${Date.now()}-${randomBytes(4).toString("hex")}.txt`);
      writeFileSync(promptFile, systemPrompt.trim(), "utf8");
      cliArgs.push("--append-system-prompt-file", promptFile);
    }

    const spec = buildSpawnSpec(binPath, cliArgs);
    return await new Promise((resolveShot, rejectShot) => {
      const acc = new ClaudeStreamAccumulator();
      let buf = "";
      let stderr = "";
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (promptFile) {
          try {
            unlinkSync(promptFile);
          } catch {}
        }
        if (err) rejectShot(err);
        else resolveShot({ content: acc.getFullText() });
      };

      const child = spawn(spec.command, spec.args, {
        cwd: process.cwd(),
        env: sanitizedClaudeEnv(),
        windowsHide: true,
        shell: spec.shell,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish(Object.assign(new Error("Aborted"), { name: "AbortError" }));
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
      child.on("error", (err) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        finish(err);
      });
      child.on("close", (code) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (buf.trim()) acc.feedLine(buf, onChunk, onEvent);
        if (acc.isError) {
          finish(new Error(acc.resultText || stderr.trim() || "Claude Code execution failed."));
          return;
        }
        if (code !== 0 && !acc.getFullText()) {
          finish(new Error(stderr.trim() || `Claude Code exited with code ${code}`));
          return;
        }
        finish();
      });

      try {
        child.stdin.write(userPrompt);
        child.stdin.end();
      } catch {}
    });
  }
}
