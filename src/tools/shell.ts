import { exec } from "node:child_process";
import pc from "picocolors";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

export const runCommandTool: Tool = {
  definition: {
    name: "run_command",
    description: "Execute a shell command in the project directory and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command line to execute." },
        timeoutMs: { type: "number", description: "Optional timeout in milliseconds (default: 30000)." }
      },
      required: ["command"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    const cmd = params.command;
    const timeout = params.timeoutMs || 30000;

    if (!context.autoApproveRun) {
      console.log(`\n${pc.yellow("[WARN] Agent requests command execution:")} ${pc.bold(cmd)}`);
    }

    return new Promise((resolvePromise) => {
      exec(cmd, {
        cwd: context.workingDirectory,
        timeout,
        maxBuffer: 1024 * 1024 * 2
      }, (error, stdout, stderr) => {
        let out = stdout || "";
        let err = stderr || "";

        if (out.length > 8000) {
          out = out.slice(0, 8000) + "\n... [Output truncated]";
        }
        if (err.length > 4000) {
          err = err.slice(0, 4000) + "\n... [Stderr truncated]";
        }

        const combined = [
          out ? `Stdout:\n${out}` : "",
          err ? `Stderr:\n${err}` : "",
          error ? `Exit Code: ${error.code || 1}` : "Exit Code: 0"
        ].filter(Boolean).join("\n\n");

        resolvePromise({
          success: !error,
          output: combined,
          error: error ? error.message : undefined
        });
      });
    });
  }
};
