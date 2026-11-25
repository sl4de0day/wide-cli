import { detectColorDepth, glyphs, theme, type ColorDepth } from "./theme.js";

const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
const SGR_TOKEN_RE = /^\x1b\[([0-9;]*)m/;
const OSC8_TOKEN_RE = /^\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/;
const CSI_TOKEN_RE = /^\x1b\[[0-?]*[ -/]*[@-~]/;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stripAnsi(text: string): string {
  if (!text) return "";
  return text.replace(ANSI_ESCAPE_RE, "");
}

function isZeroWidthCodePoint(cp: number): boolean {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return true;
  if (cp >= 0x0300 && cp <= 0x036f) return true;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  return false;
}

function isFullWidthCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

export function charDisplayWidth(grapheme: string): number {
  if (!grapheme) return 0;
  if (grapheme === "\t") return 2;
  let width = 0;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isZeroWidthCodePoint(cp)) continue;
    width = Math.max(width, isFullWidthCodePoint(cp) ? 2 : 1);
  }
  return width;
}

export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  if (!plain) return 0;
  let width = 0;
  for (const seg of graphemeSegmenter.segment(plain)) {
    width += charDisplayWidth(seg.segment);
  }
  return width;
}

interface Token {
  kind: "ansi" | "text";
  value: string;
  isReset?: boolean;
  isSgr?: boolean;
  width: number;
}

function tokenizeAnsi(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === "\x1b") {
      const slice = input.slice(i);
      const sgr = SGR_TOKEN_RE.exec(slice);
      if (sgr) {
        const codes = sgr[1];
        tokens.push({
          kind: "ansi",
          value: sgr[0],
          isSgr: true,
          isReset: codes === "" || codes === "0",
          width: 0,
        });
        i += sgr[0].length;
        continue;
      }
      const osc = OSC8_TOKEN_RE.exec(slice);
      if (osc) {
        tokens.push({ kind: "ansi", value: osc[0], width: 0 });
        i += osc[0].length;
        continue;
      }
      const csi = CSI_TOKEN_RE.exec(slice);
      if (csi) {
        tokens.push({ kind: "ansi", value: csi[0], width: 0 });
        i += csi[0].length;
        continue;
      }
    }
    const nextEsc = input.indexOf("\x1b", i + 1);
    const rawText = nextEsc === -1 ? input.slice(i) : input.slice(i, nextEsc);
    for (const seg of graphemeSegmenter.segment(rawText)) {
      tokens.push({
        kind: "text",
        value: seg.segment,
        width: charDisplayWidth(seg.segment),
      });
    }
    i += rawText.length;
  }
  return tokens;
}

export function sliceAnsi(input: string, startCol: number, endCol = Infinity): string {
  if (!input || endCol <= startCol) return "";
  const tokens = tokenizeAnsi(input);
  let col = 0;
  let activeStyles: string[] = [];
  let out = "";
  let emittedStyle = false;
  let started = false;

  for (const tok of tokens) {
    if (tok.kind === "ansi") {
      if (tok.isSgr) {
        if (tok.isReset) activeStyles = [];
        else activeStyles.push(tok.value);
      }
      if (started && col < endCol) {
        out += tok.value;
        if (tok.isSgr) emittedStyle = !tok.isReset;
      }
      continue;
    }

    const nextCol = col + tok.width;
    if (nextCol > startCol && col < endCol) {
      if (!started) {
        started = true;
        if (activeStyles.length > 0) {
          out += activeStyles.join("");
          emittedStyle = true;
        }
      }
      if (nextCol <= endCol) {
        out += tok.value;
      }
    }
    col = nextCol;
    if (col >= endCol) break;
  }

  if (emittedStyle || (started && activeStyles.length > 0)) {
    out += "\x1b[0m";
  }
  return out;
}

export function truncateAnsi(input: string, maxCols: number, ellipsis = glyphs.ellipsis): string {
  if (maxCols <= 0) return "";
  if (displayWidth(input) <= maxCols) return input;
  const eWidth = displayWidth(ellipsis);
  if (maxCols <= eWidth) return sliceAnsi(ellipsis, 0, maxCols);
  return `${sliceAnsi(input, 0, maxCols - eWidth)}${ellipsis}`;
}

export function padEndAnsi(input: string, targetCols: number, fill = " "): string {
  const w = displayWidth(input);
  if (w >= targetCols) return input;
  return input + fill.repeat(targetCols - w);
}

export function padStartAnsi(input: string, targetCols: number, fill = " "): string {
  const w = displayWidth(input);
  if (w >= targetCols) return input;
  return fill.repeat(targetCols - w) + input;
}

function wrapSingleLine(line: string, maxCols: number): string[] {
  if (maxCols <= 4 || displayWidth(line) <= maxCols) return [line];
  const tokens = tokenizeAnsi(line);
  const rows: string[] = [];
  let activeStyles: string[] = [];
  let current = "";
  let currentWidth = 0;
  let lastBreakIdx = -1;
  let lastBreakStyles: string[] = [];

  const flushRow = (rowText: string, hasStyles: boolean) => {
    rows.push(hasStyles && rowText && !rowText.endsWith("\x1b[0m") ? `${rowText}\x1b[0m` : rowText);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === "ansi") {
      if (tok.isSgr) {
        if (tok.isReset) activeStyles = [];
        else activeStyles.push(tok.value);
      }
      current += tok.value;
      continue;
    }

    if (tok.value === " ") {
      lastBreakIdx = current.length;
      lastBreakStyles = [...activeStyles];
    }

    if (currentWidth + tok.width > maxCols && currentWidth > 0) {
      if (lastBreakIdx > 0 && tok.value !== " ") {
        const before = current.slice(0, lastBreakIdx);
        const after = current.slice(lastBreakIdx + 1);
        flushRow(before, activeStyles.length > 0 || lastBreakStyles.length > 0);
        const reopen = lastBreakStyles.join("");
        current = `${reopen}${after}${tok.value}`;
        currentWidth = displayWidth(after) + tok.width;
        lastBreakIdx = -1;
      } else {
        flushRow(current, activeStyles.length > 0);
        const reopen = activeStyles.join("");
        if (tok.value === " ") {
          current = reopen;
          currentWidth = 0;
        } else {
          current = `${reopen}${tok.value}`;
          currentWidth = tok.width;
        }
        lastBreakIdx = -1;
      }
      continue;
    }

    current += tok.value;
    currentWidth += tok.width;
  }

  if (current || rows.length === 0) {
    flushRow(current, activeStyles.length > 0);
  }
  return rows;
}

export function wrapAnsi(input: string, maxCols: number): string[] {
  const lines = input.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    out.push(...wrapSingleLine(line, maxCols));
  }
  return out;
}

export function hyperlink(label: string, url: string, enabled?: boolean): string {
  const allow = enabled ?? (Boolean(process.stdout.isTTY) && detectColorDepth() !== "none");
  if (!allow || !url) return label;
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

export function beginSync(): string {
  return "\x1b[?2026h";
}

export function endSync(): string {
  return "\x1b[?2026l";
}

export function termWidth(fallback = 80): number {
  const cols = process.stdout.columns;
  return typeof cols === "number" && cols >= 20 ? cols : fallback;
}

export function termHeight(fallback = 24): number {
  const rows = process.stdout.rows;
  return typeof rows === "number" && rows >= 8 ? rows : fallback;
}

export function horizontalRule(width: number, label?: string, depth?: ColorDepth): string {
  const w = Math.max(8, width);
  if (!label) {
    return theme.border(glyphs.rule.repeat(w), depth);
  }
  const cleanLabel = ` ${label} `;
  const labelW = displayWidth(cleanLabel);
  if (labelW + 4 >= w) {
    return truncateAnsi(label, w);
  }
  const left = 2;
  const right = Math.max(2, w - left - labelW);
  return `${theme.border(glyphs.rule.repeat(left), depth)}${cleanLabel}${theme.border(glyphs.rule.repeat(right), depth)}`;
}

export function renderBox(
  contentLines: string[],
  opts: {
    width?: number;
    title?: string;
    borderStyle?: (s: string) => string;
    paddingX?: number;
  } = {},
): string[] {
  const maxWidth = opts.width ?? termWidth(80);
  const padX = opts.paddingX ?? 1;
  const innerWidth = Math.max(8, maxWidth - 2 - padX * 2);
  const border = opts.borderStyle ?? ((s: string) => theme.border(s));
  const out: string[] = [];

  if (opts.title) {
    const titleStr = ` ${opts.title} `;
    const titleW = displayWidth(titleStr);
    const fillRight = Math.max(1, maxWidth - 3 - titleW);
    out.push(`${border(glyphs.topLeft + glyphs.rule)}${titleStr}${border(glyphs.rule.repeat(fillRight) + glyphs.topRight)}`);
  } else {
    out.push(border(`${glyphs.topLeft}${glyphs.rule.repeat(Math.max(2, maxWidth - 2))}${glyphs.topRight}`));
  }

  const padStr = " ".repeat(padX);
  for (const rawLine of contentLines) {
    const wrapped = wrapAnsi(rawLine, innerWidth);
    for (const row of wrapped) {
      const fitted = padEndAnsi(truncateAnsi(row, innerWidth), innerWidth);
      out.push(`${border(glyphs.pipe)}${padStr}${fitted}${padStr}${border(glyphs.pipe)}`);
    }
  }

  out.push(border(`${glyphs.bottomLeft}${glyphs.rule.repeat(Math.max(2, maxWidth - 2))}${glyphs.bottomRight}`));
  return out;
}
