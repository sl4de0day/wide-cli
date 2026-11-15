import fg from "fast-glob";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

export const listDirTool: Tool = {
  definition: {
    name: "list_dir",
    description: "List files and directories in a given folder with file sizes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path relative to current workspace. Defaults to '.'" },
        maxDepth: { type: "number", description: "Maximum recursion depth (default: 1)." }
      },
      required: []
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const targetPath = resolve(context.workingDirectory, params.path || ".");
      if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
        return { success: false, output: "", error: `Directory not found: ${params.path || "."}` };
      }
      const maxDepth = params.maxDepth || 1;

      const entries: string[] = [];
      const traverse = (dir: string, currentDepth: number) => {
        if (currentDepth > maxDepth) return;
        const items = readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (["node_modules", ".git", "dist", "build", ".next", ".cache"].includes(item.name)) continue;
          const full = join(dir, item.name);
          const rel = relative(targetPath, full);
          if (item.isDirectory()) {
            entries.push(`[DIR]  ${rel}/`);
            traverse(full, currentDepth + 1);
          } else {
            try {
              const size = statSync(full).size;
              entries.push(`[FILE] ${rel} (${size} B)`);
            } catch {
              entries.push(`[FILE] ${rel} (unreadable)`);
            }
          }
        }
      };

      traverse(targetPath, 1);
      return {
        success: true,
        output: entries.slice(0, 200).join("\n") + (entries.length > 200 ? `\n... (${entries.length - 200} more items)` : "")
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
};

export const searchFilesTool: Tool = {
  definition: {
    name: "search_files",
    description: "Search for a regex or string pattern inside files matching an optional glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regex pattern to search for." },
        glob: { type: "string", description: "File glob filter (e.g. '**/*.ts', 'src/**/*.js'). Default: '**/*'" }
      },
      required: ["pattern"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const globPattern = params.glob || "**/*";
      const files = await fg(globPattern, {
        cwd: context.workingDirectory,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
        onlyFiles: true,
        dot: false
      });

      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, "i");
      } catch (reErr: any) {
        return { success: false, output: "", error: `Invalid search pattern: ${reErr?.message || String(reErr)}` };
      }
      const matches: string[] = [];
      let totalMatches = 0;

      for (const file of files) {
        if (totalMatches >= 100) break;
        const full = resolve(context.workingDirectory, file);
        try {
          const st = statSync(full);
          if (st.size > MAX_SEARCH_FILE_BYTES) continue;
          const buf = readFileSync(full);
          if (buf.subarray(0, Math.min(buf.length, 2048)).includes(0)) continue;
          const content = buf.toString("utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length > 2000) continue;
            if (regex.test(line)) {
              matches.push(`${file}:${i + 1}: ${line.trim()}`);
              totalMatches++;
              if (totalMatches >= 100) break;
            }
          }
        } catch {
        }
      }

      if (matches.length === 0) {
        return { success: true, output: `No matches found for "${params.pattern}".` };
      }

      return {
        success: true,
        output: `Found ${matches.length} matches:\n\n${matches.join("\n")}`
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
};
