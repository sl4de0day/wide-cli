import assert from "node:assert/strict";
import { RuleLoader } from "../dist/security/loader.js";

const rules = RuleLoader.loadRules();
assert.ok(Array.isArray(rules));
assert.ok(rules.length >= 20);

const cachePath = RuleLoader.getCachePath();
assert.ok(typeof cachePath === "string");
assert.ok(cachePath.includes("rules.json"));

console.log("RuleLoader unit tests passed.");
