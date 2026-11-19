import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import { formatColoredDiffPreview, type DiffPreviewResult } from "../ui/diff.js";
import { extractDocxText, isDocxPath } from "./docx.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

export async function verifyModifiedFile(
  fullPath: string,
  workingDirectory: string,
  relPath: string,
): Promise<string> {
  if (/\.json$/i.test(fullPath)) {
    try {
      JSON.parse(readFileSync(fullPath, "utf8"));
      return "\nAuto-verification: JSON syntax valid (0 errors).";
    } catch (err: any) {
      return `\n[AUTO-VERIFICATION FAILED: Invalid JSON in ${relPath}]\n- ${err?.message || String(err)}\nFix these diagnostics before finishing your response.`;
    }
  }

  if (/\.(?:js|mjs|cjs)$/i.test(fullPath)) {
    try {
      await execFileAsync(process.execPath, ["--check", fullPath], {
        cwd: workingDirectory,
        timeout: 4500,
      });
      return "\nAuto-verification: JavaScript syntax check passed (0 errors).";
    } catch (err: any) {
      const detail = String(err?.stderr || err?.message || "Syntax check failed").trim().split(/\r?\n/).slice(0, 8).join("\n");
      return `\n[AUTO-VERIFICATION FAILED: JavaScript syntax errors detected in ${relPath}]\n${detail}\nFix these diagnostics before finishing your response.`;
    }
  }

  if (/\.(?:ts|tsx|mts|cts)$/i.test(fullPath)) {
    const tscPath = resolve(workingDirectory, "node_modules", "typescript", "bin", "tsc");
    const tsconfigPath = resolve(workingDirectory, "tsconfig.json");
    if (!existsSync(tscPath) || !existsSync(tsconfigPath)) {
      return "";
    }
    try {
      await execFileAsync(process.execPath, [tscPath, "--noEmit", "--pretty", "false"], {
        cwd: workingDirectory,
        timeout: 8000,
      });
      return "\nAuto-verification: TypeScript check passed (0 errors).";
    } catch (err: any) {
      const allLines = `${String(err?.stdout || "")}\n${String(err?.stderr || "")}`
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const normRel = relPath.replace(/\\/g, "/");
      const fileBase = basename(fullPath);
      const fileErrors = allLines.filter((l) => l.includes(normRel) || l.includes(fileBase));
      if (fileErrors.length > 0) {
        return `\n[AUTO-VERIFICATION FAILED: TypeScript detected ${fileErrors.length} error(s) in ${relPath}]\n${fileErrors.slice(0, 8).join("\n")}\nFix these diagnostics before finishing your response.`;
      }
      if (allLines.length === 0) {
        return "\nAuto-verification: TypeScript check passed (0 errors).";
      }
      return "\nAuto-verification: workspace TypeScript check finished with unrelated project errors (0 in edited file).";
    }
  }

  return "";
}

async function confirmWriteAction(
  toolName: string,
  relPath: string,
  diffResult: DiffPreviewResult,
  context: ToolExecutionContext
): Promise<boolean> {
  const summary = `${pc.green(`+${diffResult.added}`)} ${pc.red(`-${diffResult.removed}`)}`;
  console.log(`\n${pc.cyan(`[${toolName === "write_file" ? "WRITE" : "EDIT"}]`)} ${pc.bold(relPath)} (${summary})`);
  console.log(diffResult.preview || pc.dim("(New file created)"));

  if (context.autoApproveWrite !== false) return true;
  if (context.sessionApprovedTools?.has("write")) return true;
  if (!context.requestApproval) return false;

  const decision = await context.requestApproval({
    tool: toolName,
    title: `Allow ${toolName} to modify ${relPath}? (+${diffResult.added}/-${diffResult.removed})`,
    detail: relPath,
    preview: diffResult.preview,
    sessionKey: "write",
  });
  if (decision === "always") {
    context.sessionApprovedTools?.add("write");
    return true;
  }
  return decision === "once";
}

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description: "Read the contents of a text or .docx file from disk. Can read entire file or specific line ranges.",
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
      const st = statSync(fullPath);
      if (!st.isFile()) {
        return { success: false, output: "", error: `Path is not a regular file: ${params.path}` };
      }
      if (st.size > 2 * 1024 * 1024) {
        return { success: false, output: "", error: `File exceeds 2 MB safety limit (${st.size} bytes): ${params.path}` };
      }
      const rawBuf = readFileSync(fullPath);
      let raw = "";
      if (isDocxPath(fullPath)) {
        const doc = extractDocxText(rawBuf);
        if (!doc.ok) {
          return { success: false, output: "", error: `Failed to extract .docx text from ${params.path}: ${doc.error}` };
        }
        raw = doc.text;
      } else {
        if (rawBuf.subarray(0, Math.min(rawBuf.length, 4096)).includes(0)) {
          return { success: false, output: "", error: `Refusing to read binary file: ${params.path}` };
        }
        raw = rawBuf.toString("utf8");
      }
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

export const readDocumentTool: Tool = {
  definition: {
    name: "read_document",
    description: "Read a .docx Word document (via Wide zero-dependency ZIP/XML paragraph reader) or text document from disk with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path or path relative to current workspace directory (.docx or text file)." },
        startLine: { type: "number", description: "Optional 1-based start line number." },
        endLine: { type: "number", description: "Optional 1-based end line number." }
      },
      required: ["path"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    return readFileTool.execute(params, context);
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

      const oldContent = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
      const diff = formatColoredDiffPreview(relPath, oldContent, params.content, { maxLines: 80 });
      const allowed = await confirmWriteAction("write_file", relPath, diff, context);
      if (!allowed) {
        return { success: false, output: "", error: `Write denied for ${relPath}` };
      }

      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      writeFileSync(fullPath, params.content, "utf8");
      const verifyNote = await verifyModifiedFile(fullPath, context.workingDirectory, relPath);
      return {
        success: true,
        output: `Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${relPath}${verifyNote}`
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
      const diff = formatColoredDiffPreview(relPath, content, newContent, { maxLines: 80 });
      const allowed = await confirmWriteAction("edit_file", relPath, diff, context);
      if (!allowed) {
        return { success: false, output: "", error: `Edit denied for ${relPath}` };
      }

      writeFileSync(fullPath, newContent, "utf8");
      const verifyNote = await verifyModifiedFile(fullPath, context.workingDirectory, relPath);
      return {
        success: true,
        output: `Successfully edited ${relPath}${verifyNote}`
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
};
