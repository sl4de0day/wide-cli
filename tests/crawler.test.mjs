import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  auditSecurityHeaders,
  decodeJwtTokens,
  fingerprintUrl,
  hammingDistance64,
  NetworkPolicy,
  PathTrie,
  scanSecretsWithEntropy,
  ScopeManager,
  simhash64,
  WideCrawler,
} from "../dist/security/crawler.js";
import { executeTool } from "../dist/tools/index.js";

console.log("Testing Wide CLI recon crawler, SSRF policy, PathTrie, SimHash, and passive auditors...");

const policy = new NetworkPolicy({ allowPrivate: false });
assert.equal(policy.allows("http://127.0.0.1/"), false);
assert.equal(policy.allows("http://169.254.169.254/latest/meta-data/"), false);
assert.equal(policy.allows("http://[::1]/"), false);
assert.equal(policy.allows("http://100.64.0.1/"), false);
assert.equal(policy.allows("https://app.example.com/"), true);

const scope = new ScopeManager({ fieldScope: "rdn", allowPrivate: false });
assert.equal(scope.validate("https://api.example.com/v1", "www.example.com"), true);
assert.equal(scope.validate("https://evil.org/", "www.example.com"), false);

const trie = new PathTrie(2);
fingerprintUrl("https://app.test/items/alpha", trie);
fingerprintUrl("https://app.test/items/beta", trie);
assert.equal(fingerprintUrl("https://app.test/items/gamma?z=1&a=2", trie), "https://app.test/items/{param}?a&z");
assert.equal(fingerprintUrl("https://app.test/users/99"), "https://app.test/users/{num}");

const s1 = simhash64(["product catalog", "catalog item", "item pricing"]);
const s2 = simhash64(["product catalog", "catalog item", "item pricing"]);
assert.equal(hammingDistance64(s1, s2), 0);

const sec = auditSecurityHeaders({ Server: "nginx/1.25" });
assert.ok(sec.some((i) => i.header === "content-security-policy" && i.issue === "missing"));
assert.ok(sec.some((i) => i.header === "server" && i.issue.includes("nginx/1.25")));

const h = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
const p = "eyJpc3MiOiJ3aWRlIiwic3ViIjoidS0xIn0";
const jwts = decodeJwtTokens(`Bearer ${h}.${p}.sigvalue`);
assert.equal(jwts.length, 1);
assert.equal(jwts[0].payload.iss, "wide");

const gKey = ["AIza", "SyD1234567890abcdefghijklmnopqrstuv"].join("");
const secrets = scanSecretsWithEntropy(`api_key="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; g="${gKey}";`);
assert.equal(secrets.length, 1);
assert.equal(secrets[0].kind, "Google API Key");

const ssrfHttpRes = await executeTool(
  "send_http_request",
  { url: "http://127.0.0.1:9/admin", allowPrivate: false },
  { workingDirectory: process.cwd() },
);
assert.equal(ssrfHttpRes.success, false);
assert.ok(ssrfHttpRes.error?.includes("NetworkPolicy"));

const srv = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html", Server: "Nginx" });
    res.end('<html><body><a href="/about">About</a><script>fetch("/api/health");</script></body></html>');
    return;
  }
  if (req.url === "/about") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>About page unique content details information team contact</body></html>");
    return;
  }
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }
  res.writeHead(404);
  res.end("missing");
});

await new Promise((r) => srv.listen(0, "127.0.0.1", r));
try {
  const port = srv.address().port;
  const crawler = new WideCrawler();
  await assert.rejects(() => crawler.crawl(`http://127.0.0.1:${port}/`, { allowPrivate: false }), /NetworkPolicy/);

  const toolRes = await executeTool(
    "crawl_target",
    { url: `http://127.0.0.1:${port}/`, maxDepth: 2, maxPages: 10, allowPrivate: true },
    { workingDirectory: process.cwd() },
  );
  assert.equal(toolRes.success, true);
  const parsed = JSON.parse(toolRes.output);
  assert.ok(parsed.visited >= 2);
  assert.ok(parsed.endpoints.some((u) => u.endsWith("/api/health")));
  console.log("[PASS] Wide CLI crawler, SSRF NetworkPolicy, PathTrie, SimHash, JWT & secret auditors");
} finally {
  await new Promise((r) => srv.close(r));
}
