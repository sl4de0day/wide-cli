import { createPatch } from "diff";
import pc from "picocolors";

export interface DiffPreviewResult {
  preview: string;
  added: number;
  removed: number;
  hunks: number;
  truncated: number;
}

export function formatColoredDiffPreview(
  filePath: string,
  oldStr: string,
  newStr: string,
  opts?: { maxLines?: number; context?: number; forceColor?: boolean }
): DiffPreviewResult {
  const maxLines = Math.max(10, opts?.maxLines ?? 80);
  const patch = createPatch(filePath, oldStr, newStr, "original", "modified", { context: opts?.context ?? 3 });
  const rawLines = patch.split("\n");
  const filteredLines = rawLines.filter((line) => !line.startsWith("Index: ") && !line.startsWith("===="));

  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of filteredLines) {
    if (line.startsWith("@@")) hunks += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }

  const truncated = Math.max(0, filteredLines.length - maxLines);
  const visibleLines = truncated > 0 ? filteredLines.slice(0, maxLines) : filteredLines;
  const ansi = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;

  const coloredLines: string[] = [];
  for (const line of visibleLines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      coloredLines.push(opts?.forceColor ? ansi("1;90", line) : pc.bold(pc.gray(line)));
    } else if (line.startsWith("@@")) {
      coloredLines.push(opts?.forceColor ? ansi("36", line) : pc.cyan(line));
    } else if (line.startsWith("+")) {
      coloredLines.push(opts?.forceColor ? ansi("32", line) : pc.green(line));
    } else if (line.startsWith("-")) {
      coloredLines.push(opts?.forceColor ? ansi("31", line) : pc.red(line));
    } else {
      coloredLines.push(opts?.forceColor ? ansi("90", line) : pc.gray(line));
    }
  }

  if (truncated > 0) {
    const tail = `... (${truncated} additional diff line(s) omitted)`;
    coloredLines.push(opts?.forceColor ? ansi("33", tail) : pc.yellow(tail));
  }

  return {
    preview: coloredLines.join("\n"),
    added,
    removed,
    hunks,
    truncated,
  };
}

export function formatUnifiedDiff(filePath: string, oldStr: string, newStr: string, maxLines = 120): string {
  return formatColoredDiffPreview(filePath, oldStr, newStr, { maxLines }).preview;
}
