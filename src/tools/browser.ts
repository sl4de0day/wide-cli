import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { extractArticleFromHtml, shouldBlockFastReadRequest } from "./article.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

export interface DOMElement {
  index: number;
  ref?: string;
  tag: string;
  text: string;
  role: string;
  href?: string;
  name?: string;
  value?: string;
  attributes: Record<string, string>;
}

export interface BrowserState {
  url: string;
  title: string;
  statusCode: number;
  elements: DOMElement[];
  textContent: string;
  rawHtml: string;
  formInputs: Record<string, string>;
  history: string[];
  mode?: "playwright" | "cdp" | "http";
  stealth?: boolean;
  lastScreenshotPath?: string;
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
}

const BROWSER_EMOJI_ZWJ_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u2600-\u27BF])(?:\uFE0F|\uFE0E|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u2600-\u27BF])(?:\uFE0F|\uFE0E|[\u{1F3FB}-\u{1F3FF}])?)+/gu;
const BROWSER_EMOJI_KEYCAP_RE = /[0-9#*]\uFE0F?\u20E3/gu;
const BROWSER_EMOJI_SUPP_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu;
const BROWSER_EMOJI_PICT_RE = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?/gu;
const BROWSER_EMOJI_PRES_RE = /\p{Emoji_Presentation}(?:\uFE0F|\uFE0E)?/gu;
const BROWSER_EMOJI_BMP_RE = /[\u231A-\u23FF\u2600-\u27BF\u2B05-\u2B55][\uFE0E\uFE0F]?|[\u2139\u2194-\u21AA\u24C2\u25AA-\u25FE\u2934-\u2935\u3030\u303D\u3297\u3299]\uFE0F|[\uFE0E\uFE0F\u200D\u20E3]/gu;

export function stripBrowserEmojis(text: string): string {
  return String(text ?? "")
    .replace(BROWSER_EMOJI_ZWJ_RE, "")
    .replace(BROWSER_EMOJI_KEYCAP_RE, "")
    .replace(BROWSER_EMOJI_SUPP_RE, "")
    .replace(BROWSER_EMOJI_PICT_RE, "")
    .replace(BROWSER_EMOJI_PRES_RE, "")
    .replace(BROWSER_EMOJI_BMP_RE, "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const HAR_SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
]);

function redactHarHeaders(headers: any): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h?.name) continue;
      const name = String(h.name);
      out.push({ name, value: HAR_SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : String(h.value ?? "") });
    }
    return out;
  }
  if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      out.push({ name, value: HAR_SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : String(value ?? "") });
    }
  }
  return out;
}

function parseHarQuery(urlStr: string): Array<{ name: string; value: string }> {
  try {
    const parsed = new URL(urlStr);
    const out: Array<{ name: string; value: string }> = [];
    for (const [name, value] of parsed.searchParams.entries()) {
      out.push({ name, value });
    }
    return out;
  } catch {
    return [];
  }
}

const CLI_STEALTH_INIT_SCRIPT = `(() => {
  try { Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true }); } catch {}
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true });
    }
  } catch {}
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
          { name: "Native Client", filename: "internal-nacl-plugin", description: "" }
        ],
        configurable: true
      });
    }
  } catch {}
  try {
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", { value: { runtime: {}, app: { isInstalled: false } }, configurable: true });
    }
  } catch {}
})();`;

interface CdpPending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

class NodeCdpWebSocket {
  public readyState = 0;
  private socket: net.Socket | null = null;
  private rxBuf: Buffer = Buffer.alloc(0);
  private fragOpcode = 0;
  private fragChunks: Buffer[] = [];
  private listeners: Record<string, Array<(ev: any) => void>> = {
    open: [],
    message: [],
    error: [],
    close: []
  };

  constructor(urlStr: string) {
    const u = new URL(urlStr);
    if (u.protocol !== "ws:") {
      queueMicrotask(() => this.failConnect(new Error(`Unsupported WebSocket scheme: ${u.protocol}`)));
      return;
    }
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port || 80),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers: {
        Host: u.host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13"
      }
    });

    req.on("upgrade", (res, socket, head) => {
      const accept = String(res.headers["sec-websocket-accept"] || "").trim();
      if (accept !== expectedAccept) {
        socket.destroy();
        this.failConnect(new Error("WebSocket handshake validation failed"));
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      this.readyState = 1;
      this.emit("open", {});

      socket.on("data", (chunk: Buffer) => {
        this.consume(chunk);
      });
      socket.on("error", (err) => {
        if (this.readyState !== 3) {
          this.emit("error", err);
        }
      });
      socket.on("close", () => {
        if (this.readyState !== 3) {
          this.readyState = 3;
          this.emit("close", {});
        }
      });

      if (head && head.length > 0) {
        this.consume(head);
      }
    });

    req.on("response", (res) => {
      res.resume();
      this.failConnect(new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}`));
    });

    req.on("error", (err) => {
      this.failConnect(err);
    });

    req.end();
  }

  public addEventListener(type: string, handler: (ev: any) => void): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(handler);
  }

  private emit(type: string, ev: any): void {
    const handlers = this.listeners[type];
    if (!handlers || handlers.length === 0) return;
    for (const fn of handlers.slice()) {
      try {
        fn(ev);
      } catch {
      }
    }
  }

  private failConnect(err: Error): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("error", err);
    this.emit("close", {});
  }

  public send(data: string): void {
    if (this.readyState !== 1 || !this.socket || this.socket.destroyed) {
      throw new Error("WebSocket is not open");
    }
    this.sendFrame(0x1, Buffer.from(String(data), "utf8"));
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (!this.socket || this.socket.destroyed) return;
    const len = payload.length;
    const hdrLen = len < 126 ? 2 : len <= 65535 ? 4 : 10;
    const frame = Buffer.allocUnsafe(hdrLen + 4 + len);
    frame[0] = 0x80 | (opcode & 0x0f);
    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len <= 65535) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    mask.copy(frame, hdrLen);
    const bodyOffset = hdrLen + 4;
    for (let i = 0; i < len; i++) {
      frame[bodyOffset + i] = payload[i] ^ mask[i & 3];
    }
    this.socket.write(frame);
  }

  private consume(chunk: Buffer): void {
    this.rxBuf = this.rxBuf.length > 0 ? Buffer.concat([this.rxBuf, chunk]) : chunk;
    while (this.rxBuf.length >= 2) {
      const b0 = this.rxBuf[0];
      const b1 = this.rxBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.rxBuf.length < offset + 2) break;
        len = this.rxBuf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.rxBuf.length < offset + 8) break;
        len = Number(this.rxBuf.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.rxBuf.length < offset + 4) break;
        maskKey = this.rxBuf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.rxBuf.length < offset + len) break;
      const payload = Buffer.from(this.rxBuf.subarray(offset, offset + len));
      this.rxBuf = this.rxBuf.subarray(offset + len);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x8) {
        if (this.readyState === 1) {
          this.readyState = 2;
          try {
            this.sendFrame(0x8, Buffer.alloc(0));
            this.socket?.end();
          } catch {
          }
        }
        this.readyState = 3;
        this.emit("close", {});
        return;
      }
      if (opcode === 0x9) {
        if (this.readyState === 1) {
          try {
            this.sendFrame(0xa, payload);
          } catch {
          }
        }
        continue;
      }
      if (opcode === 0xa) {
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        this.fragOpcode = opcode;
        this.fragChunks = [payload];
      } else if (opcode === 0x0) {
        this.fragChunks.push(payload);
      }

      if (fin && (opcode === 0x0 || opcode === 0x1 || opcode === 0x2)) {
        const full = this.fragChunks.length === 1 ? this.fragChunks[0] : Buffer.concat(this.fragChunks);
        this.fragChunks = [];
        if (this.fragOpcode === 0x1 || this.fragOpcode === 0x2) {
          this.emit("message", { data: full.toString("utf8") });
        }
      }
    }
  }

  public close(): void {
    if (this.readyState === 3) return;
    if (this.readyState === 1 && this.socket && !this.socket.destroyed) {
      this.readyState = 2;
      try {
        this.sendFrame(0x8, Buffer.alloc(0));
      } catch {
      }
    }
    this.readyState = 3;
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
    }
    this.emit("close", {});
  }
}

class NativeCdpSession {
  private proc: ChildProcess | null = null;
  private profileDir: string | null = null;
  private ws: any = null;
  private nextId = 1;
  private pending = new Map<number, CdpPending>();
  private eventListeners = new Map<string, Array<(params: any) => void>>();
  private networkRequests = new Map<string, any>();
  public harEntries: any[] = [];
  public consoleEntries: BrowserConsoleEntry[] = [];
  public lastStatusCode = 200;

  public async connect(executablePath: string, proxyUrl?: string, stealth = false): Promise<void> {
    const WS =
      typeof (globalThis as any).WebSocket === "function" && process.env.WIDE_CLI_FORCE_NODE_WS !== "1"
        ? (globalThis as any).WebSocket
        : NodeCdpWebSocket;

    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wide-cli-cdp-"));
    try {
      const args = [
        "--headless=new",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profileDir}`
      ];
      if (stealth) {
        args.push("--disable-blink-features=AutomationControlled");
      }
      if (proxyUrl) {
        args.push(`--proxy-server=${proxyUrl}`);
      }
      args.push("about:blank");

      const wsBaseUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
        let settled = false;
        let stderrBuf = "";
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            rejectPromise(new Error("Timed out waiting for browser DevTools endpoint"));
          }
        }, 15000);
        timer.unref?.();

        this.proc = spawn(executablePath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });

        this.proc.on("error", (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            rejectPromise(err);
          }
        });

        this.proc.on("exit", (code) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            rejectPromise(new Error(`Browser exited early (${code}): ${stderrBuf.slice(0, 300)}`));
          }
        });

        this.proc.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString("utf8");
          const m = /DevTools listening on (ws:\/\/[^\s]+)/i.exec(stderrBuf);
          if (m && !settled) {
            settled = true;
            clearTimeout(timer);
            resolvePromise(m[1]);
          }
        });
      });

      const parsed = new URL(wsBaseUrl);
      const httpBase = `http://${parsed.host}`;
      let pageWsUrl = "";

      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const res = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            const targets = (await res.json()) as any[];
            const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
            if (pageTarget?.webSocketDebuggerUrl) {
              pageWsUrl = pageTarget.webSocketDebuggerUrl;
              break;
            }
          }
        } catch {
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!pageWsUrl) {
        const created = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (created && created.ok) {
          const t = (await created.json()) as any;
          pageWsUrl = t?.webSocketDebuggerUrl || "";
        }
      }

      if (!pageWsUrl) {
        throw new Error("Could not acquire CDP page target");
      }

      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("CDP WebSocket connect timeout")), 10000);
        timer.unref?.();
        const ws = new WS(pageWsUrl);
        this.ws = ws;
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolvePromise();
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          rejectPromise(new Error("CDP WebSocket connection failed"));
        });
        ws.addEventListener("message", (ev: any) => {
          this.handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
        });
        ws.addEventListener("close", () => {
          for (const [, p] of this.pending) {
            p.reject(new Error("CDP connection closed"));
          }
          this.pending.clear();
        });
      });
    } catch (err) {
      await this.dispose();
      throw err;
    }

    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    if (stealth) {
      await this.send("Page.addScriptToEvaluateOnNewDocument", { source: CLI_STEALTH_INIT_SCRIPT }).catch(() => {});
    }
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });

    this.on("Runtime.consoleAPICalled", (params) => {
      const parts = Array.isArray(params?.args)
        ? params.args.map((a: any) => a?.value ?? a?.description ?? "").filter(Boolean)
        : [];
      this.consoleEntries.push({
        level: String(params?.type || "log"),
        text: parts.join(" "),
        timestamp: new Date().toISOString()
      });
      if (this.consoleEntries.length > 200) {
        this.consoleEntries.shift();
      }
    });

    this.on("Runtime.exceptionThrown", (params) => {
      const desc = params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text || "Runtime exception";
      this.consoleEntries.push({
        level: "error",
        text: String(desc),
        timestamp: new Date().toISOString()
      });
      if (this.consoleEntries.length > 200) {
        this.consoleEntries.shift();
      }
    });

    this.on("Network.requestWillBeSent", (params) => {
      if (!params?.requestId || !params?.request) return;
      this.networkRequests.set(params.requestId, {
        startedDateTime: params.wallTime ? new Date(params.wallTime * 1000).toISOString() : new Date().toISOString(),
        startTimestamp: Number(params.timestamp || 0),
        request: params.request,
        response: null,
        endTimestamp: Number(params.timestamp || 0),
      });
      if (this.networkRequests.size > 400) {
        const oldest = this.networkRequests.keys().next().value;
        if (oldest !== undefined) this.networkRequests.delete(oldest);
      }
    });

    this.on("Network.responseReceived", (params) => {
      if (params?.type === "Document" && typeof params?.response?.status === "number") {
        this.lastStatusCode = params.response.status;
      }
      const rec = params?.requestId ? this.networkRequests.get(params.requestId) : null;
      if (rec) {
        rec.response = params.response || null;
        rec.endTimestamp = Number(params.timestamp || rec.startTimestamp || 0);
      }
    });

    const finalizeHar = (requestId: string, endTimestamp: number, encodedLength: number, failedText = "") => {
      const rec = requestId ? this.networkRequests.get(requestId) : null;
      if (!rec) return;
      this.networkRequests.delete(requestId);
      const reqUrl = String(rec.request?.url || "");
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) return;
      const endTs = Number(endTimestamp || rec.endTimestamp || rec.startTimestamp || 0);
      const elapsedMs = rec.startTimestamp > 0 && endTs >= rec.startTimestamp ? Math.round((endTs - rec.startTimestamp) * 1000) : 0;
      const resp = rec.response || {};
      this.harEntries.push({
        pageref: "page_1",
        startedDateTime: rec.startedDateTime,
        time: elapsedMs,
        request: {
          method: String(rec.request?.method || "GET"),
          url: reqUrl,
          httpVersion: String(resp.protocol || "HTTP/1.1"),
          cookies: [],
          headers: redactHarHeaders(rec.request?.headers),
          queryString: parseHarQuery(reqUrl),
          headersSize: -1,
          bodySize: typeof rec.request?.postData === "string" ? Buffer.byteLength(rec.request.postData, "utf8") : 0,
        },
        response: {
          status: Number(resp.status || 0),
          statusText: failedText || String(resp.statusText || ""),
          httpVersion: String(resp.protocol || "HTTP/1.1"),
          cookies: [],
          headers: redactHarHeaders(resp.headers),
          content: {
            size: Number(encodedLength || resp.encodedDataLength || 0),
            mimeType: String(resp.mimeType || "x-unknown"),
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: Number(encodedLength || resp.encodedDataLength || 0),
        },
        cache: {},
        timings: { send: 0, wait: elapsedMs, receive: 0 },
      });
      if (this.harEntries.length > 500) {
        this.harEntries.splice(0, this.harEntries.length - 500);
      }
    };

    this.on("Network.loadingFinished", (params) => {
      finalizeHar(params?.requestId, params?.timestamp, params?.encodedDataLength, "");
    });

    this.on("Network.loadingFailed", (params) => {
      finalizeHar(params?.requestId, params?.timestamp, 0, params?.errorText || "Failed");
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method) {
      const list = this.eventListeners.get(msg.method);
      if (list) {
        for (const fn of list) {
          try {
            fn(msg.params);
          } catch {
          }
        }
      }
    }
  }

  public on(method: string, handler: (params: any) => void): () => void {
    const arr = this.eventListeners.get(method) || [];
    arr.push(handler);
    this.eventListeners.set(method, arr);
    return () => {
      const cur = this.eventListeners.get(method) || [];
      this.eventListeners.set(method, cur.filter((f) => f !== handler));
    };
  }

  public send(method: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<any> {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error("CDP session is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolvePromise(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  public async evalValue(expression: string): Promise<any> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Evaluation failed";
      throw new Error(String(msg));
    }
    return res?.result?.value;
  }

  public async dispose(): Promise<void> {
    for (const [, p] of this.pending) {
      try {
        p.reject(new Error("CDP session disposed"));
      } catch {
      }
    }
    this.pending.clear();
    try {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    } catch {
    }
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
      }
      this.proc = null;
    }
    if (this.profileDir) {
      try {
        fs.rmSync(this.profileDir, { recursive: true, force: true });
      } catch {
      }
      this.profileDir = null;
    }
  }
}

const SNAPSHOT_DOM_SCRIPT = `(() => {
  const prev = document.querySelectorAll('[data-wide-ref]');
  for (const node of prev) node.removeAttribute('data-wide-ref');
  const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [onclick], [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(document.querySelectorAll(selector));
  const elements = [];
  let idx = 1;
  for (const el of nodes) {
    if (!(el instanceof Element)) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0 && el.tagName.toLowerCase() !== 'input') continue;
    const tag = el.tagName.toLowerCase();
    const typeAttr = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'input' && typeAttr === 'hidden') continue;
    const ref = '@e' + idx;
    el.setAttribute('data-wide-ref', ref);
    const role = tag === 'a' ? 'link' : tag === 'input' ? ('input[' + typeAttr + ']') : (el.getAttribute('role') || tag);
    const rawText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    const aria = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const name = el.getAttribute('name') || '';
    const val = ('value' in el && typeof el.value === 'string') ? el.value : (el.getAttribute('value') || '');
    const href = tag === 'a' ? (el.getAttribute('href') || '') : '';
    const text = (rawText || aria || placeholder || name || val || role).slice(0, 120);
    elements.push({
      index: idx,
      ref,
      tag,
      role,
      text,
      href,
      name,
      value: val,
      attributes: {
        id: el.id || '',
        name,
        type: typeAttr,
        placeholder,
        href,
        'aria-label': aria
      }
    });
    idx++;
    if (idx > 120) break;
  }
  const bodyText = (document.body ? (document.body.innerText || document.body.textContent || '') : '')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 8000);
  return {
    url: location.href,
    title: document.title || location.href,
    textContent: bodyText,
    rawHtml: document.documentElement ? document.documentElement.outerHTML.slice(0, 50000) : '',
    elements
  };
})()`;

const activeControllers = new Set<HeadlessBrowserController>();
let cleanupRegistered = false;

function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const ctrl of activeControllers) {
      ctrl.forceDisposeSync();
    }
  });
}

export class HeadlessBrowserController {
  private state: BrowserState = {
    url: "about:blank",
    title: "",
    statusCode: 200,
    elements: [],
    textContent: "",
    rawHtml: "",
    formInputs: {},
    history: [],
    mode: "http"
  };

  private cdp: NativeCdpSession | null = null;
  private pwBrowser: any = null;
  private pwContext: any = null;
  private pwPage: any = null;
  private consoleBuffer: BrowserConsoleEntry[] = [];
  private cookieJar = new Map<string, string>();
  private stealth = false;
  private fastRead = false;
  private pwRouteHooked = false;
  private harEntries: any[] = [];
  private harStartedAt = "";
  private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Wide-CLI/0.9.251126";

  public findSystemBrowserExecutable(): string | null {
    const candidates: string[] = [];

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || "";
      const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

      candidates.push(
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
      );
    } else if (process.platform === "darwin") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      );
    } else {
      candidates.push(
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/usr/bin/brave-browser"
      );
    }

    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }

  private normalizeTargetUrl(rawUrl: string): string {
    const trimmed = String(rawUrl || "").trim();
    if (!trimmed) return "about:blank";
    if (/^(?:https?|about|data|file):\/\//i.test(trimmed) || trimmed === "about:blank") {
      return trimmed;
    }
    const scheme = /^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/]|$)/i.test(trimmed)
      ? "http://"
      : "https://";
    return scheme + trimmed;
  }

  private async tryLoadPlaywright(): Promise<any | null> {
    if (process.env.WIDE_CLI_BROWSER_HTTP_ONLY === "1") return null;
    try {
      const req = createRequire(import.meta.url);
      const baseDir = path.dirname(req.resolve("./browser.js"));
      const siblingIde = path.resolve(baseDir, "../../../wide-ide/node_modules/playwright-core");
      const siblingWide = path.resolve(baseDir, "../../../wide/node_modules/playwright-core");
      for (const id of ["playwright-core", siblingIde, siblingWide]) {
        try {
          return req(id);
        } catch {
        }
      }
    } catch {
    }
    return null;
  }

  private async ensureLiveSession(): Promise<"playwright" | "cdp" | "http"> {
    if (this.pwPage) return "playwright";
    if (this.cdp) return "cdp";
    if (process.env.WIDE_CLI_BROWSER_HTTP_ONLY === "1") return "http";

    registerProcessCleanup();
    activeControllers.add(this);
    if (!this.harStartedAt) {
      this.harStartedAt = new Date().toISOString();
    }

    const exe = this.findSystemBrowserExecutable();
    const proxyUrl = process.env.WIDE_CATCHER_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";

    const pw = await this.tryLoadPlaywright();
    if (pw?.chromium && exe) {
      try {
        const pwArgs = ["--no-sandbox", "--disable-gpu"];
        if (this.stealth) {
          pwArgs.push("--disable-blink-features=AutomationControlled");
        }
        const launchOpts: any = {
          executablePath: exe,
          headless: true,
          args: pwArgs
        };
        if (proxyUrl) {
          launchOpts.proxy = { server: proxyUrl };
        }
        this.pwBrowser = await pw.chromium.launch(launchOpts);
        const contextOpts: any = { viewport: { width: 1280, height: 800 } };
        if (this.stealth) {
          contextOpts.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
          contextOpts.locale = "en-US";
        }
        this.pwContext = await this.pwBrowser.newContext(contextOpts);
        if (this.stealth) {
          await this.pwContext.addInitScript(CLI_STEALTH_INIT_SCRIPT);
        }
        this.pwPage = await this.pwContext.newPage();
        this.pwRouteHooked = false;
        await this.applyFastReadFilter();
        this.pwPage.on("console", (msg: any) => {
          this.pushConsoleEntry(msg.type(), msg.text());
        });
        this.pwPage.on("pageerror", (err: Error) => {
          this.pushConsoleEntry("error", err.message);
        });
        this.pwPage.on("requestfinished", async (req: any) => {
          try {
            const reqUrl = String(req.url?.() || "");
            if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) return;
            const resp = await req.response().catch(() => null);
            const timing = typeof req.timing === "function" ? req.timing() : {};
            const elapsedMs = timing && typeof timing.responseEnd === "number" && timing.responseEnd > 0 ? Math.round(timing.responseEnd) : 0;
            this.harEntries.push({
              pageref: "page_1",
              startedDateTime: new Date().toISOString(),
              time: elapsedMs,
              request: {
                method: String(req.method?.() || "GET"),
                url: reqUrl,
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: redactHarHeaders(req.headers?.() || {}),
                queryString: parseHarQuery(reqUrl),
                headersSize: -1,
                bodySize: 0,
              },
              response: {
                status: resp ? Number(resp.status?.() || 0) : 0,
                statusText: resp ? String(resp.statusText?.() || "") : "",
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: redactHarHeaders(resp ? resp.headers?.() : {}),
                content: { size: 0, mimeType: String((resp && resp.headers?.()?.["content-type"]) || "x-unknown") },
                redirectURL: "",
                headersSize: -1,
                bodySize: 0,
              },
              cache: {},
              timings: { send: 0, wait: elapsedMs, receive: 0 },
            });
            if (this.harEntries.length > 500) {
              this.harEntries.splice(0, this.harEntries.length - 500);
            }
          } catch {
          }
        });
        this.pwPage.on("response", (res: any) => {
          try {
            if (res.request()?.isNavigationRequest?.()) {
              this.state.statusCode = res.status();
            }
          } catch {
          }
        });
        this.state.mode = "playwright";
        this.state.stealth = this.stealth;
        return "playwright";
      } catch {
        await this.cleanupLiveDrivers();
      }
    }

    if (exe) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const session = new NativeCdpSession();
          await session.connect(exe, proxyUrl || undefined, this.stealth);
          this.cdp = session;
          this.state.mode = "cdp";
          this.state.stealth = this.stealth;
          await this.applyFastReadFilter();
          return "cdp";
        } catch {
          await this.cleanupLiveDrivers();
        }
      }
    }

    this.state.mode = "http";
    this.state.stealth = this.stealth;
    return "http";
  }

  private async applyFastReadFilter(fastRead?: boolean): Promise<void> {
    if (typeof fastRead === "boolean") {
      this.fastRead = fastRead;
    }
    if (this.pwPage && this.fastRead && !this.pwRouteHooked && typeof this.pwPage.route === "function") {
      this.pwRouteHooked = true;
      await this.pwPage
        .route("**/*", (route: any) => {
          if (this.fastRead) {
            const req = route.request();
            if (shouldBlockFastReadRequest(req.resourceType(), req.url())) {
              return route.abort();
            }
          }
          return route.continue();
        })
        .catch(() => {
          this.pwRouteHooked = false;
        });
    }
    if (this.cdp) {
      const blocked = this.fastRead
        ? ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.woff", "*.woff2", "*.ttf", "*.css", "*google-analytics*", "*doubleclick*"]
        : [];
      await this.cdp.send("Network.setBlockedURLs", { urls: blocked }).catch(() => {});
    }
  }

  private pushConsoleEntry(level: string, text: string): void {
    this.consoleBuffer.push({
      level: String(level || "log"),
      text: String(text || ""),
      timestamp: new Date().toISOString()
    });
    if (this.consoleBuffer.length > 200) {
      this.consoleBuffer.shift();
    }
  }

  private async cleanupLiveDrivers(): Promise<void> {
    const pw = this.pwBrowser;
    this.pwPage = null;
    this.pwContext = null;
    this.pwBrowser = null;
    const cdp = this.cdp;
    this.cdp = null;
    if (pw) {
      try {
        await pw.close();
      } catch {
      }
    }
    if (cdp) {
      try {
        await cdp.dispose();
      } catch {
      }
    }
    activeControllers.delete(this);
  }

  public forceDisposeSync(): void {
    try {
      if (this.cdp) {
        void this.cdp.dispose();
        this.cdp = null;
      }
      if (this.pwBrowser) {
        void this.pwBrowser.close();
        this.pwBrowser = null;
        this.pwContext = null;
        this.pwPage = null;
      }
    } catch {
    }
  }

  private async syncLiveDomState(): Promise<void> {
    let snap: any = null;
    if (this.pwPage) {
      snap = await this.pwPage.evaluate(SNAPSHOT_DOM_SCRIPT);
    } else if (this.cdp) {
      snap = await this.cdp.evalValue(SNAPSHOT_DOM_SCRIPT);
      this.state.statusCode = this.cdp.lastStatusCode;
    }
    if (!snap) return;

    this.state.url = String(snap.url || this.state.url);
    this.state.title = stripBrowserEmojis(String(snap.title || "")) || this.state.url;
    this.state.textContent = String(snap.textContent || "");
    this.state.rawHtml = String(snap.rawHtml || "");
    this.state.elements = Array.isArray(snap.elements) ? snap.elements : [];
  }

  private resolveTargetRefOrSelector(target: string): { ref?: string; matched?: DOMElement; cssSelector?: string } {
    const clean = String(target || "").trim();
    const lower = clean.toLowerCase();

    if (/^@?e\d+$/i.test(clean)) {
      const normalizedRef = clean.startsWith("@") ? clean.toLowerCase() : `@${clean.toLowerCase()}`;
      const el = this.state.elements.find((e) => (e.ref || `@e${e.index}`).toLowerCase() === normalizedRef);
      return { ref: normalizedRef, matched: el, cssSelector: `[data-wide-ref="${normalizedRef}"]` };
    }

    if (/^\[\d+\]$/.test(clean) || /^\d+$/.test(clean)) {
      const idx = parseInt(clean.replace(/[\[\]]/g, ""), 10);
      const el = this.state.elements.find((e) => e.index === idx);
      const ref = el?.ref || `@e${idx}`;
      return { ref, matched: el, cssSelector: `[data-wide-ref="${ref}"]` };
    }

    const byMeta = this.state.elements.find(
      (e) =>
        e.text.toLowerCase().includes(lower) ||
        (e.name && e.name.toLowerCase().includes(lower)) ||
        (e.attributes?.placeholder && e.attributes.placeholder.toLowerCase().includes(lower)) ||
        (e.attributes?.id && e.attributes.id.toLowerCase() === lower)
    );
    if (byMeta) {
      const ref = byMeta.ref || `@e${byMeta.index}`;
      return { ref, matched: byMeta, cssSelector: `[data-wide-ref="${ref}"]` };
    }

    if (/^[#.\[]|^[a-z]+\[/i.test(clean)) {
      return { cssSelector: clean };
    }

    return {};
  }

  public parseHtml(rawHtml: string): { title: string; elements: DOMElement[]; textContent: string } {
    const clean = rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");

    const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(clean);
    const title = titleMatch ? stripBrowserEmojis(titleMatch[1]) : "";

    const elements: DOMElement[] = [];
    let elemIdx = 1;

    const inputRegex = /<input\b([^>]*)>/gi;
    let inputMatch: RegExpExecArray | null;
    while ((inputMatch = inputRegex.exec(clean)) !== null) {
      const attrsStr = inputMatch[1];
      const attrs = this.parseAttributes(attrsStr);
      const type = (attrs.type || "text").toLowerCase();
      const name = attrs.name || "";
      const val = attrs.value || "";
      const placeholder = attrs.placeholder || "";
      const role = `input[${type}]`;
      const desc = placeholder || name || val || role;

      elements.push({
        index: elemIdx,
        ref: `@e${elemIdx}`,
        tag: "input",
        text: desc,
        role,
        name,
        value: val,
        attributes: attrs
      });
      elemIdx++;
    }

    const tagRegex = /<(a|button|select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRegex.exec(clean)) !== null) {
      const tag = tagMatch[1].toLowerCase();
      const attrsStr = tagMatch[2];
      const inner = tagMatch[3].replace(/<[^>]+>/g, " ").trim();
      const attrs = this.parseAttributes(attrsStr);
      const role = tag === "a" ? "link" : tag;
      const text = inner || attrs["aria-label"] || attrs["title"] || role;

      elements.push({
        index: elemIdx,
        ref: `@e${elemIdx}`,
        tag,
        text,
        role,
        href: attrs.href,
        name: attrs.name,
        attributes: attrs
      });
      elemIdx++;
    }

    const plainText = clean
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();

    return { title, elements, textContent: plainText };
  }

  private parseAttributes(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const regex = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(attrStr)) !== null) {
      const key = match[1].toLowerCase();
      const val = match[2] ?? match[3] ?? match[4] ?? "";
      attrs[key] = val;
    }
    return attrs;
  }

  public async open(url?: string, opts?: { stealth?: boolean; fastRead?: boolean }): Promise<string> {
    if (typeof opts?.stealth === "boolean" && opts.stealth !== this.stealth) {
      await this.cleanupLiveDrivers();
      this.stealth = opts.stealth;
    }
    if (typeof opts?.fastRead === "boolean") {
      this.fastRead = opts.fastRead;
    }
    const mode = await this.ensureLiveSession();
    await this.applyFastReadFilter(opts?.fastRead);
    if (url && url.trim()) {
      return this.navigate(url, { fastRead: opts?.fastRead });
    }
    return `Browser session initialized (engine: ${mode}, url: ${this.state.url}${this.stealth ? ", stealth: on" : ""}).`;
  }

  public async navigate(url: string, opts?: { fastRead?: boolean }): Promise<string> {
    const target = this.normalizeTargetUrl(url);
    const mode = await this.ensureLiveSession();
    await this.applyFastReadFilter(opts?.fastRead);

    if (mode === "playwright" && this.pwPage) {
      try {
        const res = await this.pwPage.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
        if (res) this.state.statusCode = res.status();
        await this.pwPage.waitForTimeout(150);
        this.state.history.push(target);
        this.state.formInputs = {};
        await this.syncLiveDomState();
        return this.renderView();
      } catch (err: any) {
        return `Navigation failed for ${target}: ${err.message}`;
      }
    }

    if (mode === "cdp" && this.cdp) {
      try {
        const prevUrl = await this.cdp.evalValue("location.href").catch(() => "");
        let loaded = false;
        const offLoad = this.cdp.on("Page.loadEventFired", () => {
          loaded = true;
        });
        try {
          await this.cdp.send("Page.navigate", { url: target });
          const deadline = Date.now() + 15000;
          while (!loaded && Date.now() < deadline) {
            const curUrl = await this.cdp.evalValue("location.href").catch(() => "");
            const ready = await this.cdp.evalValue("document.readyState").catch(() => "loading");
            const urlChanged = Boolean(curUrl) && curUrl !== "about:blank" && (curUrl !== prevUrl || target === prevUrl);
            if (urlChanged && (ready === "complete" || ready === "interactive")) {
              loaded = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        } finally {
          offLoad();
        }
        await new Promise((r) => setTimeout(r, 150));
        this.state.history.push(target);
        this.state.formInputs = {};
        await this.syncLiveDomState();
        return this.renderView();
      } catch (err: any) {
        return `Navigation failed for ${target}: ${err.message}`;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const reqStartedAt = Date.now();
    const startedIso = new Date(reqStartedAt).toISOString();
    if (!this.harStartedAt) this.harStartedAt = startedIso;

    try {
      const headers: Record<string, string> = {
        "User-Agent": this.stealth
          ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
          : this.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      };
      if (this.cookieJar.size > 0) {
        headers.Cookie = Array.from(this.cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
      }
      const res = await fetch(target, { headers, signal: controller.signal });
      clearTimeout(timer);

      this.state.statusCode = res.status;
      this.state.url = res.url || target;
      this.state.rawHtml = await res.text();
      this.state.history.push(this.state.url);
      this.state.formInputs = {};

      const parsed = this.parseHtml(this.state.rawHtml);
      this.state.title = stripBrowserEmojis(parsed.title) || this.state.url;
      this.state.elements = parsed.elements;
      this.state.textContent = parsed.textContent;

      const elapsedMs = Math.max(0, Date.now() - reqStartedAt);
      const respHeadersObj: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeadersObj[k] = v;
      });
      this.harEntries.push({
        pageref: "page_1",
        startedDateTime: startedIso,
        time: elapsedMs,
        request: {
          method: "GET",
          url: this.state.url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: redactHarHeaders(headers),
          queryString: parseHarQuery(this.state.url),
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: res.status,
          statusText: res.statusText || "",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: redactHarHeaders(respHeadersObj),
          content: {
            size: Buffer.byteLength(this.state.rawHtml, "utf8"),
            mimeType: res.headers.get("content-type") || "text/html",
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: Buffer.byteLength(this.state.rawHtml, "utf8"),
        },
        cache: {},
        timings: { send: 0, wait: elapsedMs, receive: 0 },
      });
      if (this.harEntries.length > 500) {
        this.harEntries.splice(0, this.harEntries.length - 500);
      }

      return this.renderView();
    } catch (err: any) {
      clearTimeout(timer);
      return `Navigation failed for ${target}: ${err.message}`;
    }
  }

  public async snapshot(): Promise<string> {
    if (this.pwPage || this.cdp) {
      await this.syncLiveDomState();
    }
    return this.renderView();
  }

  public async click(target: string): Promise<string> {
    if (this.pwPage) {
      const resolved = this.resolveTargetRefOrSelector(target);
      if (resolved.cssSelector) {
        await this.pwPage.locator(resolved.cssSelector).first().click({ timeout: 8000 });
        await this.pwPage.waitForTimeout(250);
        await this.syncLiveDomState();
        return `Clicked ${resolved.ref || target}.\n\n${this.renderView()}`;
      }
      const loc = this.pwPage.getByText(target, { exact: false }).first();
      await loc.click({ timeout: 8000 });
      await this.pwPage.waitForTimeout(250);
      await this.syncLiveDomState();
      return `Clicked '${target}'.\n\n${this.renderView()}`;
    }

    if (this.cdp) {
      const resolved = this.resolveTargetRefOrSelector(target);
      const selector = resolved.cssSelector || "";
      const coords = await this.cdp.evalValue(`(() => {
        let el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "null"};
        if (!el) {
          const needle = ${JSON.stringify(target.trim().toLowerCase())};
          const list = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'));
          el = list.find((n) => (n.innerText || n.textContent || n.getAttribute('aria-label') || '').toLowerCase().includes(needle)) || null;
        }
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!coords?.found) {
        const available = this.state.elements.slice(0, 10).map((e) => `${e.ref || `[${e.index}]`} ${e.role}: ${e.text.slice(0, 25)}`).join(", ");
        return `Element '${target}' not found. Available elements: ${available}`;
      }
      const cx = Math.max(1, Math.round(coords.x));
      const cy = Math.max(1, Math.round(coords.y));
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));
      await this.syncLiveDomState();
      return `Clicked ${resolved.ref || target}.\n\n${this.renderView()}`;
    }

    if (this.state.elements.length === 0) {
      return "No interactive elements on the current page. Please navigate first.";
    }

    const resolved = this.resolveTargetRefOrSelector(target);
    const matched = resolved.matched;

    if (!matched) {
      const available = this.state.elements.slice(0, 10).map((e) => `[${e.index}] ${e.role}: ${e.text.slice(0, 25)}`).join(", ");
      return `Element '${target}' not found. Available elements: ${available}`;
    }

    if (matched.href) {
      const resolvedUrl = new URL(matched.href, this.state.url).toString();
      return await this.navigate(resolvedUrl);
    }

    if (matched.tag === "button" || (matched.tag === "input" && ["submit", "button"].includes(matched.attributes.type || ""))) {
      if (Object.keys(this.state.formInputs).length > 0) {
        const params = new URLSearchParams(this.state.formInputs);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);

        try {
          const res = await fetch(this.state.url, {
            method: "POST",
            headers: {
              "User-Agent": this.userAgent,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString(),
            signal: controller.signal
          });
          clearTimeout(timer);

          this.state.statusCode = res.status;
          this.state.url = res.url || this.state.url;
          this.state.rawHtml = await res.text();
          const parsed = this.parseHtml(this.state.rawHtml);
          this.state.title = parsed.title || this.state.url;
          this.state.elements = parsed.elements;
          this.state.textContent = parsed.textContent;

          return `Form submitted with payload ${JSON.stringify(this.state.formInputs)}.\n\n` + this.renderView();
        } catch (err: any) {
          clearTimeout(timer);
          return `Form submission failed: ${err.message}`;
        }
      }
      return `Clicked [${matched.index}] ${matched.role}: ${matched.text}`;
    }

    return `Clicked [${matched.index}] ${matched.role}: ${matched.text}`;
  }

  public async fill(target: string, text: string, submit = false): Promise<string> {
    if (this.pwPage) {
      const resolved = this.resolveTargetRefOrSelector(target);
      if (!resolved.cssSelector) {
        return `Input element '${target}' not found in live page snapshot.`;
      }
      const loc = this.pwPage.locator(resolved.cssSelector).first();
      await loc.fill(text, { timeout: 8000 });
      if (submit) {
        await loc.press("Enter");
        await this.pwPage.waitForTimeout(250);
      }
      await this.syncLiveDomState();
      return `Filled ${resolved.ref || target} with value '${text}'${submit ? " and submitted" : ""}.`;
    }

    if (this.cdp) {
      const resolved = this.resolveTargetRefOrSelector(target);
      const selector = resolved.cssSelector || "";
      const focused = await this.cdp.evalValue(`(() => {
        let el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "null"};
        if (!el) {
          const needle = ${JSON.stringify(target.trim().toLowerCase())};
          const list = Array.from(document.querySelectorAll('input,textarea'));
          el = list.find((n) => ((n.name || '') + ' ' + (n.placeholder || '') + ' ' + (n.getAttribute('aria-label') || '')).toLowerCase().includes(needle)) || null;
        }
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!focused) {
        return `Input element '${target}' not found.`;
      }
      if (submit) {
        await this.press("Enter");
      }
      await this.syncLiveDomState();
      return `Filled ${resolved.ref || target} with value '${text}'${submit ? " and submitted" : ""}.`;
    }

    const resolved = this.resolveTargetRefOrSelector(target);
    let matched = resolved.matched;
    const cleanTarget = target.trim().toLowerCase();

    if (!matched) {
      matched = this.state.elements.find((e) =>
        ["input", "textarea"].includes(e.tag) && (
          e.text.toLowerCase().includes(cleanTarget) ||
          (e.name && e.name.toLowerCase().includes(cleanTarget)) ||
          (e.attributes.placeholder && e.attributes.placeholder.toLowerCase().includes(cleanTarget))
        )
      );
    }

    const fieldName = (matched && matched.name) ? matched.name : (cleanTarget || "field");
    this.state.formInputs[fieldName] = text;

    if (submit) {
      return this.click("submit");
    }

    const desc = matched ? `[${matched.index}] ${matched.role}` : fieldName;
    return `Filled ${desc} with value '${text}'.`;
  }

  public async press(key: string): Promise<string> {
    if (this.pwPage) {
      await this.pwPage.keyboard.press(key);
      await this.pwPage.waitForTimeout(200);
      await this.syncLiveDomState();
      return `Pressed key '${key}'.`;
    }
    if (this.cdp) {
      const keyCode = key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" ? 27 : 0;
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: keyCode });
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: keyCode });
      await new Promise((r) => setTimeout(r, 200));
      await this.syncLiveDomState();
      return `Pressed key '${key}'.`;
    }
    if (key.toLowerCase() === "enter" && Object.keys(this.state.formInputs).length > 0) {
      return this.click("submit");
    }
    return `Simulated key press '${key}' on ${this.state.url}.`;
  }

  public async hover(target: string): Promise<string> {
    if (this.pwPage) {
      const resolved = this.resolveTargetRefOrSelector(target);
      if (resolved.cssSelector) {
        await this.pwPage.locator(resolved.cssSelector).first().hover({ timeout: 6000 });
        return `Hovered over ${resolved.ref || target}.`;
      }
    }
    if (this.cdp) {
      const resolved = this.resolveTargetRefOrSelector(target);
      const selector = resolved.cssSelector || target;
      const coords = await this.cdp.evalValue(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (coords) {
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(coords.x), y: Math.round(coords.y) });
        return `Hovered over ${resolved.ref || target}.`;
      }
    }
    return `Hovered over '${target}' on ${this.state.url}.`;
  }

  public async select(target: string, value: string): Promise<string> {
    if (this.pwPage) {
      const resolved = this.resolveTargetRefOrSelector(target);
      if (resolved.cssSelector) {
        await this.pwPage.locator(resolved.cssSelector).first().selectOption(value);
        await this.syncLiveDomState();
        return `Selected '${value}' on ${resolved.ref || target}.`;
      }
    }
    if (this.cdp) {
      const resolved = this.resolveTargetRefOrSelector(target);
      const selector = resolved.cssSelector || target;
      const ok = await this.cdp.evalValue(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName.toLowerCase() !== 'select') return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!ok) return `Select element '${target}' not found.`;
      await this.syncLiveDomState();
      return `Selected '${value}' on ${resolved.ref || target}.`;
    }
    this.state.formInputs[target] = value;
    return `Selected '${value}' for '${target}'.`;
  }

  public async scroll(direction: "up" | "down" | "top" | "bottom" = "down", pixels = 500): Promise<string> {
    const js =
      direction === "top"
        ? "window.scrollTo(0, 0)"
        : direction === "bottom"
          ? "window.scrollTo(0, document.body.scrollHeight)"
          : `window.scrollBy(0, ${direction === "up" ? -Math.abs(pixels) : Math.abs(pixels)})`;
    if (this.pwPage) {
      await this.pwPage.evaluate(js);
      return `Scrolled ${direction} (${pixels}px).`;
    }
    if (this.cdp) {
      await this.cdp.evalValue(js);
      return `Scrolled ${direction} (${pixels}px).`;
    }
    return `Scrolled ${direction} in viewport state.`;
  }

  public async wait(opts: { ms?: number; selector?: string; text?: string }): Promise<string> {
    const ms = Math.min(Math.max(Number(opts.ms || 1000), 50), 15000);
    if (opts.selector) {
      if (this.pwPage) {
        await this.pwPage.waitForSelector(opts.selector, { timeout: ms });
        await this.syncLiveDomState();
        return `Selector '${opts.selector}' appeared.`;
      }
      if (this.cdp) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const found = await this.cdp.evalValue(`Boolean(document.querySelector(${JSON.stringify(opts.selector)}))`).catch(() => false);
          if (found) {
            await this.syncLiveDomState();
            return `Selector '${opts.selector}' appeared.`;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(`Timed out waiting for selector '${opts.selector}'`);
      }
    }
    if (opts.text) {
      if (this.pwPage) {
        await this.pwPage.getByText(opts.text).first().waitFor({ timeout: ms });
        await this.syncLiveDomState();
        return `Text '${opts.text}' appeared.`;
      }
      if (this.cdp) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const hasText = await this.cdp.evalValue(`document.body ? document.body.innerText.includes(${JSON.stringify(opts.text)}) : false`).catch(() => false);
          if (hasText) {
            await this.syncLiveDomState();
            return `Text '${opts.text}' appeared.`;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(`Timed out waiting for text '${opts.text}'`);
      }
    }
    await new Promise((r) => setTimeout(r, ms));
    return `Waited ${ms}ms.`;
  }

  public extract(query = "", mode = "text"): string {
    if (!this.state.rawHtml && !this.state.textContent) {
      return "No webpage currently loaded. Use browser_navigate first.";
    }

    const m = String(mode || "text").toLowerCase();
    if (m === "article" || m === "clean_text") {
      const article = extractArticleFromHtml(this.state.rawHtml || this.state.textContent, this.state.url);
      if (m === "article") {
        return JSON.stringify(
          {
            ...article,
            cleanText: article.cleanText.slice(0, 14000),
          },
          null,
          2,
        );
      }
      const headerLines = [
        `Page Title: ${article.title}`,
        `Page URL: ${article.url || this.state.url}`,
        article.author ? `Author: ${article.author}` : "",
        article.date ? `Date: ${article.date}` : "",
        article.description ? `Description: ${article.description}` : "",
        "",
        article.cleanText.slice(0, 16000),
      ].filter(Boolean);
      return headerLines.join("\n");
    }

    const lines: string[] = [
      `Page Title: ${this.state.title}`,
      `Page URL: ${this.state.url}`,
      `Status Code: ${this.state.statusCode}`,
      ""
    ];

    if (query.trim()) {
      const qLower = query.toLowerCase();
      const matched = this.state.textContent
        .split(/(?<=\.|\n)/)
        .map((s) => s.trim())
        .filter((s) => s.toLowerCase().includes(qLower));

      if (matched.length > 0) {
        lines.push(`Content matching '${query}':`);
        lines.push(...matched.slice(0, 25));
      } else {
        lines.push(`No exact matches for '${query}'. Showing preview:`);
        lines.push(this.state.textContent.slice(0, 2000));
      }
    } else {
      lines.push("Page Content:");
      lines.push(this.state.textContent.slice(0, 3000));
    }

    return lines.join("\n");
  }

  public async captureScreenshotFile(outputDir?: string): Promise<string | null> {
    let pngBuffer: Buffer | null = null;
    if (this.pwPage) {
      pngBuffer = await this.pwPage.screenshot({ type: "png" });
    } else if (this.cdp) {
      const res = await this.cdp.send("Page.captureScreenshot", { format: "png" });
      if (res?.data) {
        pngBuffer = Buffer.from(res.data, "base64");
      }
    }
    if (!pngBuffer) return null;
    const baseDir = outputDir ? path.join(outputDir, ".wide", "screenshots") : os.tmpdir();
    fs.mkdirSync(baseDir, { recursive: true });
    const outPath = path.join(baseDir, `wide-browser-${Date.now()}.png`);
    fs.writeFileSync(outPath, pngBuffer);
    this.state.lastScreenshotPath = outPath;
    return outPath;
  }

  public screenshot(): string {
    const lines: string[] = [
      "+----------------------------------------------------------------+",
      `| HEADLESS BROWSER SNAPSHOT: ${this.state.title.slice(0, 35).padEnd(35)} |`,
      `| URL: ${this.state.url.slice(0, 56).padEnd(56)} |`,
      `| Status: ${String(this.state.statusCode).padEnd(53)} |`,
      "+----------------------------------------------------------------+"
    ];

    for (const el of this.state.elements.slice(0, 15)) {
      const text = el.text.slice(0, 40).padEnd(40);
      const role = el.role.slice(0, 14).padEnd(14);
      lines.push(`| [${String(el.index).padStart(2, "0")}] ${role} | ${text} |`);
    }

    lines.push("+----------------------------------------------------------------+");
    if (this.state.lastScreenshotPath) {
      lines.push(`Screenshot saved: ${this.state.lastScreenshotPath}`);
    }
    return lines.join("\n");
  }

  public getConsole(clear = false): BrowserConsoleEntry[] {
    const merged = this.cdp ? [...this.consoleBuffer, ...this.cdp.consoleEntries] : [...this.consoleBuffer];
    if (clear) {
      this.consoleBuffer = [];
      if (this.cdp) this.cdp.consoleEntries = [];
    }
    return merged;
  }

  public async cookies(action: "get" | "set" | "clear" = "get", cookie?: { name: string; value: string; url?: string }): Promise<string> {
    if (action === "clear") {
      this.cookieJar.clear();
      if (this.pwContext) await this.pwContext.clearCookies();
      if (this.cdp) await this.cdp.send("Network.clearBrowserCookies");
      return "Cleared browser cookies.";
    }
    if (action === "set" && cookie?.name) {
      const targetUrl = cookie.url || (this.state.url.startsWith("http") ? this.state.url : "http://127.0.0.1/");
      this.cookieJar.set(cookie.name, cookie.value);
      if (this.pwContext) {
        await this.pwContext.addCookies([{ name: cookie.name, value: cookie.value, url: targetUrl }]);
      } else if (this.cdp) {
        await this.cdp.send("Network.setCookie", { name: cookie.name, value: cookie.value, url: targetUrl });
      }
      return `Set cookie '${cookie.name}'.`;
    }
    if (this.pwContext) {
      const list = await this.pwContext.cookies();
      return JSON.stringify(list, null, 2);
    }
    if (this.cdp) {
      const res = await this.cdp.send("Network.getCookies");
      return JSON.stringify(res?.cookies || [], null, 2);
    }
    return JSON.stringify(Array.from(this.cookieJar.entries()).map(([name, value]) => ({ name, value })), null, 2);
  }

  public async evalJs(script: string): Promise<string> {
    if (this.pwPage) {
      const val = await this.pwPage.evaluate(script);
      return typeof val === "string" ? val : JSON.stringify(val, null, 2);
    }
    if (this.cdp) {
      const val = await this.cdp.evalValue(script);
      return typeof val === "string" ? val : JSON.stringify(val, null, 2);
    }
    throw new Error("JavaScript evaluation requires an active Chromium/Edge browser session (call browser_open or browser_navigate first).");
  }

  public renderView(): string {
    const out: string[] = [
      `Page Title: ${this.state.title}`,
      `Current URL: ${this.state.url}`,
      `Status Code: ${this.state.statusCode}`,
      `Engine: ${this.state.mode || "http"}`,
      "",
      "Interactive Elements (target by @eN ref, [N], or label):"
    ];

    if (this.state.elements.length === 0) {
      out.push("(No interactive elements found)");
    } else {
      for (const el of this.state.elements.slice(0, 35)) {
        const ref = el.ref || `@e${el.index}`;
        const extra = el.href ? ` -> ${el.href}` : "";
        out.push(`[${el.index}] (${ref}) ${el.role}: ${el.text}${extra}`);
      }
    }

    out.push("");
    out.push("Page Content Preview:");
    out.push(this.state.textContent.slice(0, 1500) || "(Empty content)");
    return out.join("\n");
  }

  public exportHar(opts?: { urlFilter?: string; limit?: number }): Record<string, any> {
    const cdpEntries = this.cdp?.harEntries || [];
    const combined = [...cdpEntries, ...this.harEntries];
    const filter = String(opts?.urlFilter || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(opts?.limit) || 100));
    const filtered = filter
      ? combined.filter((e) => String(e?.request?.url || "").toLowerCase().includes(filter))
      : combined;
    return {
      log: {
        version: "1.2",
        creator: { name: "Wide CLI Browser", version: "1.0" },
        pages: [
          {
            startedDateTime: this.harStartedAt || new Date().toISOString(),
            id: "page_1",
            title: stripBrowserEmojis(this.state.title || this.state.url || "New Tab") || "New Tab",
            pageTimings: { onContentLoad: -1, onLoad: -1 },
          },
        ],
        entries: filtered.slice(-limit),
      },
    };
  }

  public async close(): Promise<string> {
    const u = this.state.url;
    await this.cleanupLiveDrivers();
    this.consoleBuffer = [];
    this.cookieJar.clear();
    this.harEntries = [];
    this.harStartedAt = "";
    this.stealth = false;
    this.state = {
      url: "about:blank",
      title: "",
      statusCode: 200,
      elements: [],
      textContent: "",
      rawHtml: "",
      formInputs: {},
      history: [],
      mode: "http",
      stealth: false,
    };
    return `Headless browser session closed. Cleared session for ${u}.`;
  }
}

export const defaultBrowser = new HeadlessBrowserController();

export const browserOpenTool: Tool = {
  definition: {
    name: "browser_open",
    description: "Initialize the real Chromium/Edge browser session and optionally navigate to an initial URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL to open immediately." },
        stealth: { type: "boolean", description: "Opt-in stealth evasion mode masking navigator.webdriver." },
        fastRead: { type: "boolean", description: "Abort images, fonts, stylesheets, media, and analytics trackers for fast reading." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.open(params.url, {
        stealth: typeof params.stealth === "boolean" ? params.stealth : undefined,
        fastRead: typeof params.fastRead === "boolean" ? params.fastRead : undefined,
      });
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Open error: ${err.message}` };
    }
  }
};

export const browserNavigateTool: Tool = {
  definition: {
    name: "browser_navigate",
    description: "Navigate the autonomous browser to a target URL. Returns page title, status, and @eN / [N] interactive element refs.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL to visit (e.g. https://example.com)." },
        fastRead: { type: "boolean", description: "Block heavy media/fonts/CSS/trackers during navigation." }
      },
      required: ["url"]
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.navigate(params.url, {
        fastRead: typeof params.fastRead === "boolean" ? params.fastRead : undefined,
      });
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Navigation error: ${err.message}` };
    }
  }
};

export const browserSnapshotTool: Tool = {
  definition: {
    name: "browser_snapshot",
    description: "Capture a fresh interactive DOM snapshot with @eN element refs and visible text from the current page.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  async execute(): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.snapshot();
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Snapshot error: ${err.message}` };
    }
  }
};

export const browserClickTool: Tool = {
  definition: {
    name: "browser_click",
    description: "Click an interactive element (link, button, tab) by its @eN ref, [N] index, CSS selector, or text label.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element ref ('@e3'), index ('[3]' or '3'), CSS selector, or text label." }
      },
      required: ["target"]
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.click(params.target);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Click error: ${err.message}` };
    }
  }
};

export const browserTypeTool: Tool = {
  definition: {
    name: "browser_type",
    description: "Fill text into an input field or textarea identified by @eN ref, [N] index, CSS selector, or name/placeholder.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element ref ('@e2'), index ('[2]'), CSS selector, or input name/placeholder." },
        text: { type: "string", description: "Text string to fill into the input field." },
        submit: { type: "boolean", description: "Optional boolean flag to submit after typing." }
      },
      required: ["target", "text"]
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.fill(params.target, params.text, Boolean(params.submit));
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Type error: ${err.message}` };
    }
  }
};

export const browserPressTool: Tool = {
  definition: {
    name: "browser_press",
    description: "Dispatch a keyboard key press (e.g. Enter, Tab, Escape, ArrowDown) in the active browser page.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name (e.g. 'Enter', 'Tab', 'Escape')." }
      },
      required: ["key"]
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.press(params.key);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Key press error: ${err.message}` };
    }
  }
};

export const browserHoverTool: Tool = {
  definition: {
    name: "browser_hover",
    description: "Hover the mouse cursor over an element identified by @eN ref, index, or CSS selector.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element ref, index, or CSS selector." }
      },
      required: ["target"]
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.hover(params.target);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Hover error: ${err.message}` };
    }
  }
};

export const browserSelectTool: Tool = {
  definition: {
    name: "browser_select",
    description: "Select an option value on a <select> dropdown element.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Select element @eN ref, index, or CSS selector." },
        value: { type: "string", description: "Option value to select." }
      },
      required: ["target", "value"]
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.select(params.target, params.value);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Select error: ${err.message}` };
    }
  }
};

export const browserScrollTool: Tool = {
  definition: {
    name: "browser_scroll",
    description: "Scroll the browser viewport up, down, top, or bottom.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", description: "Scroll direction.", enum: ["up", "down", "top", "bottom"] },
        pixels: { type: "number", description: "Pixels to scroll for up/down (default: 500)." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.scroll(params.direction || "down", params.pixels || 500);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Scroll error: ${err.message}` };
    }
  }
};

export const browserWaitTool: Tool = {
  definition: {
    name: "browser_wait",
    description: "Wait for a CSS selector, visible text, or fixed duration in the browser.",
    parameters: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Timeout or wait duration in milliseconds." },
        selector: { type: "string", description: "Optional CSS selector to wait for." },
        text: { type: "string", description: "Optional visible text to wait for." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.wait({ ms: params.ms, selector: params.selector, text: params.text });
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Wait error: ${err.message}` };
    }
  }
};

export const browserExtractTool: Tool = {
  definition: {
    name: "browser_extract",
    description: "Extract clean article content/metadata (article/clean_text) or search text from the currently loaded page.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query or term to filter extracted content." },
        mode: { type: "string", enum: ["text", "article", "clean_text"], description: "Extraction mode. Use 'article' or 'clean_text' to strip navigation/footer boilerplate." },
        cleanText: { type: "boolean", description: "Shorthand for clean_text article extraction." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const mode = params.mode || (params.cleanText ? "clean_text" : "text");
      const result = defaultBrowser.extract(params.query || "", mode);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Extract error: ${err.message}` };
    }
  }
};

export const browserScreenshotTool: Tool = {
  definition: {
    name: "browser_screenshot",
    description: "Capture a screenshot PNG (when Chromium/Edge is active) and structured viewport snapshot.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  async execute(_params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      await defaultBrowser.captureScreenshotFile(context?.workingDirectory);
      const result = defaultBrowser.screenshot();
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Screenshot error: ${err.message}` };
    }
  }
};

export const browserConsoleTool: Tool = {
  definition: {
    name: "browser_console",
    description: "Read console logs and runtime errors emitted by the active browser page.",
    parameters: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "Clear console buffer after reading." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const entries = defaultBrowser.getConsole(Boolean(params.clear));
      return { success: true, output: entries.length > 0 ? JSON.stringify(entries, null, 2) : "No console messages." };
    } catch (err: any) {
      return { success: false, output: "", error: `Console error: ${err.message}` };
    }
  }
};

export const browserCookiesTool: Tool = {
  definition: {
    name: "browser_cookies",
    description: "Inspect, set, or clear browser cookies.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Cookie action.", enum: ["get", "set", "clear"] },
        name: { type: "string", description: "Cookie name (for 'set')." },
        value: { type: "string", description: "Cookie value (for 'set')." },
        url: { type: "string", description: "Optional cookie URL (for 'set')." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const action = (params.action || "get") as "get" | "set" | "clear";
      const result = await defaultBrowser.cookies(action, params.name ? { name: params.name, value: String(params.value || ""), url: params.url } : undefined);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Cookies error: ${err.message}` };
    }
  }
};

export const browserEvalTool: Tool = {
  definition: {
    name: "browser_eval",
    description: "Execute JavaScript in the active browser page context and return the serialized result.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript expression or IIFE to run in the page." }
      },
      required: ["script"]
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.evalJs(params.script);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Eval error: ${err.message}` };
    }
  }
};

export const browserExportHarTool: Tool = {
  definition: {
    name: "browser_export_har",
    description: "Export captured live browser network traffic in HAR 1.2 JSON format (with sensitive Auth/Cookie headers redacted).",
    parameters: {
      type: "object",
      properties: {
        urlFilter: { type: "string", description: "Optional substring to filter recorded request URLs." },
        limit: { type: "number", description: "Maximum number of HAR entries to include (default 100)." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>): Promise<ToolResult> {
    try {
      const har = defaultBrowser.exportHar({
        urlFilter: params.urlFilter,
        limit: params.limit,
      });
      return { success: true, output: JSON.stringify(har, null, 2).slice(0, 18000) };
    } catch (err: any) {
      return { success: false, output: "", error: `HAR export error: ${err.message}` };
    }
  }
};

export const browserCloseTool: Tool = {
  definition: {
    name: "browser_close",
    description: "Close the active browser session and release Chromium/Edge resources.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  async execute(): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.close();
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Close error: ${err.message}` };
    }
  }
};
