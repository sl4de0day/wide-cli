import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PermissionStore, matchesPermissionRule } from "../dist/config/permissions.js";
import { AntigravityStreamAccumulator } from "../dist/providers/antigravity.js";
import { ClaudeStreamAccumulator } from "../dist/providers/claude-code.js";
import { TurnCheckpointStore } from "../dist/repl/checkpoints.js";
import { SLASH_COMMANDS } from "../dist/repl/commands.js";
import { initWideWorkspace } from "../dist/repl/init.js";
import { formatToolSummary, summarizeToolResult } from "../dist/ui/activity.js";
import { displayWidth, hyperlink, sliceAnsi, stripAnsi, truncateAnsi, wrapAnsi } from "../dist/ui/ansi.js";
import { formatColoredDiffPreview } from "../dist/ui/diff.js";
import { classifyError, formatErrorCard } from "../dist/ui/errors.js";
import { formatTerminalMarkdown, StreamingMarkdownRenderer } from "../dist/ui/markdown.js";
import { theme } from "../dist/ui/theme.js";
import { InlineDock } from "../dist/ui/tui/dock.js";
import { RawKeyParser } from "../dist/ui/tui/keys.js";
import { renderStatusFooter, renderStatusFooterWithRegions } from "../dist/ui/tui/statusbar.js";
import { filterFileSuggestions, filterSlashSuggestions } from "../dist/ui/tui/typeahead.js";

async function runUiTuiTests() {
  console.log("Testing Wide CLI Nord Theme, ANSI, Markdown, TUI, Permissions, Checkpoints & Subcommands...");

  const accentTrue = theme.accent("wide", "truecolor");
  assert.ok(accentTrue.includes("\x1b[38;2;94;129;172m"));
  assert.strictEqual(stripAnsi(accentTrue), "wide");
  assert.strictEqual(theme.accent("wide", "none"), "wide");
  assert.ok(theme.accent("wide", "ansi256").includes("\x1b[38;5;67m"));
  assert.strictEqual(stripAnsi(theme.severity("CRITICAL", "none")), "[CRIT]");
  assert.strictEqual(stripAnsi(theme.severity("HIGH", "truecolor")).trim(), "HIGH");
  console.log("[PASS] Wide Nord theme truecolor, ansi256, and NO_COLOR degradation");

  const linked = hyperlink("Docs", "https://example.com", true);
  assert.strictEqual(stripAnsi(linked), "Docs");
  assert.strictEqual(displayWidth(linked), 4);
  assert.strictEqual(displayWidth("日本語"), 6);
  assert.strictEqual(displayWidth(theme.info("hello world", "truecolor")), 11);

  const styledLong = `${theme.info("alpha", "truecolor")} ${theme.ok("beta gamma delta", "truecolor")}`;
  const sliced = sliceAnsi(styledLong, 0, 10);
  assert.strictEqual(stripAnsi(sliced), "alpha beta");
  assert.ok(sliced.endsWith("\x1b[0m"));
  const truncated = truncateAnsi(styledLong, 9, "...");
  assert.strictEqual(stripAnsi(truncated), "alpha ...");
  const wrapped = wrapAnsi(styledLong, 10);
  assert.ok(wrapped.length >= 2);
  for (const row of wrapped) {
    assert.ok(displayWidth(row) <= 10);
  }
  console.log("[PASS] ANSI displayWidth, sliceAnsi, truncateAnsi, wrapAnsi, and OSC 8 stripping");

  const mdSample = [
    "# Wide Report",
    "",
    "Here is **bold** text with `inline_code` and a [link](https://example.com).",
    "",
    "- [x] First task",
    "- Regular item",
    "",
    "| Tool | Status |",
    "| --- | --- |",
    "| SAST | Ready |",
    "",
    "```ts",
    "const answer: number = 42;",
    "```",
  ].join("\n");

  const renderedPlain = formatTerminalMarkdown(mdSample, { colorDepth: "none", width: 80 });
  assert.ok(renderedPlain.includes("Wide Report"));
  assert.ok(renderedPlain.includes("inline_code"));
  assert.ok(renderedPlain.includes("SAST"));
  assert.ok(renderedPlain.includes("const answer: number = 42;"));
  assert.ok(!renderedPlain.includes("\x1b["));

  let streamedOut = "";
  const mockStream = new Writable({
    write(chunk, _enc, cb) {
      streamedOut += chunk.toString("utf8");
      cb();
    },
  });
  mockStream.isTTY = false;
  const streamMd = new StreamingMarkdownRenderer({ stream: mockStream, colorDepth: "truecolor" });
  for (let i = 0; i < mdSample.length; i += 4) {
    streamMd.push(mdSample.slice(i, i + 4));
  }
  streamMd.finish();
  const streamedPlain = stripAnsi(streamedOut);
  assert.ok(streamedPlain.includes("Wide Report"));
  assert.ok(streamedPlain.includes("SAST"));
  assert.ok(streamedPlain.includes("const answer: number = 42;"));
  assert.ok(streamedOut.includes("\x1b[38;2;"));
  console.log("[PASS] Streaming Markdown renderer with tables, tasks, links, and Nord syntax highlighting");

  const nordDiff = formatColoredDiffPreview("demo.ts", "const a = 1;\nconst b = 2;\n", "const a = 1;\nconst b = 99;\n", {
    colorDepth: "truecolor",
  });
  assert.strictEqual(nordDiff.added, 1);
  assert.strictEqual(nordDiff.removed, 1);
  assert.ok(nordDiff.preview.includes("\x1b[38;2;163;190;140m"));
  assert.ok(nordDiff.preview.includes("\x1b[38;2;191;97;106m"));
  assert.ok(stripAnsi(nordDiff.preview).includes("2"));
  const plainDiff = formatColoredDiffPreview("demo.ts", "a\n", "b\n", { colorDepth: "none" });
  assert.ok(!plainDiff.preview.includes("\x1b["));
  console.log("[PASS] Nord diff preview with line numbers, word highlight, and monochrome fallback");

  const capturedKeys = [];
  const parser = new RawKeyParser((ev) => capturedKeys.push(ev));
  parser.feed("\x1b[Z");
  parser.feed("\x1b[13;2u");
  parser.feed("\x1b[27;2;13~");
  parser.feed("\x1b\r");
  parser.feed("\x1b[1;5D");
  parser.feed("\x1b[200~line1\nline2\n");
  parser.feed("line3\nline4\x1b[201~");
  parser.dispose();

  assert.strictEqual(capturedKeys[0].name, "tab");
  assert.strictEqual(capturedKeys[0].shift, true);
  assert.strictEqual(capturedKeys[1].name, "return");
  assert.strictEqual(capturedKeys[1].shift, true);
  assert.strictEqual(capturedKeys[2].name, "return");
  assert.strictEqual(capturedKeys[2].shift, true);
  assert.strictEqual(capturedKeys[3].name, "return");
  assert.strictEqual(capturedKeys[3].meta, true);
  assert.strictEqual(capturedKeys[4].name, "left");
  assert.strictEqual(capturedKeys[4].ctrl, true);
  assert.strictEqual(capturedKeys[5].name, "paste");
  assert.strictEqual(capturedKeys[5].text, "line1\nline2\nline3\nline4");
  console.log("[PASS] RawKeyParser handles Shift+Tab, Shift+Enter, Alt+Enter, Ctrl+Left, and multi-chunk bracketed paste");

  const mouseEvents = [];
  const mouseParser = new RawKeyParser((ev) => mouseEvents.push(ev));
  mouseParser.feed("\x1b[<0;15;20M");
  mouseParser.feed("\x1b[<0;15;20m");
  mouseParser.feed("\x1b[<2;8;12M");
  mouseParser.feed("\x1b[<64;22;14M");
  mouseParser.feed("\x1b[<65;22;14M");
  mouseParser.feed("\x1b[<20;5");
  mouseParser.feed(";9M");
  mouseParser.feed("\x1b[22;9R");
  mouseParser.dispose();

  assert.strictEqual(mouseEvents[0].mouse.action, "press");
  assert.strictEqual(mouseEvents[0].mouse.button, "left");
  assert.strictEqual(mouseEvents[0].mouse.col, 15);
  assert.strictEqual(mouseEvents[0].mouse.row, 20);
  assert.strictEqual(mouseEvents[1].mouse.action, "release");
  assert.strictEqual(mouseEvents[2].mouse.button, "right");
  assert.strictEqual(mouseEvents[3].mouse.action, "wheel-up");
  assert.strictEqual(mouseEvents[4].mouse.action, "wheel-down");
  assert.strictEqual(mouseEvents[5].mouse.shift, true);
  assert.strictEqual(mouseEvents[5].mouse.ctrl, true);
  assert.strictEqual(mouseEvents[5].mouse.col, 5);
  assert.strictEqual(mouseEvents[5].mouse.row, 9);
  assert.strictEqual(mouseEvents[6].name, "cpr");
  assert.strictEqual(mouseEvents[6].cpr.row, 22);
  assert.strictEqual(mouseEvents[6].cpr.col, 9);

  const mockTtyOut = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  mockTtyOut.isTTY = true;
  mockTtyOut.columns = 100;
  mockTtyOut.rows = 30;
  const dock = new InlineDock(mockTtyOut);
  dock.render(["row0", "row1", "row2", "row3"], { row: 1, col: 6 });
  dock.handleCpr(21, 7);
  assert.strictEqual(dock.getTopRow(), 20);
  assert.deepStrictEqual(dock.screenToDock(10, 22), { row: 2, col: 9 });
  dock.setHitRegions([
    { id: "footer:perm", row: 3, startCol: 10, endCol: 18 },
  ]);
  assert.strictEqual(dock.hitTest(14, 23)?.id, "footer:perm");
  assert.strictEqual(dock.hitTest(5, 23), null);
  dock.clear();

  const footerWithHits = renderStatusFooterWithRegions(
    {
      providerLabel: "antigravity/default",
      providerReady: true,
      toolMode: "full",
      permissionProfile: "accept-edits",
      contextPercent: 18,
      ruleCount: 753,
      verbose: false,
      gitBranch: "main",
      gitDirty: false,
    },
    124,
  );
  const regionIds = footerWithHits.regions.map((r) => r.id);
  assert.ok(regionIds.includes("model"));
  assert.ok(regionIds.includes("perm"));
  assert.ok(regionIds.includes("mode"));
  assert.ok(regionIds.includes("ctx"));
  assert.ok(regionIds.includes("slash-hint"));
  assert.ok(regionIds.includes("file-hint"));
  console.log("[PASS] SGR mouse parsing, CPR dock coordinate mapping, hit-testing, and clickable status footer regions");

  const slashHits = filterSlashSuggestions("/perm", SLASH_COMMANDS);
  assert.strictEqual(slashHits[0]?.insertText, "/permissions");
  const modFiles = new Set(["src/ui/theme.ts"]);
  const fileHits = filterFileSuggestions("theme", ["src/other/theme-old.ts", "src/ui/theme.ts", "README.md"], modFiles);
  assert.strictEqual(fileHits[0]?.label, "src/ui/theme.ts");
  assert.strictEqual(fileHits[0]?.badge, "modified");

  const narrowFooter = stripAnsi(
    renderStatusFooter(
      {
        providerLabel: "antigravity/default",
        providerReady: true,
        toolMode: "full",
        permissionProfile: "plan",
        contextPercent: 22,
        ruleCount: 753,
        verbose: false,
        gitBranch: "main",
        gitDirty: true,
      },
      52,
    ),
  );
  assert.ok(narrowFooter.includes("PLAN"));
  assert.ok(narrowFooter.includes("ctx 22%"));
  const shellWarnFooter = stripAnsi(
    renderStatusFooter(
      {
        providerLabel: "antigravity/default",
        providerReady: true,
        toolMode: "full",
        permissionProfile: "ask",
        contextPercent: 10,
        ruleCount: 753,
        verbose: false,
        shellMode: true,
        destructiveHint: "recursive force deletion",
      },
      100,
    ),
  );
  assert.ok(shellWarnFooter.includes("DESTRUCTIVE"));
  console.log("[PASS] Typeahead fuzzy filtering and responsive status footer");

  assert.strictEqual(matchesPermissionRule("command(npm test)", "run_command", "npm test -- --watch"), true);
  assert.strictEqual(matchesPermissionRule("command(regex:npm run (build|lint))", "command", "npm run lint"), true);
  assert.strictEqual(matchesPermissionRule("write_file(src/)", "write_file", "src/ui/theme.ts"), true);
  assert.strictEqual(matchesPermissionRule("write_file(src/)", "write_file", "tests/a.mjs"), false);

  const tmpDir = mkdtempSync(join(tmpdir(), "wide-cli-tui-"));
  try {
    const store = new PermissionStore(tmpDir, join(tmpDir, "global-perms.json"));
    assert.strictEqual(store.addRule("allow", "command(npm)", "global"), true);
    assert.strictEqual(store.addRule("ask", "command(npm publish)", "project"), true);
    assert.strictEqual(store.addRule("deny", "command(npm publish --force)", "project"), true);
    assert.strictEqual(store.evaluate("command", "npm test"), "allow");
    assert.strictEqual(store.evaluate("command", "npm publish"), "ask");
    assert.strictEqual(store.evaluate("command", "npm publish --force"), "deny");
    console.log("[PASS] PermissionStore rule matching and deny > ask > allow precedence");

    const f1 = join(tmpDir, "file1.ts");
    const f2 = join(tmpDir, "created.ts");
    writeFileSync(f1, "const v = 1;\n", "utf8");
    const cps = new TurnCheckpointStore();
    cps.beginTurn("Update file1", 1);
    writeFileSync(f1, "const v = 2;\n", "utf8");
    cps.recordFileChange({
      filePath: f1,
      relPath: "file1.ts",
      existedBefore: true,
      beforeContent: "const v = 1;\n",
      afterContent: "const v = 2;\n",
      tool: "edit_file",
      added: 1,
      removed: 1,
    });
    cps.commitTurn();

    cps.beginTurn("Create file2", 3);
    writeFileSync(f2, "export const created = true;\n", "utf8");
    cps.recordFileChange({
      filePath: f2,
      relPath: "created.ts",
      existedBefore: false,
      beforeContent: "",
      afterContent: "export const created = true;\n",
      tool: "write_file",
      added: 1,
      removed: 0,
    });
    cps.commitTurn();

    assert.strictEqual(cps.getAggregatedChanges().length, 2);
    const rewound = cps.rewindToTurn(2, true);
    assert.strictEqual(rewound.ok, true);
    assert.strictEqual(rewound.messageCountTarget, 3);
    assert.strictEqual(existsSync(f2), false);
    assert.strictEqual(readFileSync(f1, "utf8"), "const v = 2;\n");

    const rewoundAll = cps.rewindToTurn(1, true);
    assert.strictEqual(rewoundAll.ok, true);
    assert.strictEqual(readFileSync(f1, "utf8"), "const v = 1;\n");
    console.log("[PASS] TurnCheckpointStore records, aggregates, and rewinds file edits cleanly");

    const initDir = join(tmpDir, "fresh-init");
    mkdirSync(initDir, { recursive: true });
    const initRes = initWideWorkspace(initDir);
    assert.ok(initRes.created.includes(".wide/rules"));
    assert.ok(initRes.created.includes(".wide/settings.json"));
    assert.ok(initRes.created.includes(".wideignore"));
    const initAgain = initWideWorkspace(initDir);
    assert.strictEqual(initAgain.created.length, 0);
    assert.strictEqual(initAgain.skipped.length, 3);
    console.log("[PASS] initWideWorkspace creates starter config files idempotently");

    const agyAcc = new AntigravityStreamAccumulator();
    const agyEvents = [];
    agyAcc.feedLine(
      JSON.stringify({ event: "step_update", step_update: { step_type: "thinking" } }),
      () => {},
      (ev) => agyEvents.push(ev.type),
    );
    agyAcc.feedLine(
      JSON.stringify({ event: "step_update", step_update: { step_type: "tool_call", tool_name: "read_file", status: "running" } }),
      () => {},
      (ev) => agyEvents.push(`${ev.type}:${ev.label}`),
    );
    assert.deepStrictEqual(agyEvents, ["thinking", "tool_start:read file"]);

    const claudeAcc = new ClaudeStreamAccumulator();
    const claudeEvents = [];
    claudeAcc.feedLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } } }),
      () => {},
      (ev) => claudeEvents.push(`${ev.type}:${ev.label}`),
    );
    claudeAcc.feedLine(
      JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 120, output_tokens: 45 } }),
      () => {},
      (ev) => claudeEvents.push(`${ev.type}:${ev.inputTokens}/${ev.outputTokens}`),
    );
    assert.deepStrictEqual(claudeEvents, ["tool_start:Bash", "usage:120/45"]);
    console.log("[PASS] Antigravity and Claude Code stream accumulators emit live sub-events");

    const toolSum = formatToolSummary("read_file", { path: "src/index.ts", startLine: 1, endLine: 40 });
    assert.strictEqual(toolSum.verb, "Read");
    assert.ok(toolSum.target.includes("L1-40"));
    assert.strictEqual(summarizeToolResult("read_file", "File: a.ts (Lines 1-10 of 50)\n\n1: x"), "10 lines");

    const errGuide = classifyError(new Error("Gemini API key is required"));
    assert.ok(errGuide.hint && errGuide.hint.includes("/setup"));
    const errBox = stripAnsi(formatErrorCard(new Error("connect ECONNREFUSED 127.0.0.1:11434")));
    assert.ok(errBox.includes("Ollama"));
    console.log("[PASS] Activity summaries and actionable error cards");

    const cliBin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const helpOut = execFileSync(process.execPath, [cliBin, "--help"], { encoding: "utf8" });
    assert.ok(helpOut.includes("Command Groups:"));
    assert.ok(helpOut.includes("doctor"));

    const docOut = execFileSync(process.execPath, [cliBin, "doctor", "--json"], { encoding: "utf8" });
    const docJson = JSON.parse(docOut);
    assert.ok(Array.isArray(docJson.checks) && docJson.checks.length >= 5);

    const inspectPretty = execFileSync(process.execPath, [cliBin, "inspect", "https://example.com/?id=1%27%20OR%201=1--", "--no-color"], {
      encoding: "utf8",
    });
    assert.ok(inspectPretty.includes("Wide HTTP Inspection"));
    assert.ok(!inspectPretty.includes("\x1b["));

    const inspectJsonRaw = execFileSync(process.execPath, [cliBin, "inspect", "https://example.com/?id=1%27%20OR%201=1--", "--json"], {
      encoding: "utf8",
    });
    const inspectJson = JSON.parse(inspectJsonRaw);
    assert.ok(typeof inspectJson.action === "string");

    const vulnFile = join(tmpDir, "vuln.js");
    const fakeTok = ["ghp_", "ABCD1234EFGH5678IJKL9012MNOP3456QRST"].join("");
    writeFileSync(vulnFile, `export const key = "${fakeTok}";\n`, "utf8");

    const scanJsonOut = execFileSync(process.execPath, [cliBin, "scan", vulnFile, "--format", "json", "--no-sca"], {
      encoding: "utf8",
    });
    const scanJson = JSON.parse(scanJsonOut);
    assert.ok(scanJson.findings.length >= 1);

    const failRun = spawnSync(process.execPath, [cliBin, "scan", vulnFile, "--format", "compact", "--fail-on", "HIGH", "--no-sca"], {
      encoding: "utf8",
    });
    assert.strictEqual(failRun.status, 1);
    assert.ok(failRun.stdout.includes("vuln.js"));

    const cleanFile = join(tmpDir, "clean.js");
    writeFileSync(cleanFile, "export const sum = (a, b) => a + b;\n", "utf8");
    const passRun = spawnSync(process.execPath, [cliBin, "scan", cleanFile, "--format", "compact", "--fail-on", "HIGH", "--no-sca"], {
      encoding: "utf8",
    });
    assert.strictEqual(passRun.status, 0);
    console.log("[PASS] CLI subcommands: grouped --help, doctor --json, inspect pretty/--json, scan --format & --fail-on exit codes");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("All UI/TUI & UX tests passed successfully.\n");
}

await runUiTuiTests();
