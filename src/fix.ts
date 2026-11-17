import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import pc from "picocolors";
import { createOptionalProvider } from "./providers/index.js";
import { SecurityScanner, type Finding } from "./security/scanner.js";
import { formatColoredDiffPreview } from "./ui/diff.js";

export interface FixOptions {
  path?: string;
  severity?: Finding["severity"] | "ALL";
  rulesPath?: string;
  yes?: boolean;
  dryRun?: boolean;
  suppressOnly?: boolean;
  ai?: boolean;
  provider?: string;
  model?: string;
  cwd?: string;
  askFn?: (question: string) => Promise<string>;
}

export interface FixSummary {
  totalFindings: number;
  fixed: number;
  skipped: number;
  filesModified: string[];
}

export function alignPatchIndentation(patch: string, originalSnippet: string): string {
  if (!patch || !originalSnippet) return patch;
  const indentMatch = originalSnippet.match(/^([ \t]+)/);
  if (!indentMatch) return patch;
  const indent = indentMatch[1];
  const lines = patch.split("\n");
  if (lines.length > 0 && !lines[0].startsWith(" ") && !lines[0].startsWith("\t")) {
    return lines.map((line) => (line.trim().length > 0 ? `${indent}${line}` : line)).join("\n");
  }
  return patch;
}

export function extractCodeFromFence(raw: string): string {
  const match = raw.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  return raw.trim();
}

export function createQuickFixSuppression(finding: Finding, originalLine: string): string {
  const ext = finding.file.split(".").pop()?.toLowerCase() || "";
  const commentChar = ["py", "rb", "sh", "bash", "yaml", "yml", "dockerfile"].includes(ext) ? "#" : "//";
  const indentMatch = originalLine.match(/^([ \t]*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const ruleId = finding.ruleId || finding.id;
  return `${indent}${commentChar} wide-ignore ${ruleId}\n${originalLine}`;
}

async function promptUser(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolvePrompt) => {
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer.trim().toLowerCase());
    });
  });
}

export async function runInteractiveFix(opts: FixOptions = {}): Promise<FixSummary> {
  const cwd = opts.cwd || process.cwd();
  const targetPath = opts.path || ".";
  const scanner = new SecurityScanner(cwd, opts.rulesPath);
  const filter = (opts.severity || "HIGH") as Finding["severity"] | "ALL";

  console.log(pc.cyan(`Scanning for fixable vulnerabilities in ${targetPath} (severity >= ${filter})...`));
  const scanResult = await scanner.scanPath(targetPath, filter, { sca: false });

  const codeFindings = scanResult.findings.filter((f) => f.source !== "sca" && f.line > 0);
  if (codeFindings.length === 0) {
    console.log(pc.green(`No fixable code vulnerabilities found at severity threshold ${filter}.`));
    return { totalFindings: 0, fixed: 0, skipped: 0, filesModified: [] };
  }

  console.log(pc.bold(`Found ${codeFindings.length} vulnerability candidate(s) for interactive remediation.\n`));

  let provider = null;
  if (!opts.suppressOnly && (opts.ai || opts.provider || opts.model)) {
    try {
      provider = createOptionalProvider(opts.provider, opts.model);
    } catch {}
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of codeFindings) {
    const list = byFile.get(f.file) || [];
    list.push(f);
    byFile.set(f.file, list);
  }

  let autoApproveAll = Boolean(opts.yes);
  let totalFixed = 0;
  let totalSkipped = 0;
  const modifiedFilesSet = new Set<string>();

  for (const [relFile, fileFindings] of byFile.entries()) {
    const fullPath = resolve(cwd, relFile);
    if (!existsSync(fullPath)) continue;

    fileFindings.sort((a, b) => b.line - a.line);

    for (const finding of fileFindings) {
      let currentContent = "";
      try {
        currentContent = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const lines = currentContent.split("\n");
      const lineIdx = finding.line - 1;
      if (lineIdx < 0 || lineIdx >= lines.length) {
        totalSkipped++;
        continue;
      }

      const originalLine = lines[lineIdx];
      const endLineIdx = finding.endLine && finding.endLine > finding.line ? finding.endLine - 1 : lineIdx;
      const originalBlock = lines.slice(lineIdx, endLineIdx + 1).join("\n");

      let replacementBlock = "";
      let patchSource = "quick-fix";

      if (provider && !opts.suppressOnly) {
        try {
          const windowStart = Math.max(0, lineIdx - 8);
          const windowEnd = Math.min(lines.length, endLineIdx + 8);
          const snippetWithContext = lines.slice(windowStart, windowEnd).join("\n");
          const prompt = [
            "You are an automated security remediation tool. Provide ONLY the corrected code replacement.",
            `Vulnerability: ${finding.message} (${finding.ruleId || finding.id})`,
            `Remediation suggestion: ${finding.remediation}`,
            "Surrounding Context:",
            snippetWithContext,
            "Target vulnerable block to replace:",
            originalBlock,
            "Reply with ONLY the replacement code enclosed in a ```code fence. Do not explain."
          ].join("\n\n");

          const response = await provider.chatStream(
            [{ role: "user", content: prompt }],
            [],
            () => {}
          );

          const rawText = response.content || "";
          const extracted = extractCodeFromFence(rawText);
          if (extracted && extracted !== originalBlock) {
            replacementBlock = alignPatchIndentation(extracted, originalLine);
            patchSource = "ai-remediation";
          }
        } catch {}
      }

      if (!replacementBlock) {
        replacementBlock = createQuickFixSuppression(finding, originalLine);
        patchSource = "quick-fix suppression";
      }

      const patchedLines = [
        ...lines.slice(0, lineIdx),
        ...replacementBlock.split("\n"),
        ...lines.slice(endLineIdx + 1)
      ];
      const patchedContent = patchedLines.join("\n");

      if (patchedContent === currentContent) {
        totalSkipped++;
        continue;
      }

      const diffPreview = formatColoredDiffPreview(relFile, currentContent, patchedContent);

      console.log(
        pc.bold(
          `\n--------------------------------------------------------------------------------\n` +
          `${pc.cyan("[CANDIDATE]")} ${pc.bold(relFile)}:${finding.line} ` +
          `[${finding.severity}] ${finding.message} (${patchSource})`
        )
      );
      console.log(diffPreview.preview);

      let decision = "y";
      if (!autoApproveAll) {
        if (opts.askFn) {
          decision = await opts.askFn(`Apply this patch? [y/n/a/q]: `);
        } else if (process.stdin.isTTY) {
          const ans = await promptUser(pc.bold(pc.cyan(`Apply this fix to ${relFile}? [y]es / [n]o / [a]ll / [q]uit: `)));
          decision = ans || "y";
        } else {
          console.log(pc.yellow(`Non-interactive environment without --yes. Skipping fix.`));
          decision = "n";
        }
      }

      if (decision === "q" || decision === "quit") {
        console.log(pc.yellow(`Aborted interactive fix session.`));
        return {
          totalFindings: codeFindings.length,
          fixed: totalFixed,
          skipped: totalSkipped,
          filesModified: [...modifiedFilesSet]
        };
      }

      if (decision === "a" || decision === "all") {
        autoApproveAll = true;
        decision = "y";
      }

      if (decision === "y" || decision === "yes") {
        if (opts.dryRun) {
          console.log(pc.yellow(`[DRY-RUN] Would apply patch to ${relFile}:${finding.line}`));
        } else {
          writeFileSync(fullPath, patchedContent, "utf8");
          console.log(pc.green(`[OK] Applied fix to ${relFile}:${finding.line}`));
          modifiedFilesSet.add(relFile);
        }
        totalFixed++;
      } else {
        console.log(pc.dim(`Skipped fix for ${relFile}:${finding.line}`));
        totalSkipped++;
      }
    }
  }

  console.log(
    pc.bold(
      `\nWide Fix Complete: ${totalFixed} patch(es) applied, ${totalSkipped} skipped across ${modifiedFilesSet.size} modified file(s).\n`
    )
  );

  return {
    totalFindings: codeFindings.length,
    fixed: totalFixed,
    skipped: totalSkipped,
    filesModified: [...modifiedFilesSet]
  };
}
