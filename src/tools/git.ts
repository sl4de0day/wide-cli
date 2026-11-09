import { exec } from "node:child_process";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

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
    let gitCmd = "git status --short";

    if (action === "diff") {
      gitCmd = `git diff ${params.args || ""}`;
    } else if (action === "log") {
      gitCmd = `git log -n ${params.args || "5"} --oneline`;
    }

    return new Promise((resolvePromise) => {
      exec(gitCmd, { cwd: context.workingDirectory }, (error, stdout, stderr) => {
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
