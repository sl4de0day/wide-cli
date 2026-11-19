import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AhoCorasick,
  compileSafePattern,
  detectSqli,
  detectXss,
  evaluateHttpInspection,
  extractHttpZones,
  hasNestedQuantifiers,
  inspectHttpHeadersSmuggling,
  inspectRawHttpRequest,
  inspectRawHttpResponse,
  matchSafePattern,
  normalizeEvasion,
  testUserRegexSafe,
} from "../dist/security/inspect.js";
import { RuleLoader } from "../dist/security/loader.js";
import { WideCrawler } from "../dist/security/crawler.js";
import { executeTool } from "../dist/tools/index.js";

console.log("Testing Wide CLI HTTP inspection, lexical SQLi/XSS, RFC 9112 smuggling, ReDoS NFA, and evasion probes...");

const sqliSamples = [
  "1' OR '1'='1",
  "-1' UNION SELECT 1,2,3--",
  "admin'/*",
  "1'/**/or/**/1=1#",
  "1' AND SLEEP(5)--",
  "1'; DROP TABLE users--",
  "1) OR (1=1",
  "' OR 1=1 LIMIT 1--",
];
for (const sample of sqliSamples) {
  assert.equal(detectSqli(sample).sqli, true, `expected SQLi positive: ${sample}`);
}
for (const benign of ["hello world", "2026-11-19", "application/json", "user-profile-v2"]) {
  assert.equal(detectSqli(benign).sqli, false, `expected SQLi negative: ${benign}`);
}

const xssVectors = [
  "<script>alert(1)</script>",
  "<s\x00cript>alert(1)</s\x00cript>",
  "<a href=\"&#106;avascript:alert(1)\">click</a>",
  "' onerror='alert(1)",
  "<svg/onload=alert(1)>",
  "<iframe src=javascript:alert(document.domain)>",
];
for (const sample of xssVectors) {
  assert.equal(detectXss(sample).xss, true, `expected XSS positive: ${sample}`);
}
assert.equal(detectXss("<div class=\"card\">Hello World</div>").xss, false);

const smuggleClTe = inspectRawHttpRequest(
  "POST /submit HTTP/1.1\r\nHost: target.test\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
);
assert.equal(smuggleClTe.ok, false);
assert.equal(smuggleClTe.error, "AmbiguousFraming");

const smuggleDupCl = inspectRawHttpRequest(
  "POST /submit HTTP/1.1\r\nHost: target.test\r\nContent-Length: 5\r\nContent-Length: 10\r\n\r\nhello",
);
assert.equal(smuggleDupCl.ok, false);
assert.equal(smuggleDupCl.error, "DuplicateContentLength");

const smuggleObsFold = inspectRawHttpRequest(
  "GET / HTTP/1.1\r\nHost: target.test\r\nX-Test: one\r\n two\r\n\r\n",
);
assert.equal(smuggleObsFold.ok, false);
assert.equal(smuggleObsFold.error, "ObsoleteLineFolding");

const smuggleBadTe = inspectHttpHeadersSmuggling([
  ["Host", "target.test"],
  ["Transfer-Encoding", "gzip, chunked"],
]);
assert.ok(smuggleBadTe.length > 0);

const poisonedResp = inspectRawHttpResponse(
  "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\n\r\npoison",
  "GET",
);
assert.equal(poisonedResp.ok, false);
assert.ok(poisonedResp.poisoningVectors.length > 0);

const ev1 = normalizeEvasion("%u0027%2520OR%00%c0%af1=1");
assert.equal(ev1.signals.percentUEscape, true);
assert.equal(ev1.signals.nullByte, true);
assert.equal(ev1.signals.overlongUtf8, true);
assert.equal(ev1.signals.leftoverPercent, true);

const zones = extractHttpZones({
  url: "https://example.test/api/search?q=' OR 1=1--",
  headers: [
    ["User-Agent", "<script>alert(1)</script>"],
    ["Content-Type", "application/json"],
  ],
  body: JSON.stringify({ nested: { path: "../../etc/passwd" } }),
});
assert.ok(zones.fields.some((f) => f.zone === "args" && f.name === "q"));
assert.ok(zones.fields.some((f) => f.zone === "json" && f.name.includes("nested")));
assert.ok(zones.fields.some((f) => f.zone === "header" && f.name.toLowerCase() === "user-agent"));

assert.equal(hasNestedQuantifiers("(a+)+$"), true);
assert.equal(hasNestedQuantifiers("(x|x+)+"), true);
assert.equal(hasNestedQuantifiers("\\bSELECT\\s+\\*"), false);

const redosRejected = testUserRegexSafe("(a+)+$", "", "aaaaaaaaaaaaaaaaaaaaaaaaa!");
assert.equal(redosRejected.ok, false);

const safeMatched = testUserRegexSafe("^SELECT\\s+\\*", "i", "select * from users\nhello");
assert.equal(safeMatched.ok, true);
assert.equal(safeMatched.engine, "nfa");
assert.equal(safeMatched.matches.length, 1);

const prog = compileSafePattern("^(a+)+c$", "");
const t0 = Date.now();
const nfaHit = matchSafePattern(prog, `${"a".repeat(2000)}!`);
const elapsed = Date.now() - t0;
assert.equal(nfaHit, false);
assert.ok(elapsed < 250, `NFA should run in linear time, took ${elapsed}ms`);

const ac = new AhoCorasick([
  { ruleId: 101, literal: "union select" },
  { ruleId: 102, literal: "/etc/passwd" },
]);
const acHits = ac.scan("GET /?f=/etc/passwd&q=1+union select+2");
assert.ok(acHits.some((h) => h.ruleId === 101));
assert.ok(acHits.some((h) => h.ruleId === 102));

const tmpDir = mkdtempSync(join(tmpdir(), "wide-rule-loader-"));
try {
  const customRuleFile = join(tmpDir, "rules.json");
  writeFileSync(
    customRuleFile,
    JSON.stringify({
      rules: [
        { id: "custom/safe", pattern: "eval\\(", category: "Security", severity: "HIGH", message: "safe" },
        { id: "custom/redos", pattern: "(a+)+$", category: "Security", severity: "HIGH", message: "redos" },
      ],
    }),
    "utf8",
  );
  const loaded = RuleLoader.loadRules(customRuleFile, tmpDir);
  assert.ok(loaded.some((r) => r.id === "custom/safe"));
  assert.ok(!loaded.some((r) => r.id === "custom/redos"));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const blockReport = evaluateHttpInspection({
  url: "https://shop.test/search?q=1' UNION SELECT 1,2--",
  method: "GET",
  headers: [["Host", "shop.test"]],
  body: "",
});
assert.ok(blockReport.scores.sql >= 8);
assert.ok(blockReport.action === "block" || blockReport.action === "reject");

const learnReport = evaluateHttpInspection(
  {
    url: "https://shop.test/search?q=1' UNION SELECT 1,2--",
    method: "GET",
    headers: [["Host", "shop.test"]],
    body: "",
  },
  { learning: true, today: "2026-11-19" },
);
assert.equal(learnReport.action, "log");
assert.ok(learnReport.drafts.length > 0);
assert.ok(learnReport.drafts[0].snippet.includes("except "));

const ruleIds = learnReport.hits.map((h) => h.ruleId);
const activeExceptionReport = evaluateHttpInspection(
  {
    url: "https://shop.test/search?q=1' UNION SELECT 1,2--",
    method: "GET",
    headers: [["Host", "shop.test"]],
    body: "",
  },
  {
    today: "2026-11-19",
    exceptions: [
      {
        ruleIds,
        pathPrefix: "/search",
        adjustments: { sql: -50, xss: -50 },
        until: "2099-12-31",
      },
    ],
  },
);
assert.equal(activeExceptionReport.action, "pass");
assert.ok(activeExceptionReport.suppressed > 0);

const expiredExceptionReport = evaluateHttpInspection(
  {
    url: "https://shop.test/search?q=1' UNION SELECT 1,2--",
    method: "GET",
    headers: [["Host", "shop.test"]],
    body: "",
  },
  {
    today: "2026-11-19",
    exceptions: [
      {
        ruleIds,
        pathPrefix: "/search",
        adjustments: { sql: -50, xss: -50 },
        until: "2020-01-01",
      },
    ],
  },
);
assert.ok(expiredExceptionReport.expiredExceptions > 0);
assert.ok(expiredExceptionReport.scores.sql >= 8);

const inspectToolRes = await executeTool(
  "inspect_http_message",
  {
    url: "https://shop.test/search?q=1' OR '1'='1",
    method: "GET",
    learning: true,
  },
  { workingDirectory: process.cwd() },
);
assert.equal(inspectToolRes.success, true);
const parsedToolOut = JSON.parse(inspectToolRes.output);
assert.ok(parsedToolOut.scores.sql >= 8);
assert.ok(Array.isArray(parsedToolOut.drafts) && parsedToolOut.drafts.length > 0);

const crawlSrv = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body>Hello</body></html>");
});
await new Promise((resolve) => crawlSrv.listen(0, "127.0.0.1", resolve));
try {
  const port = crawlSrv.address().port;
  const crawler = new WideCrawler();
  const crawlRes = await crawler.crawl(`http://127.0.0.1:${port}/`, {
    maxDepth: 0,
    maxPages: 2,
    probePaths: false,
    allowPrivate: true,
  });
  assert.ok(crawlRes.pages.length >= 1);
  assert.equal(typeof crawlRes.pages[0].inspectAction, "string");
} finally {
  await new Promise((resolve) => crawlSrv.close(resolve));
}

console.log("[PASS] HTTP inspection, lexical SQLi/XSS, smuggling conformance, ReDoS NFA & evasion tests passed.");
