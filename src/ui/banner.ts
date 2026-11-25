import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { horizontalRule, termHeight, termWidth, truncateAnsi } from "./ansi.js";
import { detectColorDepth as detectThemeColorDepth, glyphs, theme } from "./theme.js";

export type ColorMode = "truecolor" | "ansi256" | "none";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface LogoRenderOptions {
  cols?: number;
  pixelRows?: number;
  logoPath?: string;
  colorMode?: ColorMode;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let cachedImagePath: string | null = null;
let cachedImageData: RgbaImage | null = null;

function resolveLogoPath(explicitPath?: string): string | null {
  if (explicitPath) {
    return existsSync(explicitPath) ? explicitPath : null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "assets", "logo.png"),
    join(here, "..", "..", "assets", "wide-logo.png"),
    join(process.cwd(), "assets", "logo.png"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pcDiff = Math.abs(p - c);
  if (pa <= pb && pa <= pcDiff) return a;
  return pb <= pcDiff ? b : c;
}

function channelsForColorType(colorType: number): number {
  if (colorType === 6) return 4;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 0 || colorType === 3) return 1;
  return 0;
}

export function decodePngRgba(buffer: Buffer): RgbaImage | null {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) return null;
    const chunkData = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      if (length < 13) return null;
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
    } else if (type === "PLTE") {
      palette = chunkData;
    } else if (type === "tRNS") {
      trns = chunkData;
    } else if (type === "IDAT") {
      idatChunks.push(chunkData);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 || idatChunks.length === 0) {
    return null;
  }

  const bpp = channelsForColorType(colorType);
  if (bpp === 0) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch {
    return null;
  }

  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prevOut = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const value = raw[rowIn + x];
      const a = x >= bpp ? pixels[rowOut + x - bpp] : 0;
      const b = y > 0 ? pixels[prevOut + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[prevOut + x - bpp] : 0;
      let decoded = value;
      if (filter === 1) decoded = (value + a) & 255;
      else if (filter === 2) decoded = (value + b) & 255;
      else if (filter === 3) decoded = (value + ((a + b) >> 1)) & 255;
      else if (filter === 4) decoded = (value + paethPredictor(a, b, c)) & 255;
      else if (filter !== 0) return null;
      pixels[rowOut + x] = decoded;
    }
  }

  if (colorType === 6) {
    return { width, height, data: pixels };
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const out = i * 4;
    if (colorType === 2) {
      const src = i * 3;
      rgba[out] = pixels[src];
      rgba[out + 1] = pixels[src + 1];
      rgba[out + 2] = pixels[src + 2];
      rgba[out + 3] = 255;
    } else if (colorType === 4) {
      const src = i * 2;
      rgba[out] = pixels[src];
      rgba[out + 1] = pixels[src];
      rgba[out + 2] = pixels[src];
      rgba[out + 3] = pixels[src + 1];
    } else if (colorType === 0) {
      const v = pixels[i];
      rgba[out] = v;
      rgba[out + 1] = v;
      rgba[out + 2] = v;
      rgba[out + 3] = 255;
    } else if (colorType === 3 && palette) {
      const idx = pixels[i];
      const pIdx = idx * 3;
      if (pIdx + 2 < palette.length) {
        rgba[out] = palette[pIdx];
        rgba[out + 1] = palette[pIdx + 1];
        rgba[out + 2] = palette[pIdx + 2];
      }
      rgba[out + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, data: rgba };
}

function fallbackBitmap(): RgbaImage {
  const empty: Pixel = { r: 0, g: 0, b: 0, a: 0 };
  const white: Pixel = { r: 255, g: 255, b: 255, a: 255 };
  const blue: Pixel = { r: 94, g: 129, b: 172, a: 255 };
  const grid = [
    empty, white, empty,
    blue, white, white,
    blue, blue, empty,
  ];
  const data = new Uint8Array(grid.length * 4);
  for (let i = 0; i < grid.length; i++) {
    data[i * 4] = grid[i].r;
    data[i * 4 + 1] = grid[i].g;
    data[i * 4 + 2] = grid[i].b;
    data[i * 4 + 3] = grid[i].a;
  }
  return { width: 3, height: 3, data };
}

function loadLogoImage(explicitPath?: string): RgbaImage {
  const resolved = resolveLogoPath(explicitPath);
  if (resolved) {
    if (cachedImagePath === resolved && cachedImageData) {
      return cachedImageData;
    }
    try {
      const decoded = decodePngRgba(readFileSync(resolved));
      if (decoded) {
        cachedImagePath = resolved;
        cachedImageData = decoded;
        return decoded;
      }
    } catch {
    }
  }
  return fallbackBitmap();
}

export function detectColorDepth(explicit?: ColorMode): ColorMode {
  if (explicit) return explicit;
  const resolved = detectThemeColorDepth();
  if (resolved === "truecolor") return "truecolor";
  if (resolved === "ansi256") return "ansi256";
  if (resolved === "ansi16") return "ansi256";
  return "none";
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const ri = Math.round((r / 255) * 5);
  const gi = Math.round((g / 255) * 5);
  const bi = Math.round((b / 255) * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

function fgEscape(p: Pixel, mode: ColorMode): string {
  if (mode === "truecolor") return `\x1b[38;2;${p.r};${p.g};${p.b}m`;
  if (mode === "ansi256") return `\x1b[38;5;${rgbToAnsi256(p.r, p.g, p.b)}m`;
  return "";
}

function bgEscape(p: Pixel, mode: ColorMode): string {
  if (mode === "truecolor") return `\x1b[48;2;${p.r};${p.g};${p.b}m`;
  if (mode === "ansi256") return `\x1b[48;5;${rgbToAnsi256(p.r, p.g, p.b)}m`;
  return "";
}

function samplePixel(image: RgbaImage, gx: number, gy: number, cols: number, pixelRows: number): Pixel {
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(((gx + 0.5) / cols) * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(((gy + 0.5) / pixelRows) * image.height)));
  const idx = (y * image.width + x) * 4;
  return {
    r: image.data[idx],
    g: image.data[idx + 1],
    b: image.data[idx + 2],
    a: image.data[idx + 3],
  };
}

function sameColor(a: Pixel, b: Pixel): boolean {
  return Math.abs(a.r - b.r) <= 4 && Math.abs(a.g - b.g) <= 4 && Math.abs(a.b - b.b) <= 4;
}

function isOpaque(p: Pixel): boolean {
  return p.a >= 128;
}

function monochromeGlyph(top: Pixel, bot: Pixel): string {
  const topOn = isOpaque(top);
  const botOn = isOpaque(bot);
  if (!topOn && !botOn) return " ";
  if (topOn && !botOn) return "▀";
  if (!topOn && botOn) return "▄";
  const luma = (top.r + top.g + top.b + bot.r + bot.g + bot.b) / 6;
  return luma >= 190 ? "█" : "▓";
}

export function renderLogoLines(options: LogoRenderOptions = {}): string[] {
  const image = loadLogoImage(options.logoPath);
  const cols = Math.max(6, options.cols ?? 12);
  const rawRows = options.pixelRows ?? Math.max(4, Math.round((cols * image.height) / image.width));
  const pixelRows = rawRows % 2 === 0 ? rawRows : rawRows + 1;
  const mode = detectColorDepth(options.colorMode);
  const lines: string[] = [];

  for (let gy = 0; gy < pixelRows; gy += 2) {
    let row = "";
    let activeStyle = "";

    for (let gx = 0; gx < cols; gx++) {
      const top = samplePixel(image, gx, gy, cols, pixelRows);
      const bot = samplePixel(image, gx, gy + 1, cols, pixelRows);

      if (mode === "none") {
        row += monochromeGlyph(top, bot);
        continue;
      }

      const topOn = isOpaque(top);
      const botOn = isOpaque(bot);
      let style = "";
      let ch = " ";

      if (topOn && botOn) {
        if (sameColor(top, bot)) {
          style = fgEscape(top, mode);
          ch = "█";
        } else {
          style = fgEscape(top, mode) + bgEscape(bot, mode);
          ch = "▀";
        }
      } else if (topOn) {
        style = fgEscape(top, mode);
        ch = "▀";
      } else if (botOn) {
        style = fgEscape(bot, mode);
        ch = "▄";
      }

      if (style !== activeStyle) {
        if (activeStyle) row += "\x1b[0m";
        if (style) row += style;
        activeStyle = style;
      }
      row += ch;
    }

    if (activeStyle) row += "\x1b[0m";
    lines.push(row);
  }

  return lines;
}

export function formatBannerLines(version = "0.9.251126", options: LogoRenderOptions = {}): string[] {
  const logoLines = renderLogoLines(options);
  const depth = detectColorDepth(options.colorMode);
  const titleLine = `${theme.fgBold("Wide", depth)} ${theme.faint(`v${version}`, depth)}`;
  const subtitleLine = theme.muted("Security-First Autonomous AI Agent", depth);
  const hintLine = `${theme.faint("Type", depth)} ${theme.accent("/help", depth)} ${theme.faint("for commands", depth)} ${theme.faint(glyphs.middot, depth)} ${theme.accent("@file", depth)} ${theme.faint("context", depth)} ${theme.faint(glyphs.middot, depth)} ${theme.accent("Shift+Tab", depth)} ${theme.faint("mode", depth)}`;

  const columns = termWidth(80);
  const sideBySide = columns >= 68 && logoLines.length >= 5;

  if (!sideBySide) {
    return [
      ...logoLines.map((line) => `  ${line}`),
      "",
      `  ${titleLine}`,
      `  ${subtitleLine}`,
      `  ${hintLine}`,
    ];
  }

  const infoMap = new Map<number, string>([
    [1, titleLine],
    [2, subtitleLine],
    [4, hintLine],
  ]);

  return logoLines.map((line, index) => {
    const info = infoMap.get(index);
    return info ? `  ${line}   ${info}` : `  ${line}`;
  });
}

export interface WelcomeHeaderOptions {
  version?: string;
  providerLabel: string;
  providerReady: boolean;
  toolMode: string;
  permissionProfile: string;
  allowBrowser: boolean;
  workspace: string;
  gitBranch?: string;
  gitDirty?: boolean;
  ruleCount?: number;
  advisoryCount?: number;
}

export function printWelcomeHeader(opts: WelcomeHeaderOptions): void {
  const version = opts.version || "0.9.251126";
  const cols = termWidth(80);
  const rows = termHeight(24);
  const compact = cols < 68 || rows < 20;

  const modelPart = opts.providerReady
    ? theme.info(opts.providerLabel)
    : `${theme.warn("unconfigured")} ${theme.faint("(/setup)")}`;
  const gitPart = opts.gitBranch
    ? ` ${theme.faint(glyphs.middot)} ${theme.accent(`git:${opts.gitBranch}${opts.gitDirty ? "*" : ""}`)}`
    : "";
  const rulesPart =
    typeof opts.ruleCount === "number" && opts.ruleCount > 0
      ? ` ${theme.faint(glyphs.middot)} ${theme.muted(`${opts.ruleCount} rules`)}${opts.advisoryCount ? theme.faint(` / ${opts.advisoryCount} OSV`) : ""}`
      : "";

  console.log("");
  if (compact) {
    console.log(
      `  ${theme.fgBold("Wide")} ${theme.faint(`v${version}`)} ${theme.faint(glyphs.middot)} ${modelPart} ${theme.faint(glyphs.middot)} ${theme.accent(opts.toolMode)}${gitPart}`,
    );
    console.log(`  ${theme.faint(truncateAnsi(opts.workspace, Math.max(24, cols - 4)))}`);
    console.log(`  ${horizontalRule(Math.min(cols - 4, 88))}`);
    console.log("");
    return;
  }

  const logoLines = renderLogoLines();
  const titleLine = `${theme.fgBold("Wide")} ${theme.faint(`v${version}`)}  ${theme.badge(opts.toolMode.toUpperCase(), "accent")} ${theme.badge(opts.permissionProfile.toUpperCase(), opts.permissionProfile === "plan" ? "info" : opts.permissionProfile === "auto" ? "high" : "muted")}`;
  const modelLine = `${theme.faint("Model")}     ${modelPart}${gitPart}`;
  const scopeLine = `${theme.faint("Workspace")} ${theme.muted(truncateAnsi(opts.workspace, Math.max(24, cols - 32)))}`;
  const statsLine = `${theme.faint("Security")}  ${theme.muted(`Browser ${opts.allowBrowser ? "ON" : "OFF"}`)}${rulesPart}`;
  const tipsLine = `${theme.accent("/")} ${theme.faint("commands")}  ${theme.accent("@")} ${theme.faint("files")}  ${theme.accent("!")} ${theme.faint("shell")}  ${theme.accent("Shift+Tab")} ${theme.faint("permissions")}  ${theme.accent("Esc")} ${theme.faint("interrupt")}`;

  const infoMap = new Map<number, string>([
    [0, titleLine],
    [1, modelLine],
    [2, scopeLine],
    [3, statsLine],
    [5, tipsLine],
  ]);

  for (let i = 0; i < logoLines.length; i++) {
    const info = infoMap.get(i);
    const line = info ? `  ${logoLines[i]}   ${info}` : `  ${logoLines[i]}`;
    console.log(truncateAnsi(line, Math.max(30, cols - 1)));
  }
  console.log("");
}

export function printBanner(version = "0.9.251126") {
  console.log("");
  for (const line of formatBannerLines(version)) {
    console.log(line);
  }
  console.log("");
}
