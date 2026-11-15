import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import fg from "fast-glob";
import pc from "picocolors";
import { SECURITY_RULES, type SecurityRule } from "./rules.js";
import { RuleLoader } from "./loader.js";

export interface Finding {
  id: string;
  cwe: string;
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  file: string;
  line: number;
  snippet: string;
  message: string;
  remediation: string;
}

export interface ScanResult {
  totalFilesScanned: number;
  findings: Finding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

const EXTENSION_MAP: Record<string, string> = {
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".ts": "ts",
  ".tsx": "ts",
  ".py": "py",
  ".php": "php",
  ".java": "java",
  ".cs": "cs",
  ".go": "go",
  ".rb": "rb",
  ".rs": "rs",
  ".c": "c",
  ".cpp": "c",
  ".h": "c"
};

export class SecurityScanner {
  private workspaceDir: string;
  private rulesPath?: string;

  constructor(workspaceDir = process.cwd(), rulesPath?: string) {
    this.workspaceDir = workspaceDir;
    this.rulesPath = rulesPath;
  }

  public async scanPath(targetPath = ".", minSeverity: Finding["severity"] | "ALL" = "ALL"): Promise<ScanResult> {
    const fullTarget = resolve(this.workspaceDir, targetPath);
    if (!existsSync(fullTarget)) {
      throw new Error(`Target path does not exist: ${targetPath}`);
    }

    const activeRules = RuleLoader.loadRules(this.rulesPath, this.workspaceDir);

    const files = await fg(["**/*.{js,jsx,mjs,cjs,ts,tsx,py,php,java,cs,go,rb,rs,c,cpp,h}"], {
      cwd: fullTarget,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/vendor/**",
        "**/.next/**",
        "**/target/**",
        "**/coverage/**"
      ],
      onlyFiles: true
    });

    const findings: Finding[] = [];
    const severityRanks: Record<Finding["severity"], number> = {
      CRITICAL: 4,
      HIGH: 3,
      MEDIUM: 2,
      LOW: 1
    };

    const minRank = minSeverity === "ALL" ? 1 : severityRanks[minSeverity] || 1;
    const filteredBySeverity = activeRules.filter(r => severityRanks[r.severity] >= minRank);
    const rulesByLang = new Map<string, SecurityRule[]>();

    for (const file of files) {
      const fullFilePath = resolve(fullTarget, file);
      const ext = extname(file).toLowerCase();
      const lang = EXTENSION_MAP[ext] || "all";

      let content = "";
      try {
        const st = statSync(fullFilePath);
        if (st.size > 2 * 1024 * 1024) continue;
        const buf = readFileSync(fullFilePath);
        if (buf.subarray(0, Math.min(buf.length, 2048)).includes(0)) continue;
        content = buf.toString("utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      let applicableRules = rulesByLang.get(lang);
      if (!applicableRules) {
        applicableRules = filteredBySeverity.filter(r =>
          r.languages.includes("all") || r.languages.includes(lang)
        );
        rulesByLang.set(lang, applicableRules);
      }

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        if (lineText.length > 1000) continue;

        for (const rule of applicableRules) {

          if (rule.pattern.test(lineText)) {
            if (rule.notMatch && rule.notMatch.test(lineText)) continue;
            let confirmed = true;
            if (rule.sourcePattern) {
              const windowStart = Math.max(0, i - 15);
              const windowText = lines.slice(windowStart, i + 1).join("\n");
              confirmed = rule.sourcePattern.test(windowText);
            }

            if (confirmed) {
              findings.push({
                id: rule.id,
                cwe: rule.cwe,
                category: rule.category,
                severity: rule.severity,
                file: relative(this.workspaceDir, fullFilePath),
                line: i + 1,
                snippet: lineText.trim(),
                message: rule.message,
                remediation: rule.remediation
              });
            }
          }
        }
      }
    }

    const summary = {
      critical: findings.filter(f => f.severity === "CRITICAL").length,
      high: findings.filter(f => f.severity === "HIGH").length,
      medium: findings.filter(f => f.severity === "MEDIUM").length,
      low: findings.filter(f => f.severity === "LOW").length
    };

    return {
      totalFilesScanned: files.length,
      findings,
      summary
    };
  }

  public formatCliReport(result: ScanResult): string {
    if (result.findings.length === 0) {
      return `Wide Security Scan complete: 0 vulnerabilities found in ${result.totalFilesScanned} files scanned.`;
    }

    const lines: string[] = [
      `Wide Security Scan: Found ${result.findings.length} issue(s) across ${result.totalFilesScanned} scanned files.`,
      `Summary: [CRITICAL: ${result.summary.critical}] [HIGH: ${result.summary.high}] [MEDIUM: ${result.summary.medium}] [LOW: ${result.summary.low}]\n`
    ];

    for (const f of result.findings) {
      const sevColor = f.severity === "CRITICAL" ? pc.red(pc.bold(`[${f.severity}]`)) :
                       f.severity === "HIGH" ? pc.red(`[${f.severity}]`) :
                       f.severity === "MEDIUM" ? pc.yellow(`[${f.severity}]`) :
                       pc.gray(`[${f.severity}]`);

      lines.push(`${sevColor} ${pc.bold(f.category)} (${f.cwe}) in ${pc.cyan(`${f.file}:${f.line}`)}`);
      lines.push(`  Message:     ${f.message}`);
      lines.push(`  Code:        ${pc.dim(f.snippet)}`);
      lines.push(`  Remediation: ${pc.green(f.remediation)}\n`);
    }

    return lines.join("\n");
  }
}
