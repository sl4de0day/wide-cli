export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "none";

export interface PaletteColor {
  rgb: readonly [number, number, number];
  ansi256: number;
  ansi16Fg: number;
  ansi16Bg: number;
}

export const NORD = {
  accent: { rgb: [94, 129, 172], ansi256: 67, ansi16Fg: 34, ansi16Bg: 44 },
  frost: { rgb: [136, 192, 208], ansi256: 110, ansi16Fg: 36, ansi16Bg: 46 },
  teal: { rgb: [143, 188, 187], ansi256: 109, ansi16Fg: 36, ansi16Bg: 46 },
  blue: { rgb: [129, 161, 193], ansi256: 110, ansi16Fg: 34, ansi16Bg: 44 },
  sage: { rgb: [163, 190, 140], ansi256: 108, ansi16Fg: 32, ansi16Bg: 42 },
  sand: { rgb: [235, 203, 139], ansi256: 222, ansi16Fg: 33, ansi16Bg: 43 },
  amber: { rgb: [208, 135, 112], ansi256: 173, ansi16Fg: 33, ansi16Bg: 43 },
  rose: { rgb: [191, 97, 106], ansi256: 131, ansi16Fg: 31, ansi16Bg: 41 },
  lavender: { rgb: [180, 142, 173], ansi256: 139, ansi16Fg: 35, ansi16Bg: 45 },
  fgBright: { rgb: [236, 239, 244], ansi256: 255, ansi16Fg: 97, ansi16Bg: 47 },
  fg: { rgb: [216, 222, 233], ansi256: 253, ansi16Fg: 37, ansi16Bg: 47 },
  fgMuted: { rgb: [154, 166, 189], ansi256: 146, ansi16Fg: 90, ansi16Bg: 40 },
  fgFaint: { rgb: [109, 122, 145], ansi256: 60, ansi16Fg: 90, ansi16Bg: 40 },
  border: { rgb: [76, 86, 106], ansi256: 60, ansi16Fg: 90, ansi16Bg: 40 },
  surface: { rgb: [46, 52, 64], ansi256: 236, ansi16Fg: 30, ansi16Bg: 40 },
  surfaceRaised: { rgb: [59, 66, 82], ansi256: 238, ansi16Fg: 30, ansi16Bg: 40 },
  surfaceSelected: { rgb: [67, 76, 94], ansi256: 239, ansi16Fg: 30, ansi16Bg: 40 },
  diffAddBg: { rgb: [42, 54, 46], ansi256: 22, ansi16Fg: 32, ansi16Bg: 42 },
  diffAddWordBg: { rgb: [58, 82, 62], ansi256: 28, ansi16Fg: 32, ansi16Bg: 42 },
  diffDelBg: { rgb: [58, 39, 43], ansi256: 52, ansi16Fg: 31, ansi16Bg: 41 },
  diffDelWordBg: { rgb: [86, 48, 56], ansi256: 88, ansi16Fg: 31, ansi16Bg: 41 },
} as const satisfies Record<string, PaletteColor>;

let globalColorOverride: ColorDepth | undefined;

export function setColorDepthOverride(depth?: ColorDepth): void {
  globalColorOverride = depth;
}

export function detectColorDepth(explicit?: ColorDepth): ColorDepth {
  if (explicit) return explicit;
  if (globalColorOverride) return globalColorOverride;
  if (
    process.env.NO_COLOR !== undefined ||
    process.env.NODE_DISABLE_COLORS !== undefined ||
    process.argv.includes("--no-color")
  ) {
    return "none";
  }
  const forceColor = process.env.FORCE_COLOR;
  if (forceColor === "0" || forceColor === "false") return "none";
  if (!process.stdout.isTTY && !forceColor) {
    return "none";
  }
  if (forceColor === "3") return "truecolor";
  if (forceColor === "2") return "ansi256";
  if (forceColor === "1") return "ansi16";

  const colorTerm = (process.env.COLORTERM || "").toLowerCase();
  const termProgram = process.env.TERM_PROGRAM || "";
  const term = (process.env.TERM || "").toLowerCase();
  if (
    colorTerm === "truecolor" ||
    colorTerm === "24bit" ||
    Boolean(process.env.WT_SESSION) ||
    (process.platform === "win32" && termProgram !== "Apple_Terminal") ||
    term.includes("24bit") ||
    term.includes("truecolor") ||
    term.includes("kitty") ||
    term.includes("alacritty") ||
    term.includes("wezterm") ||
    termProgram === "vscode" ||
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "Ghostty" ||
    termProgram === "Hyper"
  ) {
    return "truecolor";
  }
  if (term.includes("256color") || term.includes("xterm") || term.includes("screen") || term.includes("tmux")) {
    return "ansi256";
  }
  return "ansi16";
}

export function supportsUnicode(): boolean {
  if (process.env.WIDE_ASCII === "1") return false;
  if (process.platform === "win32") {
    return Boolean(
      process.env.WT_SESSION ||
      process.env.TERM_PROGRAM === "vscode" ||
      process.env.TERM_PROGRAM === "WezTerm" ||
      process.env.TERM_PROGRAM === "Alacritty" ||
      process.env.ConEmuTask ||
      process.env.TERM === "xterm-256color" ||
      process.env.ANSICON ||
      true,
    );
  }
  const lang = `${process.env.LC_ALL || ""}${process.env.LC_CTYPE || ""}${process.env.LANG || ""}`.toLowerCase();
  if (lang && !lang.includes("utf") && lang === "c") return false;
  return true;
}

export function fgCode(color: PaletteColor, depth = detectColorDepth()): string {
  if (depth === "none") return "";
  if (depth === "truecolor") return `\x1b[38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}m`;
  if (depth === "ansi256") return `\x1b[38;5;${color.ansi256}m`;
  return `\x1b[${color.ansi16Fg}m`;
}

export function bgCode(color: PaletteColor, depth = detectColorDepth()): string {
  if (depth === "none") return "";
  if (depth === "truecolor") return `\x1b[48;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}m`;
  if (depth === "ansi256") return `\x1b[48;5;${color.ansi256}m`;
  return `\x1b[${color.ansi16Bg}m`;
}

export interface StyleOptions {
  fg?: PaletteColor;
  bg?: PaletteColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  depth?: ColorDepth;
}

export function paint(text: string, opts: StyleOptions): string {
  const depth = detectColorDepth(opts.depth);
  if (depth === "none" || !text) return text;
  let prefix = "";
  if (opts.bold) prefix += "\x1b[1m";
  if (opts.dim) prefix += "\x1b[2m";
  if (opts.italic) prefix += "\x1b[3m";
  if (opts.underline) prefix += "\x1b[4m";
  if (opts.inverse) prefix += "\x1b[7m";
  if (opts.strikethrough) prefix += "\x1b[9m";
  if (opts.fg) prefix += fgCode(opts.fg, depth);
  if (opts.bg) prefix += bgCode(opts.bg, depth);
  if (!prefix) return text;
  return `${prefix}${text}\x1b[0m`;
}

export type BadgeTone = "accent" | "info" | "ok" | "warn" | "high" | "error" | "muted";

function toneColor(tone: BadgeTone): PaletteColor {
  if (tone === "accent") return NORD.accent;
  if (tone === "info") return NORD.frost;
  if (tone === "ok") return NORD.sage;
  if (tone === "warn") return NORD.sand;
  if (tone === "high") return NORD.amber;
  if (tone === "error") return NORD.rose;
  return NORD.fgMuted;
}

export const glyphs = {
  get dot(): string {
    return supportsUnicode() ? "●" : "*";
  },
  get circle(): string {
    return supportsUnicode() ? "○" : "o";
  },
  get pointer(): string {
    return supportsUnicode() ? "▸" : ">";
  },
  get prompt(): string {
    return supportsUnicode() ? "›" : ">";
  },
  get check(): string {
    return supportsUnicode() ? "●" : "ok";
  },
  get cross(): string {
    return supportsUnicode() ? "×" : "x";
  },
  get warn(): string {
    return supportsUnicode() ? "▲" : "!";
  },
  get middot(): string {
    return supportsUnicode() ? "·" : "|";
  },
  get pipe(): string {
    return supportsUnicode() ? "│" : "|";
  },
  get tee(): string {
    return supportsUnicode() ? "├" : "|";
  },
  get elbow(): string {
    return supportsUnicode() ? "└" : "`";
  },
  get rule(): string {
    return supportsUnicode() ? "─" : "-";
  },
  get heavyRule(): string {
    return supportsUnicode() ? "━" : "=";
  },
  get topLeft(): string {
    return supportsUnicode() ? "╭" : "+";
  },
  get topRight(): string {
    return supportsUnicode() ? "╮" : "+";
  },
  get bottomLeft(): string {
    return supportsUnicode() ? "╰" : "+";
  },
  get bottomRight(): string {
    return supportsUnicode() ? "╯" : "+";
  },
  get ellipsis(): string {
    return supportsUnicode() ? "…" : "...";
  },
};

export const theme = {
  accent: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.accent, depth }),
  accentBold: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.accent, bold: true, depth }),
  info: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.frost, depth }),
  infoBold: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.frost, bold: true, depth }),
  teal: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.teal, depth }),
  blue: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.blue, depth }),
  ok: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.sage, depth }),
  okBold: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.sage, bold: true, depth }),
  warn: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.sand, depth }),
  warnBold: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.sand, bold: true, depth }),
  high: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.amber, depth }),
  highBold: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.amber, bold: true, depth }),
  error: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.rose, depth }),
  errorBold: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.rose, bold: true, depth }),
  lavender: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.lavender, depth }),
  fg: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fg, depth }),
  fgBright: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgBright, depth }),
  fgBold: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgBright, bold: true, depth }),
  muted: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgMuted, depth }),
  faint: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgFaint, depth }),
  border: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.border, depth }),
  bold: (t: string, depth?: ColorDepth) => paint(t, { bold: true, depth }),
  dim: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgFaint, depth }),
  italic: (t: string, depth?: ColorDepth) => paint(t, { italic: true, depth }),
  underline: (t: string, depth?: ColorDepth) => paint(t, { underline: true, depth }),
  strikethrough: (t: string, depth?: ColorDepth) => paint(t, { strikethrough: true, depth }),
  inverse: (t: string, depth?: ColorDepth) => paint(t, { inverse: true, depth }),
  inlineCode: (t: string, depth?: ColorDepth) => {
    const resolved = detectColorDepth(depth);
    if (resolved === "truecolor" || resolved === "ansi256") {
      return paint(` ${t} `, { fg: NORD.frost, bg: NORD.surfaceRaised, depth: resolved });
    }
    return paint(t, { fg: NORD.frost, depth: resolved });
  },
  selectedRow: (t: string, depth?: ColorDepth) => {
    const resolved = detectColorDepth(depth);
    if (resolved === "truecolor" || resolved === "ansi256") {
      return paint(t, { fg: NORD.fgBright, bg: NORD.surfaceSelected, bold: true, depth: resolved });
    }
    return paint(t, { inverse: true, depth: resolved });
  },
  badge: (label: string, tone: BadgeTone = "accent", depth?: ColorDepth) => {
    const resolved = detectColorDepth(depth);
    if (resolved === "none") return `[${label}]`;
    const color = toneColor(tone);
    if (resolved === "truecolor" || resolved === "ansi256") {
      return paint(` ${label} `, { fg: color, bg: NORD.surfaceRaised, bold: true, depth: resolved });
    }
    return paint(`[${label}]`, { fg: color, bold: true, depth: resolved });
  },
  pill: (label: string, tone: BadgeTone = "accent", depth?: ColorDepth) => {
    const resolved = detectColorDepth(depth);
    if (resolved === "none") return `[${label}]`;
    const color = toneColor(tone);
    if (tone === "error") {
      return paint(` ${label} `, { fg: NORD.fgBright, bg: NORD.rose, bold: true, depth: resolved });
    }
    if (tone === "high") {
      return paint(` ${label} `, { fg: NORD.surface, bg: NORD.amber, bold: true, depth: resolved });
    }
    if (tone === "warn") {
      return paint(` ${label} `, { fg: NORD.surface, bg: NORD.sand, bold: true, depth: resolved });
    }
    if (tone === "ok") {
      return paint(` ${label} `, { fg: NORD.surface, bg: NORD.sage, bold: true, depth: resolved });
    }
    return paint(` ${label} `, { fg: NORD.fgBright, bg: color, bold: true, depth: resolved });
  },
  severity: (severity: string, depth?: ColorDepth) => {
    const upper = severity.toUpperCase();
    if (upper === "CRITICAL") return theme.pill("CRIT", "error", depth);
    if (upper === "HIGH") return theme.badge("HIGH", "high", depth);
    if (upper === "MEDIUM") return theme.badge("MED", "warn", depth);
    if (upper === "LOW") return theme.badge("LOW", "muted", depth);
    return theme.badge(upper, "info", depth);
  },
  syn: {
    text: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fg, depth }),
    keyword: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.blue, depth }),
    string: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.sage, depth }),
    number: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.lavender, depth }),
    fn: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.frost, depth }),
    type: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.teal, depth }),
    comment: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgFaint, italic: true, depth }),
    punct: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgMuted, depth }),
  },
  diff: {
    addLine: (t: string, depth?: ColorDepth) => {
      const resolved = detectColorDepth(depth);
      return paint(t, {
        fg: NORD.sage,
        bg: resolved === "truecolor" ? NORD.diffAddBg : undefined,
        depth: resolved,
      });
    },
    addWord: (t: string, depth?: ColorDepth) => {
      const resolved = detectColorDepth(depth);
      return paint(t, {
        fg: NORD.fgBright,
        bg: resolved === "truecolor" || resolved === "ansi256" ? NORD.diffAddWordBg : undefined,
        bold: true,
        depth: resolved,
      });
    },
    delLine: (t: string, depth?: ColorDepth) => {
      const resolved = detectColorDepth(depth);
      return paint(t, {
        fg: NORD.rose,
        bg: resolved === "truecolor" ? NORD.diffDelBg : undefined,
        depth: resolved,
      });
    },
    delWord: (t: string, depth?: ColorDepth) => {
      const resolved = detectColorDepth(depth);
      return paint(t, {
        fg: NORD.fgBright,
        bg: resolved === "truecolor" || resolved === "ansi256" ? NORD.diffDelWordBg : undefined,
        bold: true,
        depth: resolved,
      });
    },
    hunk: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.frost, depth }),
    context: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgMuted, depth }),
    gutter: (t: string, depth?: ColorDepth) => paint(t, { fg: NORD.fgFaint, depth }),
  },
};
