import assert from "node:assert";
import { executeTool } from "../dist/tools/index.js";
import { configManager } from "../dist/config/index.js";
import { ContextManager } from "../dist/agent/context.js";
import { formatUnifiedDiff } from "../dist/ui/diff.js";

async function runTests() {
  console.log("Running Wide CLI test suite...");

  const listRes = await executeTool("list_dir", { path: "." }, { workingDirectory: process.cwd() });
  assert.strictEqual(listRes.success, true);
  console.log("[PASS] list_dir tool executed");

  const diffStr = formatUnifiedDiff("test.txt", "line1\nline2", "line1\nmodified");
  assert.ok(diffStr.includes("original"));
  assert.ok(diffStr.includes("modified"));
  console.log("[PASS] unified diff formatter");

  const scanRes = await executeTool("run_security_scan", { path: "." }, { workingDirectory: process.cwd() });
  assert.strictEqual(scanRes.success, true);
  console.log("[PASS] native SAST scanner");

  const ctxMgr = new ContextManager(100);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "user query" },
    { role: "assistant", content: "resp1" },
    { role: "tool", content: "tool long output exceeding limits ".repeat(10) }
  ];
  const compacted = ctxMgr.compactMessages(msgs);
  assert.ok(compacted.length > 0);
  console.log("[PASS] context compactor");

  configManager.set("provider", "gemini");
  assert.strictEqual(configManager.get().provider, "gemini");
  console.log("[PASS] configuration manager");

  console.log("\nAll 5 test suites passed successfully.");
}

runTests().catch(err => {
  console.error("[FAIL]", err);
  process.exit(1);
});
