import { createPatch, diffWordsWithSpace } from "diff";
import { padStartAnsi } from "./ansi.js";
import { detectColorDepth, glyphs, theme, type ColorDepth } from "./theme.js";

export interface DiffPreviewResult {
  preview: string;
  added: number;
  removed: number;
  hunks: number;
  truncated: number;
}

interface ParsedDiffRow {
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  raw: string;
  oldLine?: number;
  newLine?: number;
  text: string;
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

function renderInlinePair(delText: string, addText: string, depth: ColorDepth): { delOut: string; addOut: string } {
  if (depth === "none" || delText.length + addText.length > 400) {
    return {
      delOut: theme.diff.delLine(`-${delText}`, depth),
      addOut: theme.diff.addLine(`+${addText}`, depth),
    };
  }
  const parts = diffWordsWithSpace(delText, addText);
  let delBuf = theme.diff.delLine("-", depth);
  let addBuf = theme.diff.addLine("+", depth);
  for (const part of parts) {
    if (part.removed) {
      delBuf += theme.diff.delWord(part.value, depth);
    } else if (part.added) {
      addBuf += theme.diff.addWord(part.value, depth);
    } else {
      delBuf += theme.diff.delLine(part.value, depth);
      addBuf += theme.diff.addLine(part.value, depth);
    }
  }
  return { delOut: delBuf, addOut: addBuf };
}

export function formatColoredDiffPreview(
  filePath: string,
  oldStr: string,
  newStr: string,
  opts?: { maxLines?: number; context?: number; forceColor?: boolean; colorDepth?: ColorDepth; showLineNumbers?: boolean }
): DiffPreviewResult {
  const maxLines = Math.max(10, opts?.maxLines ?? 80);
  const showNumbers = opts?.showLineNumbers !== false;
  const depth: ColorDepth = opts?.colorDepth
    ? opts.colorDepth
    : opts?.forceColor
      ? "truecolor"
      : detectColorDepth();

  const patch = createPatch(filePath, oldStr, newStr, "original", "modified", { context: opts?.context ?? 3 });
  const rawLines = patch.split("\n");
  const filteredLines = rawLines.filter((line) => !line.startsWith("Index: ") && !line.startsWith("===="));

  let added = 0;
  let removed = 0;
  let hunks = 0;
  let oldNum = 0;
  let newNum = 0;
  let maxLineNum = 1;
  const rows: ParsedDiffRow[] = [];

  for (const line of filteredLines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      rows.push({ kind: "meta", raw: line, text: line });
    } else if (line.startsWith("@@")) {
      hunks += 1;
      const parsed = parseHunkHeader(line);
      if (parsed) {
        oldNum = parsed.oldStart;
        newNum = parsed.newStart;
      }
      rows.push({ kind: "hunk", raw: line, text: line });
    } else if (line.startsWith("+")) {
      added += 1;
      rows.push({ kind: "add", raw: line, newLine: newNum, text: line.slice(1) });
      maxLineNum = Math.max(maxLineNum, newNum);
      newNum += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
      rows.push({ kind: "del", raw: line, oldLine: oldNum, text: line.slice(1) });
      maxLineNum = Math.max(maxLineNum, oldNum);
      oldNum += 1;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", raw: line, oldLine: oldNum, newLine: newNum, text: line.slice(1) });
      maxLineNum = Math.max(maxLineNum, oldNum, newNum);
      oldNum += 1;
      newNum += 1;
    } else if (line) {
      rows.push({ kind: "ctx", raw: line, text: line });
    }
  }

  const truncated = Math.max(0, rows.length - maxLines);
  const visible = truncated > 0 ? rows.slice(0, maxLines) : rows;
  const numW = Math.max(2, String(maxLineNum).length);

  const fmtGutter = (oldN?: number, newN?: number): string => {
    if (!showNumbers) return "  ";
    const o = padStartAnsi(oldN !== undefined ? String(oldN) : "", numW);
    const n = padStartAnsi(newN !== undefined ? String(newN) : "", numW);
    return `  ${theme.diff.gutter(`${o} ${n} ${glyphs.pipe}`, depth)} `;
  };

  const out: string[] = [];
  let i = 0;
  while (i < visible.length) {
    const row = visible[i];
    if (row.kind === "meta") {
      out.push(`  ${theme.muted(row.text, depth)}`);
      i += 1;
      continue;
    }
    if (row.kind === "hunk") {
      out.push(`  ${theme.diff.hunk(row.text, depth)}`);
      i += 1;
      continue;
    }
    if (row.kind === "del" && i + 1 < visible.length && visible[i + 1].kind === "add") {
      const delGroup: ParsedDiffRow[] = [];
      let j = i;
      while (j < visible.length && visible[j].kind === "del") {
        delGroup.push(visible[j]);
        j += 1;
      }
      const addGroup: ParsedDiffRow[] = [];
      let k = j;
      while (k < visible.length && visible[k].kind === "add") {
        addGroup.push(visible[k]);
        k += 1;
      }
      if (delGroup.length === addGroup.length && delGroup.length <= 6) {
        const renderedAdds: string[] = [];
        for (let idx = 0; idx < delGroup.length; idx++) {
          const pair = renderInlinePair(delGroup[idx].text, addGroup[idx].text, depth);
          out.push(`${fmtGutter(delGroup[idx].oldLine, undefined)}${pair.delOut}`);
          renderedAdds.push(`${fmtGutter(undefined, addGroup[idx].newLine)}${pair.addOut}`);
        }
        out.push(...renderedAdds);
        i = k;
        continue;
      }
    }
    if (row.kind === "add") {
      out.push(`${fmtGutter(undefined, row.newLine)}${theme.diff.addLine(`+${row.text}`, depth)}`);
    } else if (row.kind === "del") {
      out.push(`${fmtGutter(row.oldLine, undefined)}${theme.diff.delLine(`-${row.text}`, depth)}`);
    } else {
      out.push(`${fmtGutter(row.oldLine, row.newLine)}${theme.diff.context(` ${row.text}`, depth)}`);
    }
    i += 1;
  }

  if (truncated > 0) {
    out.push(`  ${theme.warn(`${glyphs.ellipsis} (${truncated} additional diff line(s) omitted)`, depth)}`);
  }

  return {
    preview: out.join("\n"),
    added,
    removed,
    hunks,
    truncated,
  };
}

export function formatUnifiedDiff(filePath: string, oldStr: string, newStr: string, maxLines = 120): string {
  return formatColoredDiffPreview(filePath, oldStr, newStr, { maxLines }).preview;
}
