import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findGitDir,
  installPreCommitHook,
  uninstallPreCommitHook,
  runPreCommitHook
} from "../dist/hook.js";

console.log("Testing Wide CLI Git Pre-commit Hook Subsystem...");

const testRepo = mkdtempSync(join(tmpdir(), "wide-cli-hook-"));
const nonGitDir = mkdtempSync(join(tmpdir(), "wide-cli-nongit-"));

try {
  assert.throws(() => findGitDir(nonGitDir), /not inside a git repository/);

  execFileSync("git", ["init"], { cwd: testRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ci@example.com"], { cwd: testRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "ci"], { cwd: testRepo, stdio: "ignore" });

  const detectedGitDir = findGitDir(testRepo);
  assert.ok(detectedGitDir.includes(".git"));
  console.log("[PASS] findGitDir correctly identifies git repository");

  const installRes = installPreCommitHook({ cwd: testRepo, failOn: "HIGH" });
  assert.strictEqual(installRes.installed, true);
  assert.ok(existsSync(installRes.hookPath));

  const hookContent = readFileSync(installRes.hookPath, "utf8");
  assert.ok(hookContent.includes("wide hook run --fail-on HIGH"));
  console.log("[PASS] installPreCommitHook creates executable hook");

  const reinstallRes = installPreCommitHook({ cwd: testRepo, failOn: "CRITICAL" });
  assert.strictEqual(reinstallRes.installed, true);
  const updatedContent = readFileSync(installRes.hookPath, "utf8");
  assert.ok(updatedContent.includes("wide hook run --fail-on CRITICAL"));
  console.log("[PASS] installPreCommitHook updates existing wide hook");

  writeFileSync(installRes.hookPath, "#!/bin/sh\necho foreign hook\n", "utf8");
  const blockedOverwrite = installPreCommitHook({ cwd: testRepo, force: false });
  assert.strictEqual(blockedOverwrite.installed, false);
  assert.ok(blockedOverwrite.message.includes("--force"));

  const forcedOverwrite = installPreCommitHook({ cwd: testRepo, force: true, failOn: "HIGH" });
  assert.strictEqual(forcedOverwrite.installed, true);
  console.log("[PASS] installPreCommitHook respects --force guard for foreign hooks");

  const emptyRes = await runPreCommitHook({ cwd: testRepo });
  assert.strictEqual(emptyRes.blocked, false);
  assert.strictEqual(emptyRes.findings.length, 0);
  console.log("[PASS] runPreCommitHook with no staged changes passes");

  const safeFile = join(testRepo, "safe.js");
  writeFileSync(safeFile, "export const PI = 3.14159;\n", "utf8");
  execFileSync("git", ["add", "safe.js"], { cwd: testRepo, stdio: "ignore" });

  const safeRes = await runPreCommitHook({ cwd: testRepo });
  assert.strictEqual(safeRes.blocked, false);
  console.log("[PASS] runPreCommitHook with safe staged file passes");

  const vulnFile = join(testRepo, "vuln.js");
  const fakeToken = ["ghp_", "1234567890abcdefghijklmnopqrstuvwxyz"].join("");
  writeFileSync(vulnFile, `const secretToken = "${fakeToken}";\n`, "utf8");
  execFileSync("git", ["add", "vuln.js"], { cwd: testRepo, stdio: "ignore" });

  const vulnRes = await runPreCommitHook({ cwd: testRepo, failOn: "HIGH" });
  assert.strictEqual(vulnRes.blocked, true);
  assert.ok(vulnRes.findings.length > 0);
  console.log("[PASS] runPreCommitHook blocks commit on high severity findings");

  writeFileSync(vulnFile, `// wide-ignore generic-api-key\nconst secretToken = "${fakeToken}";\n`, "utf8");
  execFileSync("git", ["add", "vuln.js"], { cwd: testRepo, stdio: "ignore" });

  const suppressedRes = await runPreCommitHook({ cwd: testRepo, failOn: "HIGH" });
  assert.strictEqual(suppressedRes.blocked, false);
  console.log("[PASS] runPreCommitHook respects wide-ignore suppression directive");

  const uninstallRes = uninstallPreCommitHook({ cwd: testRepo });
  assert.strictEqual(uninstallRes.uninstalled, true);
  assert.ok(!existsSync(installRes.hookPath));
  console.log("[PASS] uninstallPreCommitHook cleanly removes hook");

  const secondUninstall = uninstallPreCommitHook({ cwd: testRepo });
  assert.strictEqual(secondUninstall.uninstalled, false);
} finally {
  rmSync(testRepo, { recursive: true, force: true });
  rmSync(nonGitDir, { recursive: true, force: true });
}

console.log("All Hook tests passed successfully.");
