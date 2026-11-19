import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, extname, basename, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import fg from "fast-glob";
import pc from "picocolors";
import { type SecurityRule } from "./rules.js";
import { RuleLoader } from "./loader.js";
import { analyzeProjectFlows, buildLogicalSpans } from "./taint.js";
import { isLikelyRealSecret, scanGitHistorySecrets } from "./secrets.js";
import { collectImportedPackagesFromContent, scanWorkspaceDependencies } from "./sca.js";

export interface Finding {
  id: string;
  ruleId?: string;
  cwe: string;
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  file: string;
  line: number;
  endLine?: number;
  snippet: string;
  message: string;
  remediation: string;
  source?: "sast" | "sca" | "taint" | "git-history";
  crossFile?: boolean;
  reachable?: boolean;
  kev?: boolean;
  epss?: number;
}

export interface ScanOptions {
  sca?: boolean;
  advisories?: Record<string, any[]>;
  scanHistory?: boolean;
  maxHistoryCommits?: number;
  sarifPath?: string;
  files?: string[];
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

const AGENT_BEHAVIOR_ONLY_RULE_IDS = new Set([
  "wide/ai-no-emojis",
  "wide/ai-no-system-prompt-leak",
  "wide/ai-direct-file-edits",
  "wide/ai-native-tool-priority",
  "wide/ai-language-matching"
]);

const EXTENSION_MAP: Record<string, string[]> = {
  ".js": ["js"],
  ".jsx": ["jsx", "js"],
  ".mjs": ["mjs", "js"],
  ".cjs": ["cjs", "js"],
  ".ts": ["ts"],
  ".tsx": ["tsx", "ts"],
  ".mts": ["mts", "ts"],
  ".cts": ["cts", "ts"],
  ".vue": ["vue", "html", "js", "ts"],
  ".svelte": ["svelte", "html", "js", "ts"],
  ".html": ["html", "htm", "xhtml"],
  ".htm": ["htm", "html", "xhtml"],
  ".py": ["py"],
  ".php": ["php"],
  ".java": ["java"],
  ".kt": ["kt", "kotlin"],
  ".kts": ["kts", "kt", "kotlin"],
  ".scala": ["scala", "sc"],
  ".cs": ["cs"],
  ".go": ["go"],
  ".rb": ["rb"],
  ".rs": ["rs"],
  ".c": ["c"],
  ".cc": ["cc", "c"],
  ".cpp": ["cpp", "c"],
  ".h": ["h", "c"],
  ".ex": ["ex"],
  ".exs": ["exs", "ex"],
  ".sql": ["sql"],
  ".json": ["json"],
  ".yaml": ["yaml", "yml"],
  ".yml": ["yml", "yaml"],
  ".tf": ["tf", "hcl"],
  ".tfvars": ["tf", "hcl"]
};

const SEVERITY_RANKS: Record<Finding["severity"], number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1
};

export class SecurityScanner {
  private workspaceDir: string;
  private rulesPath?: string;

  constructor(workspaceDir = process.cwd(), rulesPath?: string) {
    this.workspaceDir = workspaceDir;
    this.rulesPath = rulesPath;
  }

  private resolveLangTokens(filePath: string): string[] {
    const ext = extname(filePath).toLowerCase();
    if (ext in EXTENSION_MAP) return EXTENSION_MAP[ext];
    const base = basename(filePath).toLowerCase();
    if (base === "dockerfile" || base.startsWith("dockerfile.")) return ["yaml", "yml"];
    return [];
  }

  private isCommentOnlyLine(lineText: string, langTokens: readonly string[]): boolean {
    const trimmed = lineText.trim();
    if (!trimmed) return true;
    if (langTokens.length === 1 && langTokens[0] === "json") return false;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("* ") || trimmed === "*" || trimmed.startsWith("<!--")) {
      return true;
    }
    const usesHash = langTokens.some((t) => ["py", "rb", "yaml", "yml", "ex", "exs", "tf", "hcl"].includes(t));
    return usesHash && trimmed.startsWith("#");
  }

  private deduplicateFindings(findings: Finding[]): Finding[] {
    const bySlot = new Map<string, Finding>();
    const passthrough: Finding[] = [];
    for (const f of findings) {
      if (!f.cwe || f.cwe === "N/A" || f.source === "sca" || f.source === "git-history") {
        passthrough.push(f);
        continue;
      }
      const key = `${f.file}:${f.line}:${f.cwe}`;
      const prev = bySlot.get(key);
      if (!prev || SEVERITY_RANKS[f.severity] > SEVERITY_RANKS[prev.severity]) {
        bySlot.set(key, f);
      }
    }
    return [...bySlot.values(), ...passthrough].sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id)
    );
  }

  public formatSarif(result: ScanResult): Record<string, any> {
    const rulesMap = new Map<string, any>();
    for (const f of result.findings) {
      const ruleId = f.ruleId || f.id;
      if (!rulesMap.has(ruleId)) {
        rulesMap.set(ruleId, {
          id: ruleId,
          name: f.category,
          shortDescription: { text: f.message },
          properties: { cwe: f.cwe }
        });
      }
    }
    return {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Wide Security Scanner",
              version: "0.6.191126",
              rules: [...rulesMap.values()]
            }
          },
          results: result.findings.map((f) => ({
            ruleId: f.ruleId || f.id,
            level: f.severity === "CRITICAL" || f.severity === "HIGH" ? "error" : f.severity === "MEDIUM" ? "warning" : "note",
            message: { text: f.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: f.file },
                  region: { startLine: Math.max(1, f.line) }
                }
              }
            ]
          }))
        }
      ]
    };
  }

  public async scanPath(
    targetPath = ".",
    minSeverity: Finding["severity"] | "ALL" = "ALL",
    options: ScanOptions = {}
  ): Promise<ScanResult> {
    const fullTarget = resolve(this.workspaceDir, targetPath);
    if (!existsSync(fullTarget)) {
      throw new Error(`Target path does not exist: ${targetPath}`);
    }

    const activeRules = RuleLoader.loadRules(this.rulesPath, this.workspaceDir)
      .filter((r) => !AGENT_BEHAVIOR_ONLY_RULE_IDS.has(r.id));

    const targetStat = statSync(fullTarget);
    const files = targetStat.isFile()
      ? [relative(fullTarget, fullTarget) || basename(fullTarget)]
      : options.files && options.files.length > 0
        ? options.files
        : await fg(
          [
            "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue,svelte,html,htm,py,php,java,kt,kts,scala,cs,go,rb,rs,c,cc,cpp,h,ex,exs,sql,json,yaml,yml,tf,tfvars}",
            "**/Dockerfile",
            "**/Dockerfile.*",
            "**/.github/workflows/*.{yml,yaml}"
          ],
          {
            cwd: fullTarget,
            dot: true,
            ignore: [
              "**/node_modules/**",
              "**/.git/**",
              "**/dist/**",
              "**/build/**",
              "**/vendor/**",
              "**/.next/**",
              "**/target/**",
              "**/coverage/**",
              "**/.venv/**",
              "**/venv/**",
              "**/__pycache__/**"
            ],
            onlyFiles: true
          }
        );

    const findings: Finding[] = [];
    const minRank = minSeverity === "ALL" ? 1 : SEVERITY_RANKS[minSeverity] || 1;
    const filteredBySeverity = activeRules.filter((r) => SEVERITY_RANKS[r.severity] >= minRank);
    const rulesByLangKey = new Map<string, SecurityRule[]>();
    const collectedSources: Array<{ file: string; lang: string; content: string }> = [];
    const importedPackages = new Set<string>();
    let scannedCount = 0;

    for (const file of files) {
      const fullFilePath = targetStat.isFile() ? fullTarget : resolve(fullTarget, file);
      const langTokens = this.resolveLangTokens(fullFilePath);
      if (langTokens.length === 0) continue;

      let content = "";
      try {
        const st = statSync(fullFilePath);
        if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
        const buf = readFileSync(fullFilePath);
        if (buf.subarray(0, Math.min(buf.length, 2048)).includes(0)) continue;
        content = buf.toString("utf8");
      } catch {
        continue;
      }

      scannedCount++;
      const relFile = relative(this.workspaceDir, fullFilePath).replace(/\\/g, "/");
      if (!["json", "yaml", "yml", "tf", "hcl", "sql"].includes(langTokens[0])) {
        collectedSources.push({ file: relFile, lang: langTokens[0], content });
      }
      collectImportedPackagesFromContent(content, importedPackages);

      const langKey = langTokens.join(",");
      let applicableRules = rulesByLangKey.get(langKey);
      if (!applicableRules) {
        const isDataOnly = langTokens.every((t) => ["json", "yaml", "yml", "tf", "hcl"].includes(t));
        applicableRules = filteredBySeverity.filter((r) => {
          if (r.languages.includes("all")) return !isDataOnly;
          return langTokens.some((t) => r.languages.includes(t));
        });
        rulesByLangKey.set(langKey, applicableRules);
      }

      const lines = content.split("\n");
      const fileHead = lines.slice(0, Math.min(lines.length, 15)).join("\n");
      const spans = buildLogicalSpans(lines);
      const seenLineRule = new Set<string>();

      const evaluateCandidate = (text: string, lineIdx: number, endLineNum: number) => {
        const lineNum = lineIdx + 1;
        const windowSlice = lines.slice(Math.max(0, lineIdx - 5), Math.min(lines.length, lineIdx + 6)).join("\n");
        for (const rule of applicableRules!) {
          if (!rule.pattern.test(text)) continue;
          if (rule.notMatch) {
            if (rule.notMatch.test(text)) continue;
            if ((rule.id.startsWith("wide/xxe-") || rule.id.startsWith("wide/client-crypto-")) && (rule.notMatch.test(windowSlice) || rule.notMatch.test(fileHead))) {
              continue;
            }
          }
          if (rule.category === "SECRETS" && !isLikelyRealSecret(text, relFile)) continue;
          if (rule.sourcePattern) {
            const windowStart = Math.max(0, lineIdx - 15);
            const windowText = lines.slice(windowStart, lineIdx + 1).join("\n");
            if (!rule.sourcePattern.test(windowText)) continue;
          }
          const key = `${lineNum}:${rule.id}`;
          if (seenLineRule.has(key)) continue;
          seenLineRule.add(key);

          findings.push({
            id: rule.id,
            ruleId: rule.id,
            cwe: rule.cwe,
            category: rule.category,
            severity: rule.severity,
            file: relFile,
            line: lineNum,
            ...(endLineNum > lineNum ? { endLine: endLineNum } : {}),
            snippet: lines[lineIdx].trim(),
            message: rule.message,
            remediation: rule.remediation,
            source: "sast"
          });
        }
      };

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        if (lineText.length > 1500) continue;
        if (/\bwide-ignore\b/i.test(lineText)) continue;
        if (i > 0 && /\bwide-ignore(-next-line)?\b/i.test(lines[i - 1])) continue;
        if (this.isCommentOnlyLine(lineText, langTokens)) continue;
        evaluateCandidate(lineText, i, i + 1);
      }

      for (const span of spans) {
        if (span.endLine <= span.startLine) continue;
        const startIdx = span.startLine - 1;
        if (/\bwide-ignore\b/i.test(lines[startIdx] || "")) continue;
        if (startIdx > 0 && /\bwide-ignore(-next-line)?\b/i.test(lines[startIdx - 1] || "")) continue;
        evaluateCandidate(span.text, startIdx, span.endLine);
      }
    }

    if (collectedSources.length > 0) {
      for (const flow of analyzeProjectFlows(collectedSources)) {
        if (SEVERITY_RANKS[flow.severity] >= minRank) {
          findings.push(flow);
        }
      }
    }

    let finalFindings = this.deduplicateFindings(findings);

    if (options.sca !== false && !targetStat.isFile()) {
      const advisories = options.advisories || RuleLoader.loadAdvisories(this.workspaceDir);
      const scaFindings = scanWorkspaceDependencies({
        workspaceDir: fullTarget,
        advisories,
        minRank,
        severityRanks: SEVERITY_RANKS,
        importedPackages: importedPackages.size > 0 ? importedPackages : undefined
      });
      finalFindings.push(...scaFindings);
    }

    if (options.scanHistory && !targetStat.isFile()) {
      const histFindings = await scanGitHistorySecrets(fullTarget, options.maxHistoryCommits || 30);
      for (const hf of histFindings) {
        if (SEVERITY_RANKS[hf.severity] >= minRank) finalFindings.push(hf);
      }
    }

    const summary = {
      critical: finalFindings.filter((f) => f.severity === "CRITICAL").length,
      high: finalFindings.filter((f) => f.severity === "HIGH").length,
      medium: finalFindings.filter((f) => f.severity === "MEDIUM").length,
      low: finalFindings.filter((f) => f.severity === "LOW").length
    };

    const result: ScanResult = {
      totalFilesScanned: scannedCount,
      findings: finalFindings,
      summary
    };

    if (options.sarifPath) {
      const outPath = resolve(this.workspaceDir, options.sarifPath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(this.formatSarif(result), null, 2), "utf8");
    }

    return result;
  }

  public async scanFiles(
    files: string[],
    minSeverity: Finding["severity"] | "ALL" = "ALL",
    options: ScanOptions = {}
  ): Promise<ScanResult> {
    return this.scanPath(".", minSeverity, { ...options, files });
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
