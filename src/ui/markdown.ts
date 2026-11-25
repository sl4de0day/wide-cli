import { displayWidth, horizontalRule, hyperlink, padEndAnsi, termWidth, truncateAnsi, wrapAnsi } from "./ansi.js";
import { detectColorDepth, glyphs, NORD, paint, theme, type ColorDepth } from "./theme.js";

const KEYWORDS_COMMON = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if",
  "implements", "import", "in", "instanceof", "interface", "let", "new", "null", "of", "package",
  "private", "protected", "public", "readonly", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
  "def", "elif", "except", "None", "True", "False", "lambda", "pass", "raise", "with", "as",
  "fn", "pub", "mut", "impl", "struct", "trait", "match", "mod", "use", "where", "crate", "self",
  "func", "go", "defer", "chan", "select", "range", "map", "SELECT", "FROM", "WHERE", "INSERT",
  "INTO", "UPDATE", "DELETE", "CREATE", "TABLE", "JOIN", "LEFT", "RIGHT", "INNER", "ON", "GROUP",
  "ORDER", "BY", "LIMIT", "VALUES", "SET", "AND", "OR", "NOT", "AS", "DISTINCT", "COUNT",
]);

const TYPES_COMMON = new Set([
  "string", "number", "boolean", "unknown", "never", "any", "object", "symbol", "bigint",
  "Promise", "Array", "Record", "Map", "Set", "Error", "Date", "RegExp", "Buffer", "Uint8Array",
  "int", "float", "str", "bool", "list", "dict", "tuple", "Optional", "Union",
  "usize", "isize", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64", "String", "Vec", "Option", "Result",
]);

export function highlightCodeLine(line: string, lang: string, depth = detectColorDepth()): string {
  if (depth === "none" || !line) return line;
  const lowerLang = lang.toLowerCase();
  const hashComment = ["py", "python", "sh", "bash", "zsh", "ps1", "powershell", "yaml", "yml", "rb", "ruby", "toml", "dockerfile"].includes(lowerLang);
  const dashComment = lowerLang === "sql";

  let out = "";
  let i = 0;
  const len = line.length;

  while (i < len) {
    const ch = line[i];
    const next = line[i + 1] || "";

    if (!hashComment && !dashComment && ch === "/" && next === "/") {
      out += theme.syn.comment(line.slice(i), depth);
      break;
    }
    if (hashComment && ch === "#") {
      out += theme.syn.comment(line.slice(i), depth);
      break;
    }
    if (dashComment && ch === "-" && next === "-") {
      out += theme.syn.comment(line.slice(i), depth);
      break;
    }
    if (ch === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      const seg = end >= 0 ? line.slice(i, end + 2) : line.slice(i);
      out += theme.syn.comment(seg, depth);
      i += seg.length;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      const seg = line.slice(i, j);
      if (lowerLang === "json" && /^\s*:/.test(line.slice(j))) {
        out += theme.syn.fn(seg, depth);
      } else {
        out += theme.syn.string(seg, depth);
      }
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(line[i - 1]))) {
      let j = i + 1;
      while (j < len && /[0-9a-fA-FxXoObB._]/.test(line[j])) j++;
      out += theme.syn.number(line.slice(i, j), depth);
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$-]/.test(line[j])) {
        if (line[j] === "-" && lowerLang !== "css" && lowerLang !== "html") break;
        j++;
      }
      const word = line.slice(i, j);
      if (KEYWORDS_COMMON.has(word) || (dashComment && KEYWORDS_COMMON.has(word.toUpperCase()))) {
        out += theme.syn.keyword(word, depth);
      } else if (TYPES_COMMON.has(word) || (/^[A-Z][A-Za-z0-9_]+$/.test(word) && word.length > 1)) {
        out += theme.syn.type(word, depth);
      } else if (line[j] === "(") {
        out += theme.syn.fn(word, depth);
      } else {
        out += theme.syn.text(word, depth);
      }
      i = j;
      continue;
    }

    if (/[{}()[\].,;:=<>!+\-*/%&|^~?]/.test(ch)) {
      out += theme.syn.punct(ch, depth);
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

export function renderInlineMarkdown(text: string, depth = detectColorDepth()): string {
  if (!text) return "";
  let out = "";
  let i = 0;
  const len = text.length;

  while (i < len) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        const code = text.slice(i + 1, end);
        out += theme.inlineCode(code, depth);
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket > i && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 2) {
          const label = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen).trim();
          const styled = theme.info(theme.underline(label, depth), depth);
          const linked = hyperlink(styled, url, depth !== "none" && Boolean(process.stdout.isTTY));
          out += depth === "none" ? `${label} (${url})` : linked;
          i = closeParen + 1;
          continue;
        }
      }
    }

    if (text.startsWith("**", i) || text.startsWith("__", i)) {
      const marker = text.slice(i, i + 2);
      const end = text.indexOf(marker, i + 2);
      if (end > i + 2) {
        const inner = text.slice(i + 2, end);
        out += theme.fgBold(inner, depth);
        i = end + 2;
        continue;
      }
    }

    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        const inner = text.slice(i + 2, end);
        out += theme.strikethrough(theme.muted(inner, depth), depth);
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "*" && text[i + 1] !== "*" && text[i + 1] !== " ") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && text[end - 1] !== " ") {
        const inner = text.slice(i + 1, end);
        out += theme.italic(inner, depth);
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith("https://", i) || text.startsWith("http://", i)) {
      let j = i;
      while (j < len && !/[\s)<>"'`]/.test(text[j])) j++;
      let url = text.slice(i, j);
      let trailing = "";
      while (url.length > 0 && /[.,;:!?]$/.test(url)) {
        trailing = url[url.length - 1] + trailing;
        url = url.slice(0, -1);
      }
      const styled = theme.info(url, depth);
      out += hyperlink(styled, url, depth !== "none" && Boolean(process.stdout.isTTY)) + trailing;
      i = j;
      continue;
    }

    out += text[i];
    i++;
  }

  return out;
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function renderMarkdownTable(rawLines: string[], maxCols: number, depth = detectColorDepth()): string[] {
  if (rawLines.length < 2) {
    return rawLines.map((l) => renderInlineMarkdown(l, depth));
  }
  const hasSep = isTableSeparator(rawLines[1]);
  const header = parseTableRow(rawLines[0]);
  const bodyRows = (hasSep ? rawLines.slice(2) : rawLines.slice(1)).map(parseTableRow);
  const colCount = Math.max(header.length, ...bodyRows.map((r) => r.length));
  if (colCount === 0) return rawLines;

  const normalizedRows = [header, ...bodyRows].map((row) => {
    const padded = [...row];
    while (padded.length < colCount) padded.push("");
    return padded;
  });

  const renderedCells = normalizedRows.map((row, rowIdx) =>
    row.map((cell) => (rowIdx === 0 ? theme.fgBold(renderInlineMarkdown(cell, depth), depth) : renderInlineMarkdown(cell, depth))),
  );

  const naturalWidths = Array.from({ length: colCount }, (_, col) =>
    Math.max(3, ...renderedCells.map((r) => displayWidth(r[col]))),
  );

  const overhead = 2 + colCount * 3 + 1;
  const available = Math.max(colCount * 4, maxCols - overhead);
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
  const widths = [...naturalWidths];
  if (totalNatural > available) {
    let excess = totalNatural - available;
    while (excess > 0) {
      let maxIdx = 0;
      for (let c = 1; c < colCount; c++) {
        if (widths[c] > widths[maxIdx]) maxIdx = c;
      }
      if (widths[maxIdx] <= 4) break;
      widths[maxIdx] -= 1;
      excess -= 1;
    }
  }

  const b = (s: string) => theme.border(s, depth);
  const top = `  ${b(`${glyphs.topLeft}${widths.map((w) => glyphs.rule.repeat(w + 2)).join("┬")}${glyphs.topRight}`)}`;
  const mid = `  ${b(`├${widths.map((w) => glyphs.rule.repeat(w + 2)).join("┼")}┤`)}`;
  const bot = `  ${b(`${glyphs.bottomLeft}${widths.map((w) => glyphs.rule.repeat(w + 2)).join("┴")}${glyphs.bottomRight}`)}`;

  const formatRow = (cells: string[]): string => {
    const inner = cells
      .map((cell, idx) => ` ${padEndAnsi(truncateAnsi(cell, widths[idx]), widths[idx])} `)
      .join(b(glyphs.pipe));
    return `  ${b(glyphs.pipe)}${inner}${b(glyphs.pipe)}`;
  };

  const out: string[] = [top, formatRow(renderedCells[0])];
  if (renderedCells.length > 1) {
    out.push(mid);
    for (let r = 1; r < renderedCells.length; r++) {
      out.push(formatRow(renderedCells[r]));
    }
  }
  out.push(bot);
  return out;
}

export interface MarkdownRenderOptions {
  width?: number;
  colorDepth?: ColorDepth;
  indent?: string;
}

function renderSingleMarkdownLine(line: string, maxCols: number, depth: ColorDepth, indent: string): string[] {
  const usable = Math.max(20, maxCols - displayWidth(indent));
  const trimmed = line.trim();

  if (!trimmed) return [""];

  if (/^([-*_])\1{2,}$/.test(trimmed)) {
    return [`${indent}${horizontalRule(Math.min(usable, 72), undefined, depth)}`];
  }

  const headingMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const title = renderInlineMarkdown(headingMatch[2], depth);
    if (level === 1) {
      const styled = theme.fgBold(title, depth);
      const underlineW = Math.min(usable, Math.max(12, displayWidth(title)));
      return [`${indent}${styled}`, `${indent}${theme.accent(glyphs.rule.repeat(underlineW), depth)}`];
    }
    if (level === 2) {
      return [`${indent}${theme.accentBold(glyphs.pointer, depth)} ${theme.fgBold(title, depth)}`];
    }
    return [`${indent}${theme.infoBold(title, depth)}`];
  }

  const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
  if (quoteMatch) {
    const content = renderInlineMarkdown(quoteMatch[1], depth);
    const wrapped = wrapAnsi(theme.muted(content, depth), Math.max(16, usable - 3));
    return wrapped.map((w) => `${indent}${theme.accent(glyphs.pipe, depth)} ${w}`);
  }

  const taskMatch = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (taskMatch) {
    const pad = " ".repeat(Math.min(8, taskMatch[1].length));
    const checked = taskMatch[2].toLowerCase() === "x";
    const mark = checked ? theme.ok(glyphs.check, depth) : theme.faint(glyphs.circle, depth);
    const body = renderInlineMarkdown(taskMatch[3], depth);
    const prefix = `${indent}${pad}${mark} `;
    const contPrefix = `${indent}${pad}  `;
    const wrapped = wrapAnsi(body, Math.max(16, usable - pad.length - 2));
    return wrapped.map((w, idx) => `${idx === 0 ? prefix : contPrefix}${w}`);
  }

  const bulletMatch = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bulletMatch) {
    const pad = " ".repeat(Math.min(8, bulletMatch[1].length));
    const body = renderInlineMarkdown(bulletMatch[2], depth);
    const bullet = theme.accent(glyphs.dot, depth);
    const prefix = `${indent}${pad}${bullet} `;
    const contPrefix = `${indent}${pad}  `;
    const wrapped = wrapAnsi(body, Math.max(16, usable - pad.length - 2));
    return wrapped.map((w, idx) => `${idx === 0 ? prefix : contPrefix}${w}`);
  }

  const numMatch = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (numMatch) {
    const pad = " ".repeat(Math.min(8, numMatch[1].length));
    const marker = `${numMatch[2]}.`;
    const body = renderInlineMarkdown(numMatch[3], depth);
    const prefix = `${indent}${pad}${theme.info(marker, depth)} `;
    const contPrefix = `${indent}${pad}${" ".repeat(marker.length + 1)}`;
    const wrapped = wrapAnsi(body, Math.max(16, usable - pad.length - marker.length - 1));
    return wrapped.map((w, idx) => `${idx === 0 ? prefix : contPrefix}${w}`);
  }

  const inline = renderInlineMarkdown(line, depth);
  return wrapAnsi(inline, usable).map((w) => `${indent}${w}`);
}

function renderCodeHeader(lang: string, maxCols: number, depth: ColorDepth, indent: string): string {
  const usable = Math.max(20, maxCols - displayWidth(indent));
  const label = lang ? ` ${theme.info(lang, depth)} ` : "";
  const labelW = displayWidth(label);
  const fill = Math.max(2, Math.min(usable, 84) - 2 - labelW);
  return `${indent}${theme.border(`${glyphs.topLeft}${glyphs.rule}`, depth)}${label}${theme.border(glyphs.rule.repeat(fill), depth)}`;
}

function renderCodeFooter(maxCols: number, depth: ColorDepth, indent: string): string {
  const usable = Math.max(20, maxCols - displayWidth(indent));
  const fill = Math.max(4, Math.min(usable, 84) - 1);
  return `${indent}${theme.border(`${glyphs.bottomLeft}${glyphs.rule.repeat(fill)}`, depth)}`;
}

function renderCodeContentLine(line: string, lang: string, depth: ColorDepth, indent: string): string {
  const highlighted = highlightCodeLine(line, lang, depth);
  const content =
    depth === "truecolor"
      ? paint(` ${highlighted}`, { bg: NORD.surface, depth })
      : ` ${highlighted}`;
  return `${indent}${theme.border(glyphs.pipe, depth)}${content}`;
}

export function formatTerminalMarkdown(text: string, options: MarkdownRenderOptions = {}): string {
  if (!text) return "";
  const depth = detectColorDepth(options.colorDepth);
  const maxCols = options.width ?? termWidth(80);
  const indent = options.indent ?? "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  let inCode = false;
  let codeLang = "";
  let tableBuf: string[] = [];

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    if (tableBuf.length >= 2 && isTableSeparator(tableBuf[1])) {
      out.push(...renderMarkdownTable(tableBuf, maxCols, depth));
    } else {
      for (const tl of tableBuf) {
        out.push(...renderSingleMarkdownLine(tl, maxCols, depth, indent));
      }
    }
    tableBuf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushTable();
      if (!inCode) {
        inCode = true;
        codeLang = trimmed.slice(3).trim().split(/\s+/)[0] || "";
        out.push(renderCodeHeader(codeLang, maxCols, depth, indent));
      } else {
        inCode = false;
        out.push(renderCodeFooter(maxCols, depth, indent));
        codeLang = "";
      }
      continue;
    }

    if (inCode) {
      out.push(renderCodeContentLine(line, codeLang, depth, indent));
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.includes("|", 1)) {
      tableBuf.push(line);
      continue;
    }

    flushTable();
    out.push(...renderSingleMarkdownLine(line, maxCols, depth, indent));
  }

  flushTable();
  if (inCode) {
    out.push(renderCodeFooter(maxCols, depth, indent));
  }

  return out.join("\n");
}

export class StreamingMarkdownRenderer {
  private stream: NodeJS.WriteStream;
  private depth: ColorDepth;
  private indent: string;
  private lineBuf = "";
  private inCode = false;
  private codeLang = "";
  private tableBuf: string[] = [];
  private hasLivePreview = false;
  private emittedAny = false;

  constructor(options: { stream?: NodeJS.WriteStream; colorDepth?: ColorDepth; indent?: string } = {}) {
    this.stream = options.stream ?? process.stdout;
    this.depth = detectColorDepth(options.colorDepth);
    this.indent = options.indent ?? "  ";
  }

  public hasOutput(): boolean {
    return this.emittedAny;
  }

  private clearLivePreview(): void {
    if (this.hasLivePreview && this.stream.isTTY) {
      this.stream.write("\r\x1B[2K");
      this.hasLivePreview = false;
    }
  }

  private commitLines(lines: string[]): void {
    this.clearLivePreview();
    for (const l of lines) {
      this.stream.write(`${l}\n`);
    }
    this.emittedAny = true;
  }

  private flushTable(): void {
    if (this.tableBuf.length === 0) return;
    const width = termWidth(80);
    if (this.tableBuf.length >= 2 && isTableSeparator(this.tableBuf[1])) {
      this.commitLines(renderMarkdownTable(this.tableBuf, width, this.depth));
    } else {
      const rendered: string[] = [];
      for (const tl of this.tableBuf) {
        rendered.push(...renderSingleMarkdownLine(tl, width, this.depth, this.indent));
      }
      this.commitLines(rendered);
    }
    this.tableBuf = [];
  }

  private commitCompleteLine(rawLine: string): void {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    const width = termWidth(80);

    if (trimmed.startsWith("```")) {
      this.flushTable();
      if (!this.inCode) {
        this.inCode = true;
        this.codeLang = trimmed.slice(3).trim().split(/\s+/)[0] || "";
        this.commitLines([renderCodeHeader(this.codeLang, width, this.depth, this.indent)]);
      } else {
        this.inCode = false;
        this.commitLines([renderCodeFooter(width, this.depth, this.indent)]);
        this.codeLang = "";
      }
      return;
    }

    if (this.inCode) {
      this.commitLines([renderCodeContentLine(line, this.codeLang, this.depth, this.indent)]);
      return;
    }

    if (trimmed.startsWith("|") && trimmed.includes("|", 1)) {
      this.tableBuf.push(line);
      return;
    }

    this.flushTable();
    this.commitLines(renderSingleMarkdownLine(line, width, this.depth, this.indent));
  }

  private renderLivePartial(): void {
    if (!this.stream.isTTY || !this.lineBuf) return;
    const maxCols = Math.max(20, termWidth(80) - 1);
    const preview = this.inCode
      ? renderCodeContentLine(this.lineBuf, this.codeLang, this.depth, this.indent)
      : `${this.indent}${renderInlineMarkdown(this.lineBuf, this.depth)}`;
    this.stream.write(`\r\x1B[2K${truncateAnsi(preview, maxCols)}`);
    this.hasLivePreview = true;
    this.emittedAny = true;
  }

  public push(chunk: string): void {
    if (!chunk) return;
    this.lineBuf += chunk.replace(/\r\n/g, "\n");
    let nlIdx = this.lineBuf.indexOf("\n");
    while (nlIdx >= 0) {
      const line = this.lineBuf.slice(0, nlIdx);
      this.lineBuf = this.lineBuf.slice(nlIdx + 1);
      this.commitCompleteLine(line);
      nlIdx = this.lineBuf.indexOf("\n");
    }
    if (this.lineBuf) {
      this.renderLivePartial();
    }
  }

  public finish(): void {
    if (this.lineBuf.length > 0) {
      const remaining = this.lineBuf;
      this.lineBuf = "";
      this.commitCompleteLine(remaining);
    } else {
      this.clearLivePreview();
    }
    this.flushTable();
    if (this.inCode) {
      this.inCode = false;
      this.commitLines([renderCodeFooter(termWidth(80), this.depth, this.indent)]);
      this.codeLang = "";
    }
  }
}
