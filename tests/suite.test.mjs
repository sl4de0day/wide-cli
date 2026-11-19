import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../dist/tools/index.js";
import { configManager } from "../dist/config/index.js";
import { ContextManager } from "../dist/agent/context.js";
import { formatUnifiedDiff } from "../dist/ui/diff.js";
import { getPayloadsForType, getAllPayloadTypes } from "../dist/security/payloads.js";
import { RuleLoader } from "../dist/security/loader.js";

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
  console.log("[PASS] native comprehensive SAST scanner");

  const payloadTypes = getAllPayloadTypes();
  assert.ok(payloadTypes.includes("sqli"));
  assert.ok(payloadTypes.includes("xss"));
  assert.ok(payloadTypes.includes("ssrf"));
  const sqliPayloads = getPayloadsForType("sqli");
  assert.ok(sqliPayloads.length > 0);
  console.log("[PASS] security payloads library");

  const payloadToolRes = await executeTool("generate_payloads", { type: "xss" }, { workingDirectory: process.cwd() });
  assert.strictEqual(payloadToolRes.success, true);
  assert.ok(payloadToolRes.output.includes("XSS"));
  console.log("[PASS] payload generator tool");

  const ctxMgr = new ContextManager(100);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "user query" },
    { role: "assistant", content: "resp1" },
    { role: "tool", content: "tool long output exceeding limits ".repeat(10) }
  ];
  const compacted = ctxMgr.compactMessages(msgs);
  assert.ok(compacted.length > 0);

  const longToolConversation = [
    { role: "system", content: "sys" },
    { role: "user", content: "find bugs ".repeat(20) },
    { role: "assistant", content: "a1", toolCalls: [{ id: "t1", name: "list_dir", arguments: {} }] },
    { role: "tool", name: "list_dir", toolCallId: "t1", content: "ok" },
    { role: "assistant", content: "a2", toolCalls: [{ id: "t2", name: "read_file", arguments: {} }] },
    { role: "tool", name: "read_file", toolCallId: "t2", content: "t2" },
    { role: "tool", name: "read_file", toolCallId: "t2b", content: "t2b" },
    { role: "user", content: "next" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "1" },
    { role: "assistant", content: "2" },
    { role: "user", content: "3" },
    { role: "assistant", content: "4" },
    { role: "user", content: "5" },
    { role: "assistant", content: "6" },
  ];
  const pairedCompacted = new ContextManager(10).compactMessages(longToolConversation);
  const firstToolIdx = pairedCompacted.findIndex((m) => m.role === "tool");
  assert.ok(firstToolIdx > 0 && pairedCompacted[firstToolIdx - 1]?.role === "assistant");
  console.log("[PASS] context compactor");

  const testCacheDir = mkdtempSync(join(tmpdir(), "wide-cli-loader-"));
  try {
    await assert.rejects(
      () => RuleLoader.updateRules({
        cacheDir: testCacheDir,
        fetchImpl: async () => new Response("invalid checksums", { status: 200 })
      }),
      /missing from SHA256SUMS/
    );
    writeFileSync(join(testCacheDir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const binRes = await executeTool("read_file", { path: "bin.dat" }, { workingDirectory: testCacheDir });
    assert.strictEqual(binRes.success, false);
    assert.ok(binRes.error?.includes("binary"));
    const badRegexRes = await executeTool("search_files", { pattern: "[unclosed" }, { workingDirectory: testCacheDir });
    assert.strictEqual(badRegexRes.success, false);
    assert.ok(badRegexRes.error?.includes("Invalid search pattern"));
    console.log("[PASS] SHA256SUMS enforcement, binary guard, and regex error guard");
  } finally {
    rmSync(testCacheDir, { recursive: true, force: true });
  }

  configManager.set("provider", "gemini");
  assert.strictEqual(configManager.get().provider, "gemini");
  console.log("[PASS] configuration manager");

  await import("./decision.test.mjs");
  await import("./browser.test.mjs");
  await import("./banner.test.mjs");
  await import("./repl.test.mjs");
  await import("./database.test.mjs");
  await import("./cli-ux.test.mjs");
  await import("./security.test.mjs");
  await import("./inspect.test.mjs");
  await import("./crawler.test.mjs");
  await import("./resilience.test.mjs");
  await import("./hook.test.mjs");
  await import("./fix.test.mjs");
  await import("./trust.test.mjs");

  console.log("\nAll test suites passed successfully.");
}

runTests().catch(err => {
  console.error("[FAIL]", err);
  process.exit(1);
});
