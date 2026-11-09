import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import fg from "fast-glob";
import pc from "picocolors";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

interface Finding {
  file: string;
  line: number;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  category: string;
  message: string;
  snippet: string;
}

const SEC_RULES: {
  category: string;
  severity: Finding["severity"];
  pattern: RegExp;
  message: string;
}[] = [
  {
    category: "SQL Injection",
    severity: "CRITICAL",
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE).*?\+\s*(?:req\.|params\.|body\.|query\.|input|\$)/i,
    message: "Possible SQL string concatenation with untrusted input."
  },
  {
    category: "Command Injection",
    severity: "CRITICAL",
    pattern: /(?:exec|spawn|popen|system)\s*\(\s*(?:`[^`]*\$\{|['"].*?\+\s*)/i,
    message: "Dynamic command execution with unescaped user string."
  },
  {
    category: "Cross-Site Scripting (XSS)",
    severity: "HIGH",
    pattern: /(?:innerHTML|outerHTML|document\.write)\s*=\s*(?:.*?\b(?:query|param|body|req|location|search)\b)/i,
    message: "Unsanitized user input assigned directly to DOM HTML sink."
  },
  {
    category: "SSRF (Server-Side Request Forgery)",
    severity: "HIGH",
    pattern: /(?:fetch|axios\.(?:get|post)|http\.get|request)\s*\(\s*(?:req\.|params\.|query\.|body\.)/i,
    message: "HTTP request targeting an unvalidated user-controlled URL."
  },
  {
    category: "Hardcoded Secret",
    severity: "HIGH",
    pattern: /(?:api_?key|secret|password|token|private_?key)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i,
    message: "Possible hardcoded authentication secret or API key."
  },
  {
    category: "Path Traversal",
    severity: "HIGH",
    pattern: /(?:readFile|createReadStream|open)\s*\(\s*(?:.*?path\.join.*?req\.|.*?\+\s*req\.)/i,
    message: "File path constructed from untrusted parameter without boundary checks."
  },
  {
    category: "Code Injection (eval)",
    severity: "CRITICAL",
    pattern: /\beval\s*\(\s*(?:req\.|params\.|query\.|input|body)/i,
    message: "Dynamic code execution via eval with user input."
  }
];

export const securityScanTool: Tool = {
  definition: {
    name: "run_security_scan",
    description: "Scan workspace code for security vulnerabilities, secrets, and injection flaws using Wide's native SAST engine.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target subdirectory or file to scan (default: entire workspace '.')." },
        severityFilter: {
          type: "string",
          description: "Minimum severity to report: 'ALL', 'MEDIUM', 'HIGH', or 'CRITICAL'.",
          enum: ["ALL", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
        }
      },
      required: []
    }
  },
  async execute(params, context): Promise<ToolResult> {
    try {
      const scanDir = resolve(context.workingDirectory, params.path || ".");
      console.log(`\n${pc.cyan("[SCAN] Wide SAST Engine:")} ${pc.bold(relative(context.workingDirectory, scanDir) || ".")}`);

      const files = await fg(["**/*.{js,ts,jsx,tsx,py,php,go,rb,java,cs}"], {
        cwd: scanDir,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/vendor/**"],
        onlyFiles: true
      });

      const findings: Finding[] = [];

      for (const file of files) {
        const full = resolve(scanDir, file);
        try {
          const content = readFileSync(full, "utf8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const rule of SEC_RULES) {
              if (rule.pattern.test(line)) {
                findings.push({
                  file: relative(context.workingDirectory, full),
                  line: i + 1,
                  severity: rule.severity,
                  category: rule.category,
                  message: rule.message,
                  snippet: line.trim()
                });
              }
            }
          }
        } catch {
        }
      }

      if (findings.length === 0) {
        return {
          success: true,
          output: `Wide Security Scan complete: 0 vulnerabilities found in ${files.length} files scanned.`
        };
      }

      const formatted = findings.map(f => {
        const sevColor = f.severity === "CRITICAL" ? pc.red(pc.bold(f.severity)) :
                         f.severity === "HIGH" ? pc.red(f.severity) :
                         pc.yellow(f.severity);
        return `[${sevColor}] ${f.category} in ${pc.bold(`${f.file}:${f.line}`)}\n  Issue: ${f.message}\n  Code: ${pc.dim(f.snippet)}`;
      }).join("\n\n");

      return {
        success: true,
        output: `Wide Security Scan found ${findings.length} issue(s) across ${files.length} scanned files:\n\n${formatted}`
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
};
