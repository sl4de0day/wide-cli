import { beginSync, endSync, termHeight, termWidth, truncateAnsi } from "../ansi.js";

export interface DockCursor {
  row: number;
  col: number;
}

export interface DockHitRegion {
  id: string;
  row: number;
  startCol: number;
  endCol: number;
  data?: unknown;
}

export class InlineDock {
  private stream: NodeJS.WriteStream;
  private lastLineCount = 0;
  private lastCursorRow = 0;
  private topRow: number | null = null;
  private hitRegions: DockHitRegion[] = [];
  private lastCprQueryAt = 0;

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.stream = stream;
  }

  public isActive(): boolean {
    return this.lastLineCount > 0;
  }

  public getLineCount(): number {
    return this.lastLineCount;
  }

  public getTopRow(): number {
    if (this.topRow !== null) return this.topRow;
    return Math.max(1, termHeight(24) - Math.max(1, this.lastLineCount) + 1);
  }

  public setHitRegions(regions: DockHitRegion[]): void {
    this.hitRegions = regions;
  }

  public handleCpr(screenRow: number, _screenCol: number): void {
    if (this.lastLineCount <= 0) return;
    this.topRow = Math.max(1, screenRow - this.lastCursorRow);
  }

  public screenToDock(screenCol: number, screenRow: number): { row: number; col: number } | null {
    if (this.lastLineCount <= 0) return null;
    const dockRow = screenRow - this.getTopRow();
    const dockCol = screenCol - 1;
    if (dockRow < 0 || dockRow >= this.lastLineCount || dockCol < 0) {
      return null;
    }
    return { row: dockRow, col: dockCol };
  }

  public hitTest(screenCol: number, screenRow: number): DockHitRegion | null {
    const pos = this.screenToDock(screenCol, screenRow);
    if (!pos) return null;
    for (let i = this.hitRegions.length - 1; i >= 0; i--) {
      const r = this.hitRegions[i];
      if (r.row === pos.row && pos.col >= r.startCol && pos.col < r.endCol) {
        return r;
      }
    }
    return null;
  }

  public render(rawLines: string[], cursor?: DockCursor | null, opts: { queryPosition?: boolean } = {}): void {
    if (!this.stream.isTTY) return;
    const cols = Math.max(20, termWidth(80) - 1);
    const maxRows = Math.max(6, termHeight(24) - 2);
    const lines = rawLines.length > maxRows ? rawLines.slice(0, maxRows) : rawLines;
    const clipped = lines.map((l) => truncateAnsi(l, cols));
    const prevCount = this.lastLineCount;

    let seq = beginSync();
    if (this.lastLineCount > 0) {
      if (this.lastCursorRow > 0) {
        seq += `\x1B[${this.lastCursorRow}A`;
      }
      seq += "\r\x1B[J";
    }

    if (clipped.length > 0) {
      seq += "\x1B[?25l";
      seq += clipped.join("\n");
      if (cursor) {
        const clampedRow = Math.max(0, Math.min(clipped.length - 1, cursor.row));
        const clampedCol = Math.max(0, Math.min(cols, cursor.col));
        const up = clipped.length - 1 - clampedRow;
        if (up > 0) seq += `\x1B[${up}A`;
        seq += `\x1B[${clampedCol + 1}G\x1B[?25h`;
        this.lastCursorRow = clampedRow;
      } else {
        this.lastCursorRow = clipped.length - 1;
      }
    } else {
      seq += "\x1B[?25h";
      this.lastCursorRow = 0;
    }

    const now = Date.now();
    const shouldQuery =
      clipped.length > 0 &&
      (opts.queryPosition || this.topRow === null || prevCount !== clipped.length) &&
      now - this.lastCprQueryAt > 40;
    if (shouldQuery) {
      seq += "\x1B[6n";
      this.lastCprQueryAt = now;
    }

    seq += endSync();
    this.stream.write(seq);
    this.lastLineCount = clipped.length;
  }

  public clear(): void {
    this.hitRegions = [];
    this.topRow = null;
    if (!this.stream.isTTY) {
      this.lastLineCount = 0;
      this.lastCursorRow = 0;
      return;
    }
    if (this.lastLineCount > 0) {
      let seq = beginSync();
      if (this.lastCursorRow > 0) {
        seq += `\x1B[${this.lastCursorRow}A`;
      }
      seq += "\r\x1B[J\x1B[?25h";
      seq += endSync();
      this.stream.write(seq);
    } else {
      this.stream.write("\x1B[?25h");
    }
    this.lastLineCount = 0;
    this.lastCursorRow = 0;
  }

  public commitAbove(lines: string[]): void {
    this.clear();
    if (lines.length > 0) {
      this.stream.write(`${lines.join("\n")}\n`);
    }
  }
}
