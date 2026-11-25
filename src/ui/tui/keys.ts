export interface MouseEvent {
  action: "press" | "release" | "wheel-up" | "wheel-down" | "move";
  button: "left" | "middle" | "right" | "none";
  col: number;
  row: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

export interface CprEvent {
  row: number;
  col: number;
}

export interface KeyEvent {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  text?: string;
  mouse?: MouseEvent;
  cpr?: CprEvent;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

let mouseInteractionEnabled = process.env.WIDE_NO_MOUSE !== "1";

export function setMouseEnabled(enabled: boolean): void {
  mouseInteractionEnabled = Boolean(enabled);
}

export function isMouseEnabled(): boolean {
  if (process.env.WIDE_NO_MOUSE === "1" || process.argv.includes("--no-mouse")) {
    return false;
  }
  return mouseInteractionEnabled;
}

export class RawKeyParser {
  private buf = "";
  private inPaste = false;
  private pasteBuf = "";
  private escTimer: NodeJS.Timeout | null = null;
  private onKey: (ev: KeyEvent) => void;

  constructor(onKey: (ev: KeyEvent) => void) {
    this.onKey = onKey;
  }

  public dispose(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    this.buf = "";
    this.inPaste = false;
    this.pasteBuf = "";
  }

  public feed(chunk: string | Buffer): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.drain();
  }

  private emit(ev: KeyEvent): void {
    this.onKey(ev);
  }

  private drain(): void {
    while (this.buf.length > 0) {
      if (this.inPaste) {
        const endIdx = this.buf.indexOf(PASTE_END);
        if (endIdx >= 0) {
          this.pasteBuf += this.buf.slice(0, endIdx);
          this.buf = this.buf.slice(endIdx + PASTE_END.length);
          this.inPaste = false;
          const payload = this.pasteBuf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          this.pasteBuf = "";
          this.emit({ name: "paste", sequence: payload, ctrl: false, meta: false, shift: false, text: payload });
          continue;
        }
        const safeCut = Math.max(0, this.buf.length - PASTE_END.length);
        if (safeCut > 0) {
          this.pasteBuf += this.buf.slice(0, safeCut);
          this.buf = this.buf.slice(safeCut);
        }
        return;
      }

      if (this.buf.startsWith(PASTE_START)) {
        this.buf = this.buf.slice(PASTE_START.length);
        this.inPaste = true;
        this.pasteBuf = "";
        continue;
      }

      if (this.buf[0] === "\x1b") {
        if (this.buf.length === 1) {
          this.escTimer = setTimeout(() => {
            this.escTimer = null;
            if (this.buf === "\x1b") {
              this.buf = "";
              this.emit({ name: "escape", sequence: "\x1b", ctrl: false, meta: false, shift: false });
            }
          }, 30);
          this.escTimer.unref?.();
          return;
        }

        if (this.buf.startsWith("\x1b[200") && this.buf.length < PASTE_START.length) {
          return;
        }

        if (this.buf.startsWith("\x1b[M")) {
          if (this.buf.length < 6) return;
          const seq = this.buf.slice(0, 6);
          const cb = seq.charCodeAt(3) - 32;
          const cx = Math.max(1, seq.charCodeAt(4) - 32);
          const cy = Math.max(1, seq.charCodeAt(5) - 32);
          this.buf = this.buf.slice(6);
          this.emitLegacyMouse(seq, cb, cx, cy);
          continue;
        }

        if (this.buf.startsWith("\x1b[<")) {
          const sgrMatch = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buf);
          if (!sgrMatch) {
            if (this.buf.length < 24 && /^\x1b\[<[0-9;]*$/.test(this.buf)) {
              return;
            }
            this.buf = this.buf.slice(1);
            continue;
          }
          const full = sgrMatch[0];
          this.buf = this.buf.slice(full.length);
          this.emitSgrMouse(full, Number(sgrMatch[1]), Number(sgrMatch[2]), Number(sgrMatch[3]), sgrMatch[4] === "m");
          continue;
        }

        const next = this.buf[1];
        if (next === "\r" || next === "\n") {
          const seq = this.buf.slice(0, 2);
          this.buf = this.buf.slice(2);
          this.emit({ name: "return", sequence: seq, ctrl: false, meta: true, shift: false });
          continue;
        }

        if (next === "[" || next === "O") {
          const csiMatch = /^\x1b(?:\[([0-9;?]*)([A-Za-z~])|O([A-Za-z]))/.exec(this.buf);
          if (!csiMatch) {
            if (this.buf.length < 20 && /^\x1b\[[0-9;?]*$/.test(this.buf)) {
              return;
            }
            const seq = this.buf[0];
            this.buf = this.buf.slice(1);
            this.emit({ name: "escape", sequence: seq, ctrl: false, meta: false, shift: false });
            continue;
          }
          const full = csiMatch[0];
          this.buf = this.buf.slice(full.length);
          this.handleCsi(full, csiMatch[1] || "", csiMatch[2] || csiMatch[3] || "");
          continue;
        }

        const altChar = this.buf[1];
        const seq = this.buf.slice(0, 2);
        this.buf = this.buf.slice(2);
        if (altChar === "\x7f" || altChar === "\x08") {
          this.emit({ name: "backspace", sequence: seq, ctrl: false, meta: true, shift: false });
        } else if (altChar === "b" || altChar === "B") {
          this.emit({ name: "left", sequence: seq, ctrl: true, meta: true, shift: false });
        } else if (altChar === "f" || altChar === "F") {
          this.emit({ name: "right", sequence: seq, ctrl: true, meta: true, shift: false });
        } else {
          this.emit({ name: altChar.toLowerCase(), sequence: seq, ctrl: false, meta: true, shift: altChar !== altChar.toLowerCase() });
        }
        continue;
      }

      const ch = this.buf[0];
      const code = ch.charCodeAt(0);
      this.buf = this.buf.slice(1);

      if (ch === "\r") {
        if (this.buf[0] === "\n") this.buf = this.buf.slice(1);
        this.emit({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });
        continue;
      }
      if (ch === "\n") {
        this.emit({ name: "j", sequence: "\n", ctrl: true, meta: false, shift: false });
        continue;
      }
      if (ch === "\t") {
        this.emit({ name: "tab", sequence: "\t", ctrl: false, meta: false, shift: false });
        continue;
      }
      if (ch === "\x7f" || ch === "\x08") {
        this.emit({ name: "backspace", sequence: ch, ctrl: false, meta: false, shift: false });
        continue;
      }
      if (code >= 1 && code <= 26) {
        const letter = String.fromCharCode(code + 96);
        this.emit({ name: letter, sequence: ch, ctrl: true, meta: false, shift: false });
        continue;
      }
      if (code >= 32) {
        let end = 0;
        while (end < this.buf.length) {
          const c = this.buf.charCodeAt(end);
          if (c < 32 || c === 127) break;
          end++;
        }
        const text = ch + this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        this.emit({ name: "text", sequence: text, ctrl: false, meta: false, shift: false, text });
      }
    }
  }

  private emitSgrMouse(seq: string, cb: number, col: number, row: number, isRelease: boolean): void {
    const shift = (cb & 4) !== 0;
    const meta = (cb & 8) !== 0;
    const ctrl = (cb & 16) !== 0;
    const isMotion = (cb & 32) !== 0;
    const isWheel = (cb & 64) !== 0;
    const btnCode = cb & 3;

    let action: MouseEvent["action"];
    let button: MouseEvent["button"] = "none";

    if (isWheel) {
      action = btnCode === 0 ? "wheel-up" : "wheel-down";
    } else if (isMotion) {
      action = "move";
      button = btnCode === 0 ? "left" : btnCode === 1 ? "middle" : btnCode === 2 ? "right" : "none";
    } else {
      action = isRelease ? "release" : "press";
      button = btnCode === 0 ? "left" : btnCode === 1 ? "middle" : btnCode === 2 ? "right" : "none";
    }

    this.emit({
      name: "mouse",
      sequence: seq,
      ctrl,
      meta,
      shift,
      mouse: { action, button, col, row, shift, meta, ctrl },
    });
  }

  private emitLegacyMouse(seq: string, cb: number, col: number, row: number): void {
    const shift = (cb & 4) !== 0;
    const meta = (cb & 8) !== 0;
    const ctrl = (cb & 16) !== 0;
    const isWheel = (cb & 64) !== 0;
    const btnCode = cb & 3;
    if (isWheel) {
      this.emit({
        name: "mouse",
        sequence: seq,
        ctrl,
        meta,
        shift,
        mouse: { action: btnCode === 0 ? "wheel-up" : "wheel-down", button: "none", col, row, shift, meta, ctrl },
      });
      return;
    }
    const isRelease = btnCode === 3;
    const button: MouseEvent["button"] = btnCode === 0 ? "left" : btnCode === 1 ? "middle" : btnCode === 2 ? "right" : "none";
    this.emit({
      name: "mouse",
      sequence: seq,
      ctrl,
      meta,
      shift,
      mouse: { action: isRelease ? "release" : "press", button, col, row, shift, meta, ctrl },
    });
  }

  private handleCsi(seq: string, params: string, final: string): void {
    const parts = params ? params.split(";") : [];
    const first = Number(parts[0] || 0);
    const mod = parts.length >= 2 ? Number(parts[1]) : 1;
    const shift = mod === 2 || mod === 4 || mod === 6 || mod === 8;
    const meta = mod === 3 || mod === 4 || mod === 7 || mod === 8;
    const ctrl = mod === 5 || mod === 6 || mod === 7 || mod === 8;

    if (final === "R" && parts.length === 2 && Number.isFinite(first) && Number.isFinite(mod) && first >= 1 && mod >= 1) {
      this.emit({
        name: "cpr",
        sequence: seq,
        ctrl: false,
        meta: false,
        shift: false,
        cpr: { row: first, col: mod },
      });
      return;
    }

    if (final === "u") {
      if (first === 13) {
        this.emit({ name: "return", sequence: seq, ctrl, meta, shift });
        return;
      }
      if (first === 9) {
        this.emit({ name: "tab", sequence: seq, ctrl, meta, shift });
        return;
      }
      if (first === 27) {
        this.emit({ name: "escape", sequence: seq, ctrl, meta, shift });
        return;
      }
      if (first >= 32 && first <= 126) {
        const ch = String.fromCharCode(first);
        this.emit({
          name: ctrl || meta ? ch.toLowerCase() : "text",
          sequence: seq,
          ctrl,
          meta,
          shift,
          text: ctrl || meta ? undefined : ch,
        });
        return;
      }
    }

    if (final === "~" && parts[0] === "27" && parts[2] === "13") {
      const m = Number(parts[1] || 1);
      this.emit({
        name: "return",
        sequence: seq,
        ctrl: m === 5 || m === 6,
        meta: m === 3 || m === 4,
        shift: m === 2 || m === 4 || m === 6,
      });
      return;
    }

    if (final === "Z") {
      this.emit({ name: "tab", sequence: seq, ctrl: false, meta: false, shift: true });
      return;
    }
    if (final === "A") {
      this.emit({ name: "up", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "B") {
      this.emit({ name: "down", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "C") {
      this.emit({ name: "right", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "D") {
      this.emit({ name: "left", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "H" || (final === "~" && (first === 1 || first === 7))) {
      this.emit({ name: "home", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "F" || (final === "~" && (first === 4 || first === 8))) {
      this.emit({ name: "end", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "~" && first === 3) {
      this.emit({ name: "delete", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "~" && first === 5) {
      this.emit({ name: "pageup", sequence: seq, ctrl, meta, shift });
      return;
    }
    if (final === "~" && first === 6) {
      this.emit({ name: "pagedown", sequence: seq, ctrl, meta, shift });
      return;
    }
  }
}

export function enableTerminalInputModes(opts: { mouse?: boolean } = {}): void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(true);
    } catch {}
  }
  if (process.stdout.isTTY) {
    let seq = "\x1b[?2004h";
    const wantMouse = opts.mouse ?? isMouseEnabled();
    if (wantMouse) {
      seq += "\x1b[?1000h\x1b[?1006h";
    }
    process.stdout.write(seq);
  }
}

export function disableTerminalInputModes(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h");
  }
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
}
