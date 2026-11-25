import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createOptionalProvider } from "./providers/index.js";
import { SecurityScanner, type Finding } from "./security/scanner.js";
import { displayWidth, horizontalRule, termWidth } from "./ui/ansi.js";
import { formatColoredDiffPreview } from "./ui/diff.js";
import { Spinner } from "./ui/spinner.js";
import { glyphs, theme } from "./ui/theme.js";
import { InlineDock, type DockHitRegion } from "./ui/tui/dock.js";
import { disableTerminalInputModes, enableTerminalInputModes, RawKeyParser } from "./ui/tui/keys.js";

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

async function promptSingleKeyDecision(relFile: string, allowSuppressSwitch: boolean): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolvePrompt) => {
      rl.question(`  Apply fix to ${relFile}? [y]es / [n]o / [a]ll / [q]uit: `, (answer) => {
        rl.close();
        resolvePrompt(answer.trim().toLowerCase() || "y");
      });
    });
  }

  return new Promise((resolveKey) => {
    const dock = new InlineDock(process.stdout);
    const buttons: Array<{ key: string; text: string }> = [
      { key: "y", text: `${theme.ok("[y]")} apply` },
      { key: "n", text: `${theme.muted("[n]")} skip` },
    ];
    if (allowSuppressSwitch) {
      buttons.push({ key: "s", text: `${theme.info("[s]")} suppress` });
    }
    buttons.push(
      { key: "a", text: `${theme.info("[a]")} all` },
      { key: "q", text: `${theme.warn("[q]")} quit` },
    );

    const prefix = `  ${theme.accentBold(glyphs.pointer)} ${theme.fg(`Apply to ${relFile}?`)}  `;
    const sep = ` ${glyphs.middot} `;
    const sepW = displayWidth(sep);
    const regions: DockHitRegion[] = [];
    let col = displayWidth(prefix);
    for (const b of buttons) {
      const w = displayWidth(b.text);
      regions.push({ id: b.key, row: 0, startCol: col, endCol: col + w });
      col += w + sepW;
    }
    const line = `${prefix}${buttons.map((b) => b.text).join(sep)}`;

    let settled = false;
    const finish = (choice: string) => {
      if (settled) return;
      settled = true;
      process.stdin.off("data", onData);
      parser.dispose();
      dock.clear();
      disableTerminalInputModes();
      resolveKey(choice);
    };

    const parser = new RawKeyParser((ev) => {
      if (settled) return;
      if (ev.name === "cpr" && ev.cpr) {
        dock.handleCpr(ev.cpr.row, ev.cpr.col);
        return;
      }
      if (ev.name === "mouse" && ev.mouse) {
        if (ev.mouse.action === "press" && ev.mouse.button === "right") {
          finish("q");
          return;
        }
        if (ev.mouse.action === "press" && ev.mouse.button === "left") {
          const hit = dock.hitTest(ev.mouse.col, ev.mouse.row);
          if (hit) finish(hit.id);
        }
        return;
      }
      if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) {
        finish("q");
        return;
      }
      if (ev.name === "return") {
        finish("y");
        return;
      }
      if (ev.name === "text" && ev.text) {
        const ch = ev.text.toLowerCase();
        if (ch === "y" || ch === "n" || ch === "a" || ch === "q" || (allowSuppressSwitch && ch === "s")) {
          finish(ch);
        }
      }
    });

    const onData = (chunk: Buffer | string) => parser.feed(chunk);
    enableTerminalInputModes();
    process.stdin.resume();
    process.stdin.on("data", onData);
    dock.setHitRegions(regions);
    dock.render([line], null, { queryPosition: true });
  });
}

export async function runInteractiveFix(opts: FixOptions = {}): Promise<FixSummary> {
  const cwd = opts.cwd || process.cwd();
  const targetPath = opts.path || ".";
  const scanner = new SecurityScanner(cwd, opts.rulesPath);
  const filter = (opts.severity || "HIGH") as Finding["severity"] | "ALL";

  const scanSpinner = new Spinner(`Scanning ${targetPath} for fixable issues (severity >= ${filter})...`, {
    stream: process.stderr,
  });
  scanSpinner.start();
  const scanResult = await scanner.scanPath(targetPath, filter, { sca: false });
  scanSpinner.stop(true);

  const codeFindings = scanResult.findings.filter((f) => f.source !== "sca" && f.line > 0);
  if (codeFindings.length === 0) {
    console.log(`  ${theme.ok(glyphs.dot)} No fixable code vulnerabilities found at severity threshold ${filter}.`);
    return { totalFindings: 0, fixed: 0, skipped: 0, filesModified: [] };
  }

  console.log(`\n  ${theme.fgBold(`Found ${codeFindings.length} remediation candidate(s)`)} ${theme.faint(`(severity >= ${filter})`)}\n`);

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
  let candidateIndex = 0;
  const modifiedFilesSet = new Set<string>();
  const ruleW = Math.min(termWidth(80) - 4, 96);

  for (const [relFile, fileFindings] of byFile.entries()) {
    const fullPath = resolve(cwd, relFile);
    if (!existsSync(fullPath)) continue;

    fileFindings.sort((a, b) => b.line - a.line);

    for (const finding of fileFindings) {
      candidateIndex++;
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
        const aiSpinner = new Spinner(`Synthesizing AI patch for ${relFile}:${finding.line}...`, {
          stream: process.stderr,
        });
        aiSpinner.start();
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
        } catch {
        } finally {
          aiSpinner.stop(true);
        }
      }

      if (!replacementBlock) {
        replacementBlock = createQuickFixSuppression(finding, originalBlock);
        patchSource = "quick-fix suppression";
      }

      const buildPatched = (block: string) =>
        [...lines.slice(0, lineIdx), ...block.split("\n"), ...lines.slice(endLineIdx + 1)].join("\n");

      let patchedContent = buildPatched(replacementBlock);
      if (patchedContent === currentContent) {
        totalSkipped++;
        continue;
      }

      const diffPreview = formatColoredDiffPreview(relFile, currentContent, patchedContent);

      console.log(`  ${horizontalRule(Math.max(36, ruleW), `${candidateIndex}/${codeFindings.length}`)}`);
      console.log(
        `  ${theme.severity(finding.severity)} ${theme.infoBold(`${relFile}:${finding.line}`)} ${theme.fg(finding.message)} ${theme.faint(`(${patchSource})`)}`,
      );
      console.log(diffPreview.preview);
      console.log("");

      let decision = "y";
      if (!autoApproveAll) {
        if (opts.askFn) {
          decision = (await opts.askFn(`Apply this patch? [y/n/a/q]: `)).trim().toLowerCase();
        } else if (process.stdin.isTTY) {
          decision = await promptSingleKeyDecision(relFile, patchSource === "ai-remediation");
        } else {
          console.log(`  ${theme.warn(glyphs.warn)} Non-interactive environment without --yes. Skipping fix.`);
          decision = "n";
        }
      }

      if (decision === "s" && patchSource === "ai-remediation") {
        replacementBlock = createQuickFixSuppression(finding, originalBlock);
        patchedContent = buildPatched(replacementBlock);
        patchSource = "quick-fix suppression";
        decision = "y";
      }

      if (decision === "q" || decision === "quit") {
        console.log(`  ${theme.warn(glyphs.warn)} Aborted interactive fix session.`);
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
          console.log(`  ${theme.warn("[DRY-RUN]")} Would apply patch to ${theme.info(`${relFile}:${finding.line}`)}`);
        } else {
          writeFileSync(fullPath, patchedContent, "utf8");
          console.log(`  ${theme.ok(glyphs.dot)} Applied ${patchSource} to ${theme.info(`${relFile}:${finding.line}`)}`);
          modifiedFilesSet.add(relFile);
        }
        totalFixed++;
      } else {
        console.log(`  ${theme.faint(`Skipped ${relFile}:${finding.line}`)}`);
        totalSkipped++;
      }
    }
  }

  console.log(
    `\n  ${theme.ok(glyphs.dot)} ${theme.fgBold("Wide Fix Complete:")} ${totalFixed} patch(es) applied, ${totalSkipped} skipped across ${modifiedFilesSet.size} modified file(s).\n`,
  );

  return {
    totalFindings: codeFindings.length,
    fixed: totalFixed,
    skipped: totalSkipped,
    filesModified: [...modifiedFilesSet]
  };
}
