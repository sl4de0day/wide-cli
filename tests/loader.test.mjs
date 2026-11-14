import assert from "node:assert/strict";
import { RuleLoader } from "../dist/security/loader.js";

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

console.log("RuleLoader unit tests passed.");
