import pc from "picocolors";

const SPINNER_FRAMES = ["-", "\\", "|", "/"];

export function restoreTerminalCursor(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1B[?25h");
  }
}

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private message: string;
  private active = false;

  constructor(message = "Thinking...") {
    this.message = message;
  }

  public start(message?: string): this {
    if (message) this.message = message;
    if (this.timer) return this;
    this.active = true;

    if (process.stdout.isTTY) {
      process.stdout.write("\x1B[?25l");
      this.timer = setInterval(() => {
        const frame = SPINNER_FRAMES[this.currentFrame % SPINNER_FRAMES.length];
        process.stdout.write(`\r${pc.cyan(frame)} ${pc.dim(this.message)} `);
        this.currentFrame++;
      }, 80);
      this.timer.unref?.();
    }

    return this;
  }

  public update(message: string): this {
    this.message = message;
    return this;
  }

  public stop(clear = true): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active && process.stdout.isTTY) {
      if (clear) {
        process.stdout.write("\r\x1B[K");
      }
      process.stdout.write("\x1B[?25h");
    }
    this.active = false;
  }

  public succeed(message: string): void {
    this.stop(true);
    console.log(`${pc.green("[OK]")} ${message}`);
  }

  public fail(message: string): void {
    this.stop(true);
    console.log(`${pc.red("[FAIL]")} ${message}`);
  }
}
