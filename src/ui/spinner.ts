import { termWidth, truncateAnsi } from "./ansi.js";
import { glyphs, supportsUnicode, theme } from "./theme.js";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_FRAMES = ["-", "\\", "|", "/"];

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function restoreTerminalCursor(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1B[?25h");
  }
}

export interface SpinnerOptions {
  stream?: NodeJS.WriteStream;
  showElapsed?: boolean;
  prefix?: string;
}

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private message: string;
  private detail = "";
  private active = false;
  private startedAt = 0;
  private stream: NodeJS.WriteStream;
  private showElapsed: boolean;
  private prefix: string;

  constructor(message = "Thinking...", options: SpinnerOptions = {}) {
    this.message = message;
    this.stream = options.stream ?? process.stdout;
    this.showElapsed = options.showElapsed !== false;
    this.prefix = options.prefix ?? "  ";
  }

  public isActive(): boolean {
    return this.active;
  }

  public start(message?: string, detail?: string): this {
    if (message !== undefined) this.message = message;
    if (detail !== undefined) this.detail = detail;
    if (this.timer) {
      this.renderFrame();
      return this;
    }
    this.active = true;
    this.startedAt = Date.now();
    this.currentFrame = 0;

    if (this.stream.isTTY) {
      this.stream.write("\x1B[?25l");
      this.renderFrame();
      this.timer = setInterval(() => {
        this.currentFrame++;
        this.renderFrame();
      }, 80);
      this.timer.unref?.();
    }

    return this;
  }

  private renderFrame(): void {
    if (!this.active || !this.stream.isTTY) return;
    const frames = supportsUnicode() ? BRAILLE_FRAMES : ASCII_FRAMES;
    const frame = frames[this.currentFrame % frames.length];
    const elapsedMs = Date.now() - this.startedAt;
    const elapsedText = this.showElapsed && elapsedMs >= 300 ? ` ${theme.faint(formatElapsed(elapsedMs))}` : "";
    const detailText = this.detail ? ` ${theme.faint(this.detail)}` : "";
    const line = `${this.prefix}${theme.accent(frame)} ${theme.muted(this.message)}${detailText}${elapsedText}`;
    const maxCols = Math.max(20, termWidth(80) - 1);
    this.stream.write(`\r\x1B[2K${truncateAnsi(line, maxCols)}`);
  }

  public update(message: string, detail?: string): this {
    this.message = message;
    if (detail !== undefined) this.detail = detail;
    if (this.active) this.renderFrame();
    return this;
  }

  public stop(clear = true): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active && this.stream.isTTY) {
      if (clear) {
        this.stream.write("\r\x1B[2K");
      }
      this.stream.write("\x1B[?25h");
    }
    this.active = false;
  }

  public succeed(message: string): void {
    this.stop(true);
    this.stream.write(`${this.prefix}${theme.ok(glyphs.dot)} ${message}\n`);
  }

  public warn(message: string): void {
    this.stop(true);
    this.stream.write(`${this.prefix}${theme.warn(glyphs.warn)} ${message}\n`);
  }

  public fail(message: string): void {
    this.stop(true);
    this.stream.write(`${this.prefix}${theme.error(glyphs.cross)} ${message}\n`);
  }
}
