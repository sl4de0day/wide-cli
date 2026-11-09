import pc from "picocolors";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private message: string;

  constructor(message = "Thinking...") {
    this.message = message;
  }

  public start(message?: string): this {
    if (message) this.message = message;
    if (this.timer) return this;

    process.stdout.write("\x1B[?25l"); // hide cursor
    this.timer = setInterval(() => {
      const frame = SPINNER_FRAMES[this.currentFrame % SPINNER_FRAMES.length];
      process.stdout.write(`\r${pc.cyan(frame)} ${pc.dim(this.message)} `);
      this.currentFrame++;
    }, 80);

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
    if (clear) {
      process.stdout.write("\r\x1B[K"); // clear current line
    }
    process.stdout.write("\x1B[?25h"); // show cursor
  }

  public succeed(message: string): void {
    this.stop(true);
    console.log(`${pc.green("✔")} ${message}`);
  }

  public fail(message: string): void {
    this.stop(true);
    console.log(`${pc.red("✖")} ${message}`);
  }
}
