import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityScanner } from "../dist/security/scanner.js";
import { fuzzTargetEndpoint } from "../dist/security/fuzzer.js";
import { isLikelyRealSecret } from "../dist/security/secrets.js";

console.log("Testing Wide CLI Deep SAST, SCA, Git History Secrets & Fuzzer...");

const ws = mkdtempSync(join(tmpdir(), "wide-cli-sec-"));
try {
  mkdirSync(join(ws, ".wide"), { recursive: true });
  mkdirSync(join(ws, ".github", "workflows"), { recursive: true });

  writeFileSync(
    join(ws, "sink.js"),
    "export function runExec(cmdArg) {\n  return exec(\n    'cat ' +\n    cmdArg\n  );\n}\n",
    "utf8"
  );
  writeFileSync(
    join(ws, "route.js"),
    "import express from 'express';\nimport { runExec } from './sink.js';\nexport function handle(req) {\n  const x = req.query.cmd;\n  return runExec(x);\n}\nexport const SAFE = 'EXAMPLE_YOUR_API_KEY_HERE';\n",
    "utf8"
  );
  writeFileSync(
    join(ws, ".github", "workflows", "pr.yml"),
    "on: pull_request_target\nsteps:\n  - uses: actions/checkout@v4\n    with:\n      ref: ${{ github.event.pull_request.head.sha }}\n",
    "utf8"
  );
  writeFileSync(
    join(ws, ".wide", "osv.json"),
    JSON.stringify({
      npm: [{ name: "express", le: "4.17.1", id: "CVE-2024-7771", cwe: "CWE-601", sev: "high", kev: true, note: "redirect bug" }],
      cargo: [{ name: "regex", lt: "1.6.0", id: "CVE-2022-24713", cwe: "CWE-1333", sev: "high", note: "redos" }]
    }),
    "utf8"
  );
  writeFileSync(join(ws, "yarn.lock"), '"express@^4.17.0":\n  version "4.17.1"\n', "utf8");
  writeFileSync(join(ws, "Cargo.lock"), '[[package]]\nname = "regex"\nversion = "1.5.4"\n', "utf8");

  execFileSync("git", ["init"], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ci@example.com"], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "ci"], { cwd: ws, stdio: "ignore" });
  const fakeGh = ["ghp_", "9xK2mP7qR4tV8wZ1aB3cD5eF6gH8jL0nM2q"].join("");
  writeFileSync(join(ws, "secret.js"), `const t = "${fakeGh}";\n`, "utf8");
  execFileSync("git", ["add", "."], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add secret"], { cwd: ws, stdio: "ignore" });
  writeFileSync(join(ws, "secret.js"), "const t = process.env.TOKEN;\n", "utf8");
  execFileSync("git", ["add", "secret.js"], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "remove secret"], { cwd: ws, stdio: "ignore" });

  const sarifOut = join(ws, "out.sarif");
  const scanner = new SecurityScanner(ws);
  const res = await scanner.scanPath(".", "ALL", { scanHistory: true, sarifPath: sarifOut });

  assert.ok(res.findings.some((f) => f.crossFile === true && f.file === "route.js"), "Expected cross-file taint flow on route.js");
  assert.ok(res.findings.some((f) => f.source === "sca" && f.reachable === true && f.message.includes("express@4.17.1") && f.message.includes("CISA KEV")));
  assert.ok(res.findings.some((f) => f.source === "sca" && f.reachable === false && f.message.includes("regex@1.5.4")));
  assert.ok(res.findings.some((f) => f.source === "git-history" && f.cwe === "CWE-798"));
  assert.ok(res.findings.some((f) => f.ruleId === "wide/cicd-gha-pull-request-target-checkout"));
  assert.equal(isLikelyRealSecret("const k = 'EXAMPLE_YOUR_API_KEY_HERE';"), false);
  const sarif = JSON.parse(readFileSync(sarifOut, "utf8"));
  assert.equal(sarif.version, "2.1.0");
  assert.ok(sarif.runs[0].results.length > 0);
  console.log("[PASS] cross-file taint, SCA reachability, git-history secrets, CI/CD rules, and SARIF");

  const server = createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (u.pathname === "/api/ssti" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const val = String(parsed.tpl || "");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(val.includes("7*7") ? "Result: 49" : "Result: ok");
      });
      return;
    }
    if (u.pathname === "/api/account") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: u.searchParams.get("id"), balance: 5000 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const sstiReport = await fuzzTargetEndpoint(`http://127.0.0.1:${port}/api/ssti`, "tpl", "ssti", "POST", { location: "json" });
    assert.equal(sstiReport.isVulnerable, true);
    assert.ok(sstiReport.findings[0].indicator.includes("49"));

    const idorReport = await fuzzTargetEndpoint(`http://127.0.0.1:${port}/api/account`, "id", "idor", "GET", {
      headers: { Authorization: "Bearer user-a" },
      compareHeaders: { Authorization: "Bearer user-b" }
    });
    assert.equal(idorReport.isVulnerable, true);
    assert.ok(idorReport.findings[0].indicator.includes("Differential Access Control"));
    console.log("[PASS] upgraded JSON SSTI & differential IDOR endpoint checks");
  } finally {
    await new Promise((r) => server.close(r));
  }
} finally {
  rmSync(ws, { recursive: true, force: true });
}
