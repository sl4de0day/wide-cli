import { beginSync, endSync, stripAnsi, termWidth, truncateAnsi } from "./ansi.js";
import { formatElapsed, Spinner } from "./spinner.js";
import { glyphs, supportsUnicode, theme } from "./theme.js";
import type { ProviderEvent } from "../providers/types.js";

export interface ToolActivityRecord {
  id: string;
  toolName: string;
  label: string;
  target: string;
  success: boolean;
  elapsedMs: number;
  summary: string;
  outputPreview: string;
  error?: string;
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_FRAMES = ["-", "\\", "|", "/"];

function compactText(val: unknown, max = 56): string {
  const s = typeof val === "string" ? val : JSON.stringify(val ?? "");
  const single = s.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(4, max - 1))}${glyphs.ellipsis}`;
}

export function formatToolSummary(name: string, args: Record<string, any> = {}): { verb: string; target: string } {
  switch (name) {
    case "read_file":
    case "read_document": {
      const p = String(args.path || "");
      const range =
        typeof args.startLine === "number" || typeof args.endLine === "number"
          ? ` (L${args.startLine ?? 1}-${args.endLine ?? "end"})`
          : "";
      return { verb: "Read", target: `${compactText(p, 52)}${range}` };
    }
    case "write_file":
      return { verb: "Write", target: compactText(args.path || "", 56) };
    case "edit_file":
      return { verb: "Edit", target: compactText(args.path || "", 56) };
    case "list_dir":
      return { verb: "List", target: compactText(args.path || ".", 56) };
    case "search_files": {
      const pat = compactText(args.pattern || args.query || "", 36);
      const dir = args.path ? ` in ${compactText(args.path, 24)}` : "";
      return { verb: "Search", target: `"${pat}"${dir}` };
    }
    case "run_command":
      return { verb: "Shell", target: compactText(args.command || "", 64) };
    case "run_security_scan":
      return { verb: "Scan", target: compactText(args.path || ".", 48) };
    case "crawl_target":
      return { verb: "Crawl", target: compactText(args.url || "", 56) };
    case "inspect_http_message":
      return { verb: "Inspect", target: `${String(args.method || "GET").toUpperCase()} ${compactText(args.url || "/", 48)}` };
    case "fuzz_endpoint":
      return { verb: "Fuzz", target: `${compactText(args.param || "", 20)} (${args.payloadType || ""}) ${compactText(args.url || "", 36)}` };
    case "generate_payloads":
      return { verb: "Payloads", target: String(args.type || "").toUpperCase() };
    case "send_http_request":
      return { verb: "HTTP", target: `${String(args.method || "GET").toUpperCase()} ${compactText(args.url || "", 50)}` };
    case "git_inspection":
      return { verb: "Git", target: compactText(args.action || args.subcommand || "status", 48) };
    default: {
      if (name.startsWith("db_")) {
        const op = name.slice(3).replace(/_/g, " ");
        const extra = args.query ? compactText(args.query, 44) : args.connectionId ? compactText(args.connectionId, 32) : "";
        return { verb: `DB ${op}`, target: extra };
      }
      if (name.startsWith("browser_")) {
        const op = name.slice(8).replace(/_/g, " ");
        const extra = args.url || args.selector || args.text || args.mode || "";
        return { verb: `Browser ${op}`, target: extra ? compactText(extra, 48) : "" };
      }
      const firstVal = Object.values(args)[0];
      return { verb: name, target: firstVal !== undefined ? compactText(firstVal, 48) : "" };
    }
  }
}

export function summarizeToolResult(name: string, output: string): string {
  const clean = stripAnsi(output || "").trim();
  if (!clean) return "";
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (name === "read_file" || name === "read_document") {
    const m = /\(Lines\s+(\d+)-(\d+)\s+of\s+(\d+)\)/.exec(lines[0] || "");
    if (m) return `${Number(m[2]) - Number(m[1]) + 1} lines`;
    return `${lines.length} lines`;
  }
  if (name === "list_dir") {
    return `${lines.length} entries`;
  }
  if (name === "search_files") {
    return `${lines.length} match line(s)`;
  }
  if (name === "run_command") {
    const exitLine = [...lines].reverse().find((l) => /^Exit Code:\s*\d+/i.test(l));
    if (exitLine) return exitLine.toLowerCase();
    return `${lines.length} lines`;
  }
  if (name === "edit_file" || name === "write_file") {
    if (clean.includes("AUTO-VERIFICATION FAILED")) return "verify failed";
    if (clean.includes("Auto-verification:") && clean.includes("0 errors")) return "verified ok";
    return "saved";
  }
  if (name === "run_security_scan") {
    const m = /Found\s+(\d+)\s+issue/i.exec(clean);
    if (m) return `${m[1]} finding(s)`;
    if (clean.includes("0 vulnerabilities")) return "0 findings";
  }
  return compactText(lines[0] || "", 44);
}

export class ActivityTimeline {
  private stream: NodeJS.WriteStream;
  private verbose = false;
  private history: ToolActivityRecord[] = [];
  private maxTailLines = 5;
  private activeTail: string[] = [];
  private activeLabel = "";
  private activeTarget = "";
  private activeStartedAt = 0;
  private activeFrame = 0;
  private activeRenderedLines = 0;
  private timer: NodeJS.Timeout | null = null;
  private thinkingSpinner: Spinner;
  private subStepActive = false;

  constructor(options: { stream?: NodeJS.WriteStream; verbose?: boolean } = {}) {
    this.stream = options.stream ?? process.stdout;
    this.verbose = Boolean(options.verbose);
    this.thinkingSpinner = new Spinner("Thinking...", { stream: this.stream });
  }

  public isVerbose(): boolean {
    return this.verbose;
  }

  public setVerbose(val: boolean): void {
    this.verbose = val;
  }

  public toggleVerbose(): boolean {
    this.verbose = !this.verbose;
    return this.verbose;
  }

  public getHistory(): ToolActivityRecord[] {
    return [...this.history];
  }

  public clearHistory(): void {
    this.history = [];
  }

  public startThinking(label = "Thinking...", detail?: string): void {
    this.stopActiveToolBlock();
    this.thinkingSpinner.start(label, detail);
  }

  public updateThinking(label: string, detail?: string): void {
    this.thinkingSpinner.update(label, detail);
  }

  public stopThinking(): void {
    this.thinkingSpinner.stop(true);
    this.subStepActive = false;
  }

  public handleProviderEvent(ev: ProviderEvent): void {
    if (ev.type === "thinking") {
      if (this.thinkingSpinner.isActive()) {
        this.thinkingSpinner.update(ev.label || "Reasoning...", ev.detail);
      } else {
        this.thinkingSpinner.start(ev.label || "Reasoning...", ev.detail);
      }
      return;
    }
    if (ev.type === "tool_start") {
      const label = ev.label || "tool";
      const detail = ev.detail ? compactText(ev.detail, 48) : undefined;
      this.subStepActive = true;
      if (this.thinkingSpinner.isActive()) {
        this.thinkingSpinner.update(`Running ${label}`, detail);
      } else {
        this.thinkingSpinner.start(`Running ${label}`, detail);
      }
      return;
    }
    if (ev.type === "tool_end") {
      if (this.subStepActive && this.verbose) {
        this.thinkingSpinner.stop(true);
        const dot = ev.success === false ? theme.error(glyphs.cross) : theme.ok(glyphs.dot);
        const dur = typeof ev.elapsedMs === "number" ? ` ${theme.faint(formatElapsed(ev.elapsedMs))}` : "";
        this.stream.write(`  ${dot} ${theme.fgBright(ev.label || "tool")}${dur}\n`);
        this.thinkingSpinner.start("Thinking...");
      }
      this.subStepActive = false;
      return;
    }
    if (ev.type === "status" && ev.label) {
      if (this.thinkingSpinner.isActive()) {
        this.thinkingSpinner.update(ev.label, ev.detail);
      }
    }
  }

  private clearRenderedBlock(): void {
    if (!this.stream.isTTY || this.activeRenderedLines <= 0) {
      this.activeRenderedLines = 0;
      return;
    }
    let seq = beginSync();
    for (let i = 0; i < this.activeRenderedLines; i++) {
      if (i > 0) seq += "\x1B[1A";
      seq += "\r\x1B[2K";
    }
    seq += endSync();
    this.stream.write(seq);
    this.activeRenderedLines = 0;
  }

  private renderActiveToolBlock(): void {
    if (!this.stream.isTTY || !this.timer) return;
    const maxCols = Math.max(24, termWidth(80) - 1);
    const frames = supportsUnicode() ? BRAILLE_FRAMES : ASCII_FRAMES;
    const glyph = frames[this.activeFrame % frames.length];
    const elapsed = formatElapsed(Date.now() - this.activeStartedAt);
    const header = `  ${theme.accent(glyph)} ${theme.fgBold(this.activeLabel)}${this.activeTarget ? ` ${theme.info(this.activeTarget)}` : ""} ${theme.faint(elapsed)}`;
    const lines: string[] = [truncateAnsi(header, maxCols)];

    for (let i = 0; i < this.activeTail.length; i++) {
      const connector = i === this.activeTail.length - 1 ? glyphs.elbow : glyphs.pipe;
      const tailLine = `    ${theme.border(connector)} ${theme.faint(this.activeTail[i])}`;
      lines.push(truncateAnsi(tailLine, maxCols));
    }

    let seq = beginSync();
    if (this.activeRenderedLines > 0) {
      for (let i = 0; i < this.activeRenderedLines; i++) {
        if (i > 0) seq += "\x1B[1A";
        seq += "\r\x1B[2K";
      }
    }
    seq += lines.join("\n");
    seq += endSync();
    this.stream.write(seq);
    this.activeRenderedLines = lines.length;
  }

  public startTool(name: string, args: Record<string, any> = {}): { verb: string; target: string } {
    this.stopThinking();
    this.stopActiveToolBlock();
    const summary = formatToolSummary(name, args);
    this.activeLabel = summary.verb;
    this.activeTarget = summary.target;
    this.activeTail = [];
    this.activeStartedAt = Date.now();
    this.activeFrame = 0;

    if (this.stream.isTTY) {
      this.stream.write("\x1B[?25l");
      this.timer = setInterval(() => {
        this.activeFrame++;
        this.renderActiveToolBlock();
      }, 90);
      this.timer.unref?.();
      this.renderActiveToolBlock();
    }
    return summary;
  }

  public pushOutputLine(rawLine: string): void {
    const clean = stripAnsi(rawLine).replace(/\r/g, "").trimEnd();
    if (!clean) return;
    this.activeTail.push(clean);
    if (this.activeTail.length > this.maxTailLines) {
      this.activeTail.splice(0, this.activeTail.length - this.maxTailLines);
    }
    if (this.timer && this.stream.isTTY) {
      this.renderActiveToolBlock();
    }
  }

  public pauseForPrompt(): void {
    this.stopThinking();
    this.stopActiveToolBlock();
  }

  public stopActiveToolBlock(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearRenderedBlock();
    if (this.stream.isTTY) {
      this.stream.write("\x1B[?25h");
    }
  }

  public finishTool(
    id: string,
    name: string,
    args: Record<string, any>,
    result: { success: boolean; output: string; error?: string },
    elapsedMs: number,
  ): ToolActivityRecord {
    this.stopActiveToolBlock();
    const { verb, target } = formatToolSummary(name, args);
    const meta = result.success ? summarizeToolResult(name, result.output) : "";
    const maxCols = Math.max(24, termWidth(80) - 1);

    const statusIcon = result.success ? theme.ok(glyphs.dot) : theme.error(glyphs.cross);
    const sep = ` ${theme.faint(glyphs.middot)} `;
    const parts: string[] = [
      `${statusIcon} ${theme.fgBold(verb)}${target ? ` ${theme.info(target)}` : ""}`,
    ];
    if (meta) parts.push(theme.muted(meta));
    parts.push(theme.faint(formatElapsed(elapsedMs)));

    this.stream.write(`  ${truncateAnsi(parts.join(sep), maxCols)}\n`);

    const rawPreview = result.success ? result.output : (result.error || "Tool failed");
    const previewLines = stripAnsi(rawPreview || "")
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);

    if (!result.success && result.error) {
      const errLines = previewLines.slice(0, 3);
      for (let i = 0; i < errLines.length; i++) {
        const conn = i === errLines.length - 1 ? glyphs.elbow : glyphs.pipe;
        this.stream.write(`    ${theme.border(conn)} ${theme.error(truncateAnsi(errLines[i], maxCols - 8))}\n`);
      }
    } else if (this.verbose && previewLines.length > 0) {
      const shown = previewLines.slice(0, 8);
      for (let i = 0; i < shown.length; i++) {
        const isLast = i === shown.length - 1 && previewLines.length <= 8;
        const conn = isLast ? glyphs.elbow : glyphs.pipe;
        this.stream.write(`    ${theme.border(conn)} ${theme.faint(truncateAnsi(shown[i], maxCols - 8))}\n`);
      }
      if (previewLines.length > 8) {
        this.stream.write(`    ${theme.border(glyphs.elbow)} ${theme.faint(`+${previewLines.length - 8} more line(s)`)}\n`);
      }
    }

    const record: ToolActivityRecord = {
      id,
      toolName: name,
      label: verb,
      target,
      success: result.success,
      elapsedMs,
      summary: meta,
      outputPreview: previewLines.slice(0, 12).join("\n"),
      error: result.error,
    };
    this.history.push(record);
    if (this.history.length > 40) {
      this.history.splice(0, this.history.length - 40);
    }
    return record;
  }
}
