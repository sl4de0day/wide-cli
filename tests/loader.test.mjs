import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleLoader } from "../dist/security/loader.js";
import { SecurityScanner } from "../dist/security/scanner.js";

const rules = RuleLoader.loadRules();
assert.ok(Array.isArray(rules));
assert.ok(rules.length >= 20);

const cachePath = RuleLoader.getCachePath();
assert.ok(typeof cachePath === "string");
assert.ok(cachePath.includes("rules.json"));

const agentRules = RuleLoader.loadAgentRules();
assert.ok(Array.isArray(agentRules));
assert.ok(agentRules.length >= 8);
assert.ok(agentRules.some(r => r.id === "wide/ai-no-emojis"));
assert.ok(agentRules.some(r => r.id === "wide/cwe078-ai-unsafe-tool-exec"));
assert.ok(agentRules.some(r => r.id === "wide/cwe079-ai-prompt-injection"));
assert.ok(agentRules.some(r => r.id === "wide/cwe400-ai-unbounded-agent-loop"));

const instructions = RuleLoader.buildAgentInstructions(agentRules);
assert.ok(typeof instructions === "string");
assert.ok(instructions.includes("Do not use emojis"));

const sanitized = RuleLoader.sanitizeOutput("Hello 😀 World", agentRules);
assert.strictEqual(sanitized, "Hello  World");

const agentPathInfo = RuleLoader.getAgentRulesPath();
assert.ok(typeof agentPathInfo === "object");
assert.ok("active" in agentPathInfo);
assert.ok("cache" in agentPathInfo);

const tmpWs = mkdtempSync(join(tmpdir(), "wide-cli-loader-"));
try {
  mkdirSync(join(tmpWs, ".wide"), { recursive: true });
  writeFileSync(
    join(tmpWs, ".wide", "rules.json"),
    JSON.stringify([
      {
        id: "wide/test-not-match",
        cwe: "CWE-999",
        category: "Test",
        severity: "HIGH",
        languages: ["js"],
        pattern: "unsafeCall\\(",
        "not-match": "safeConstant",
        message: "Unsafe call detected"
      }
    ]),
    "utf8"
  );
  writeFileSync(
    join(tmpWs, "sample.js"),
    "unsafeCall(userInput);\nunsafeCall(safeConstant);\n",
    "utf8"
  );
  const loadedWithNotMatch = RuleLoader.loadRules(undefined, tmpWs);
  assert.ok(loadedWithNotMatch.some(r => r.id === "wide/test-not-match" && r.notMatch instanceof RegExp));

  const mergedAgent = RuleLoader.loadAgentRules(undefined, tmpWs);
  assert.ok(mergedAgent.some(r => r.id === "wide/ai-no-emojis"));

  assert.strictEqual(RuleLoader.sanitizeOutput("Hello 😀⭐ℹ️1️⃣👨‍💻🇷🇺 World", mergedAgent), "Hello  World");
  const stream = RuleLoader.createStreamSanitizer(mergedAgent);
  const streamed = [
    stream.push("Hi \uD83D"),
    stream.push("\uDE00 1\uFE0F"),
    stream.push("\u20E3 \u2139"),
    stream.push("\uFE0F Ok"),
    stream.flush()
  ].join("");
  assert.strictEqual(streamed, "Hi   Ok");

  const scanner = new SecurityScanner(tmpWs);
  const scanRes = await scanner.scanPath(".", "ALL");
  const hits = scanRes.findings.filter(f => f.id === "wide/test-not-match");
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].line, 1);

  const advisories = RuleLoader.loadAdvisories(tmpWs);
  assert.ok(advisories && typeof advisories === "object");
  assert.ok(Array.isArray(advisories.npm));
} finally {
  rmSync(tmpWs, { recursive: true, force: true });
}

console.log("RuleLoader unit tests passed.");
