import { execFile } from "node:child_process";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
        cur += raw[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const gitTool: Tool = {
  definition: {
    name: "git_inspection",
    description: "Inspect git repository status, diffs, or recent commit history.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Git action to perform.",
          enum: ["status", "diff", "log"]
        },
        args: {
          type: "string",
          description: "Optional extra arguments for the git command."
        }
      },
      required: ["action"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    const action = params.action;
    const extraRaw = typeof params.args === "string" ? params.args.trim() : "";
    const extra = extraRaw ? tokenizeArgs(extraRaw) : [];
    let argv: string[] = ["status", "--short", ...extra];

    if (action === "diff") {
      argv = ["diff", ...extra];
    } else if (action === "log") {
      if (extra.length === 0) {
        argv = ["log", "-n", "5", "--oneline"];
      } else if (extra.length === 1 && /^\d+$/.test(extra[0])) {
        argv = ["log", "-n", extra[0], "--oneline"];
      } else {
        argv = ["log", ...extra];
      }
    }

    return new Promise((resolvePromise) => {
      execFile("git", argv, { cwd: context.workingDirectory, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            success: false,
            output: "",
            error: stderr || error.message
          });
        } else {
          resolvePromise({
            success: true,
            output: stdout || `[Empty ${action} output]`
          });
        }
      });
    });
  }
};
