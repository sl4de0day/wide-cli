import pc from "picocolors";

export function formatTerminalMarkdown(text: string): string {
  if (!text) return "";

  const lines = text.split("\n");
  const formatted: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      formatted.push(pc.gray(line));
      continue;
    }

    if (inCodeBlock) {
      formatted.push(pc.green(line));
      continue;
    }

    if (line.startsWith("# ")) {
      formatted.push(pc.bold(pc.cyan(line)));
    } else if (line.startsWith("## ") || line.startsWith("### ")) {
      formatted.push(pc.bold(pc.white(line)));
    } else {
      let l = line.replace(/`([^`]+)`/g, (_, code) => pc.yellow(code));
      l = l.replace(/\*\*([^*]+)\*\*/g, (_, bold) => pc.bold(bold));
      formatted.push(l);
    }
  }

  return formatted.join("\n");
}
