import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alignPatchIndentation,
  extractCodeFromFence,
  createQuickFixSuppression,
  runInteractiveFix
} from "../dist/fix.js";
import { SecurityScanner } from "../dist/security/scanner.js";

console.log("Testing Wide CLI Interactive Fix Subsystem...");

const aligned = alignPatchIndentation("const x = 1;\nconst y = 2;", "    const vuln = true;");
assert.strictEqual(aligned, "    const x = 1;\n    const y = 2;");
console.log("[PASS] alignPatchIndentation preserves leading indentation");

const extractedBlock = extractCodeFromFence("```js\nconst fixed = true;\n```");
assert.strictEqual(extractedBlock, "const fixed = true;");
const extractedPlain = extractCodeFromFence("plain text code");
assert.strictEqual(extractedPlain, "plain text code");
console.log("[PASS] extractCodeFromFence parses code fences");

const jsSuppression = createQuickFixSuppression(
  { id: "wide/sql-injection", file: "src/db.js", line: 10, cwe: "CWE-89", category: "INJECTION", severity: "HIGH", snippet: "db.query()", message: "SQLi", remediation: "use params" },
  "    const res = db.query(q);"
);
assert.ok(jsSuppression.includes("    // wide-ignore wide/sql-injection\n    const res = db.query(q);"));

const pySuppression = createQuickFixSuppression(
  { id: "wide/sql-injection", file: "src/db.py", line: 10, cwe: "CWE-89", category: "INJECTION", severity: "HIGH", snippet: "db.query()", message: "SQLi", remediation: "use params" },
  "  res = cursor.execute(q)"
);
assert.ok(pySuppression.includes("  # wide-ignore wide/sql-injection\n  res = cursor.execute(q)"));
console.log("[PASS] createQuickFixSuppression formats JS and Python comment styles");

const testWs = mkdtempSync(join(tmpdir(), "wide-cli-fix-"));

try {
  const emptyRes = await runInteractiveFix({ cwd: testWs, yes: true });
  assert.strictEqual(emptyRes.totalFindings, 0);
  assert.strictEqual(emptyRes.fixed, 0);
  console.log("[PASS] runInteractiveFix on clean workspace returns 0 findings");

  const vulnJs = join(testWs, "app.js");
  const fakeToken = ["ghp_", "ABCD1234EFGH5678IJKL9012MNOP3456QRST"].join("");
  writeFileSync(vulnJs, `export const token = "${fakeToken}";\n`, "utf8");

  const dryRunRes = await runInteractiveFix({
    cwd: testWs,
    path: "app.js",
    dryRun: true,
    yes: true,
    suppressOnly: true
  });
  assert.strictEqual(dryRunRes.totalFindings, 1);
  assert.strictEqual(dryRunRes.fixed, 1);
  const uneditedContent = readFileSync(vulnJs, "utf8");
  assert.strictEqual(uneditedContent.includes("wide-ignore"), false);
  console.log("[PASS] runInteractiveFix --dry-run does not alter files on disk");

  const skipRes = await runInteractiveFix({
    cwd: testWs,
    path: "app.js",
    suppressOnly: true,
    askFn: async () => "n"
  });
  assert.strictEqual(skipRes.fixed, 0);
  assert.strictEqual(skipRes.skipped, 1);
  console.log("[PASS] runInteractiveFix respects user skip decision");

  const appliedRes = await runInteractiveFix({
    cwd: testWs,
    path: "app.js",
    suppressOnly: true,
    yes: true
  });
  assert.strictEqual(appliedRes.fixed, 1);
  assert.strictEqual(appliedRes.filesModified.length, 1);

  const modifiedContent = readFileSync(vulnJs, "utf8");
  assert.ok(modifiedContent.includes("wide-ignore"));
  console.log("[PASS] runInteractiveFix applies quick-fix suppression");

  const scanner = new SecurityScanner(testWs);
  const verifyScan = await scanner.scanPath("app.js", "HIGH");
  assert.strictEqual(verifyScan.findings.length, 0);
  console.log("[PASS] scanner confirms vulnerability is suppressed after fix");
} finally {
  rmSync(testWs, { recursive: true, force: true });
}

console.log("All Fix tests passed successfully.");
