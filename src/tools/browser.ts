import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

export interface DOMElement {
  index: number;
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
    history: []
  };

  private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Wide-CLI/0.291126";

  public findSystemBrowserExecutable(): string | null {
    const candidates: string[] = [];

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || "";
      const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

      candidates.push(
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
      );
    } else if (process.platform === "darwin") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      );
    } else {
      candidates.push(
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge"
      );
    }

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  public parseHtml(rawHtml: string): { title: string; elements: DOMElement[]; textContent: string } {
    let clean = rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");

    const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(clean);
    const title = titleMatch ? titleMatch[1].trim() : "";

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
        index: elemIdx++,
        tag: "input",
        text: desc,
        role,
        name,
        value: val,
        attributes: attrs
      });
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
        index: elemIdx++,
        tag,
        text,
        role,
        href: attrs.href,
        name: attrs.name,
        attributes: attrs
      });
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

  public async navigate(url: string): Promise<string> {
    let target = url.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = "https://" + target;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*;q=0.8"
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      this.state.statusCode = res.status;
      this.state.url = res.url || target;
      this.state.rawHtml = await res.text();
      this.state.history.push(this.state.url);
      this.state.formInputs = {};

      const parsed = this.parseHtml(this.state.rawHtml);
      this.state.title = parsed.title || this.state.url;
      this.state.elements = parsed.elements;
      this.state.textContent = parsed.textContent;

      return this.renderView();
    } catch (err: any) {
      clearTimeout(timer);
      return `Navigation failed for ${target}: ${err.message}`;
    }
  }

  public async click(target: string): Promise<string> {
    if (this.state.elements.length === 0) {
      return "No interactive elements on the current page. Please navigate first.";
    }

    const cleanTarget = target.trim().toLowerCase();
    let matched: DOMElement | undefined;

    if (cleanTarget.startsWith("[") && cleanTarget.endsWith("]")) {
      const idx = parseInt(cleanTarget.slice(1, -1), 10);
      matched = this.state.elements.find(e => e.index === idx);
    } else {
      const idx = parseInt(cleanTarget, 10);
      if (!isNaN(idx)) {
        matched = this.state.elements.find(e => e.index === idx);
      }
    }

    if (!matched) {
      matched = this.state.elements.find(e =>
        e.text.toLowerCase().includes(cleanTarget) ||
        (e.name && e.name.toLowerCase().includes(cleanTarget))
      );
    }

    if (!matched) {
      const available = this.state.elements.slice(0, 10).map(e => `[${e.index}] ${e.role}: ${e.text.slice(0, 25)}`).join(", ");
      return `Element '${target}' not found. Available elements: ${available}`;
    }

    if (matched.href) {
      const resolved = new URL(matched.href, this.state.url).toString();
      return await this.navigate(resolved);
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

  public fill(target: string, text: string, submit = false): Promise<string> {
    const cleanTarget = target.trim().toLowerCase();
    let matched: DOMElement | undefined;

    if (cleanTarget.startsWith("[") && cleanTarget.endsWith("]")) {
      const idx = parseInt(cleanTarget.slice(1, -1), 10);
      matched = this.state.elements.find(e => e.index === idx);
    } else {
      const idx = parseInt(cleanTarget, 10);
      if (!isNaN(idx)) {
        matched = this.state.elements.find(e => e.index === idx);
      }
    }

    if (!matched) {
      matched = this.state.elements.find(e =>
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
    return Promise.resolve(`Filled ${desc} with value '${text}'.`);
  }

  public extract(query = ""): string {
    if (!this.state.rawHtml) {
      return "No webpage currently loaded. Use browser_navigate first.";
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
        .map(s => s.trim())
        .filter(s => s.toLowerCase().includes(qLower));

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
    return lines.join("\n");
  }

  public renderView(): string {
    const out: string[] = [
      `Page Title: ${this.state.title}`,
      `Current URL: ${this.state.url}`,
      `Status Code: ${this.state.statusCode}`,
      "",
      "Interactive Elements:"
    ];

    if (this.state.elements.length === 0) {
      out.push("(No interactive elements found)");
    } else {
      for (const el of this.state.elements.slice(0, 25)) {
        const extra = el.href ? ` -> ${el.href}` : "";
        out.push(`[${el.index}] ${el.role}: ${el.text}${extra}`);
      }
    }

    out.push("");
    out.push("Page Content Preview:");
    out.push(this.state.textContent.slice(0, 1500) || "(Empty content)");
    return out.join("\n");
  }

  public close(): string {
    const u = this.state.url;
    this.state = {
      url: "about:blank",
      title: "",
      statusCode: 200,
      elements: [],
      textContent: "",
      rawHtml: "",
      formInputs: {},
      history: []
    };
    return `Headless browser session closed. Cleared session for ${u}.`;
  }
}

export const defaultBrowser = new HeadlessBrowserController();

export const browserNavigateTool: Tool = {
  definition: {
    name: "browser_navigate",
    description: "Navigate the autonomous background headless browser to a target URL. Returns page title, status, and numbered interactive controls.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL to visit (e.g. https://example.com)." }
      },
      required: ["url"]
    }
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.navigate(params.url);
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Navigation error: ${err.message}` };
    }
  }
};

export const browserClickTool: Tool = {
  definition: {
    name: "browser_click",
    description: "Click an interactive element (link, button, tab) in the headless browser by its index (e.g. '[1]') or text label.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element index (e.g. '[3]' or '3') or text label to click." }
      },
      required: ["target"]
    }
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
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
    description: "Fill text into an input field or textarea identified by its index (e.g. '[2]') or name/placeholder, with optional form submission.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element index (e.g. '[2]') or input name/placeholder." },
        text: { type: "string", description: "Text string to fill into the input field." },
        submit: { type: "boolean", description: "Optional boolean flag to automatically submit the form after typing." }
      },
      required: ["target", "text"]
    }
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const result = await defaultBrowser.fill(params.target, params.text, Boolean(params.submit));
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Type error: ${err.message}` };
    }
  }
};

export const browserExtractTool: Tool = {
  definition: {
    name: "browser_extract",
    description: "Extract text content or search for specific keywords from the currently loaded page in the headless browser.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query or term to filter extracted content." }
      },
      required: []
    }
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const result = defaultBrowser.extract(params.query || "");
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Extract error: ${err.message}` };
    }
  }
};

export const browserScreenshotTool: Tool = {
  definition: {
    name: "browser_screenshot",
    description: "Capture a structured viewport snapshot of the current headless browser state including title, URL, status code, and interactive elements.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const result = defaultBrowser.screenshot();
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Screenshot error: ${err.message}` };
    }
  }
};

export const browserCloseTool: Tool = {
  definition: {
    name: "browser_close",
    description: "Close the active headless browser session and reset browsing history.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  async execute(params: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const result = defaultBrowser.close();
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Close error: ${err.message}` };
    }
  }
};
