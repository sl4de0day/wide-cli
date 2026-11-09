import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import pc from "picocolors";
import { formatUnifiedDiff } from "../ui/diff.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description: "Read the contents of a text file from disk. Can read entire file or specific line ranges.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path or path relative to current workspace directory." },
        startLine: { type: "number", description: "Optional 1-based start line number." },
        endLine: { type: "number", description: "Optional 1-based end line number." }
      },
      required: ["path"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const fullPath = resolve(context.workingDirectory, params.path);
      if (!existsSync(fullPath)) {
        return { success: false, output: "", error: `File not found: ${params.path}` };
      }
      const raw = readFileSync(fullPath, "utf8");
      const lines = raw.split("\n");

      let start = 1;
      let end = lines.length;

      if (params.startLine && typeof params.startLine === "number") {
        start = Math.max(1, params.startLine);
      }
      if (params.endLine && typeof params.endLine === "number") {
        end = Math.min(lines.length, params.endLine);
      }

      const selected = lines.slice(start - 1, end);
      const formatted = selected.map((line, idx) => `${start + idx}: ${line}`).join("\n");
      return {
        success: true,
        output: `File: ${relative(context.workingDirectory, fullPath)} (Lines ${start}-${end} of ${lines.length})\n\n${formatted}`
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
};

export const writeFileTool: Tool = {
  definition: {
    name: "write_file",
    description: "Write content to a file, completely creating or overwriting it. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write the file to." },
        content: { type: "string", description: "The full content to write to the file." }
      },
      required: ["path", "content"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const fullPath = resolve(context.workingDirectory, params.path);
      const relPath = relative(context.workingDirectory, fullPath);
      const parentDir = dirname(fullPath);

      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      const oldContent = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
      
      if (!context.autoApproveWrite) {
        console.log(`\n${pc.cyan("[WRITE]")} ${pc.bold(relPath)}`);
        const diff = formatUnifiedDiff(relPath, oldContent, params.content);
        console.log(diff || pc.dim("(New file created)"));
      }

      writeFileSync(fullPath, params.content, "utf8");
      return {
        success: true,
        output: `Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${relPath}`
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
};

export const editFileTool: Tool = {
  definition: {
    name: "edit_file",
    description: "Replace exact target string with replacement content in an existing file. Target must match existing text uniquely.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit." },
        target: { type: "string", description: "The exact text to replace." },
        replacement: { type: "string", description: "The replacement text." }
      },
      required: ["path", "target", "replacement"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const fullPath = resolve(context.workingDirectory, params.path);
      const relPath = relative(context.workingDirectory, fullPath);

      if (!existsSync(fullPath)) {
        return { success: false, output: "", error: `File not found: ${relPath}` };
      }

      const content = readFileSync(fullPath, "utf8");
      if (!content.includes(params.target)) {
        return {
          success: false,
          output: "",
          error: `Target string was not found in ${relPath}. Ensure exact whitespace and line match.`
        };
      }

      const newContent = content.replace(params.target, params.replacement);

      if (!context.autoApproveWrite) {
        console.log(`\n${pc.cyan("[EDIT]")} ${pc.bold(relPath)}`);
        const diff = formatUnifiedDiff(relPath, content, newContent);
        console.log(diff);
      }

      writeFileSync(fullPath, newContent, "utf8");
      return {
        success: true,
        output: `Successfully edited ${relPath}`
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
};
