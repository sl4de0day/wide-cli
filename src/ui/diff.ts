import { createPatch } from "diff";
import pc from "picocolors";

export function formatUnifiedDiff(filePath: string, oldStr: string, newStr: string): string {
  const patch = createPatch(filePath, oldStr, newStr, "original", "modified", { context: 3 });
  const lines = patch.split("\n");
  const coloredLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      coloredLines.push(pc.bold(pc.gray(line)));
    } else if (line.startsWith("@@")) {
      coloredLines.push(pc.cyan(line));
    } else if (line.startsWith("+")) {
      coloredLines.push(pc.green(line));
    } else if (line.startsWith("-")) {
      coloredLines.push(pc.red(line));
    } else {
      coloredLines.push(pc.gray(line));
    }
  }

  return coloredLines.join("\n");
}
