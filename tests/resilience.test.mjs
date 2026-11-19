import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { extractArticleFromHtml, shouldBlockFastReadRequest } from "../dist/tools/article.js";
import { extractDocxText, isDocxPath } from "../dist/tools/docx.js";
import {
  AgentPool,
  checkUrlSecurity,
  CircuitBreaker,
  computeJitterBackoffMs,
  HostBreakerRegistry,
  validateRedirectChain,
} from "../dist/tools/resilience.js";
import { buildAgentSystemPrompt } from "../dist/agent/index.js";
import { startCliToolBridge } from "../dist/providers/claude-code.js";
import { executeTool, getToolDefinitions } from "../dist/tools/index.js";

console.log("Testing Wide CLI article extractor, fastRead filter, .docx reader, redirect SSRF & circuit breaker...");

const articleHtml = `
  <html>
    <head>
      <title>Fallback Title</title>
      <meta property="og:title" content="Resilient Scraper Architecture">
      <meta name="author" content="Wide Security">
      <meta property="article:published_time" content="2026-11-19">
      <meta name="keywords" content="browser, security, wide">
    </head>
    <body>
      <nav>Navigation Sign In Register</nav>
      <aside>Sidebar Ad Promotion</aside>
      <article>
        <h1>Resilient Scraper Architecture</h1>
        <p>First paragraph describing clean content extraction with &amp; HTML entities decoded.</p>
        <p>Second paragraph proving nav and footer noise do not pollute token budgets.</p>
        <img src="/img/diagram.png">
      </article>
      <footer>All rights reserved footer text</footer>
    </body>
  </html>
`;

const article = extractArticleFromHtml(articleHtml, "https://docs.example.test/post/1");
assert.equal(article.title, "Resilient Scraper Architecture");
assert.equal(article.author, "Wide Security");
assert.equal(article.date, "2026-11-19");
assert.deepEqual(article.keywords, ["browser", "security", "wide"]);
assert.ok(article.cleanText.includes("First paragraph describing clean content extraction with & HTML entities decoded."));
assert.equal(article.cleanText.includes("Navigation Sign In"), false);
assert.equal(article.cleanText.includes("All rights reserved footer"), false);
assert.ok(article.allImages.includes("https://docs.example.test/img/diagram.png"));

assert.equal(shouldBlockFastReadRequest("image", "https://cdn.test/photo.webp"), true);
assert.equal(shouldBlockFastReadRequest("font", "https://cdn.test/inter.woff2"), true);
assert.equal(shouldBlockFastReadRequest("stylesheet", "https://cdn.test/app.css"), true);
assert.equal(shouldBlockFastReadRequest("script", "https://www.googletagmanager.com/gtm.js"), true);
assert.equal(shouldBlockFastReadRequest("document", "https://docs.example.test/post/1"), false);

function buildTestDocx(xmlContent) {
  const nameBuf = Buffer.from("word/document.xml", "utf8");
  const xmlBuf = Buffer.from(xmlContent, "utf8");
  const compData = deflateRawSync(xmlBuf);

  const lf = Buffer.alloc(30);
  lf.writeUInt32LE(0x04034b50, 0);
  lf.writeUInt16LE(20, 4);
  lf.writeUInt16LE(8, 8);
  lf.writeUInt32LE(compData.length, 18);
  lf.writeUInt32LE(xmlBuf.length, 22);
  lf.writeUInt16LE(nameBuf.length, 26);
  const lfFull = Buffer.concat([lf, nameBuf, compData]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(compData.length, 20);
  cd.writeUInt32LE(xmlBuf.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdFull = Buffer.concat([cd, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdFull.length, 12);
  eocd.writeUInt32LE(lfFull.length, 16);

  return Buffer.concat([lfFull, cdFull, eocd]);
}

assert.equal(isDocxPath("specs/Audit-Report.DOCX"), true);
assert.equal(isDocxPath("src/index.ts"), false);

const docxBuf = buildTestDocx(
  "<w:document><w:body><w:p><w:r><w:t>Alpha &amp; Beta</w:t></w:r></w:p><w:p><w:r><w:t>Gamma Line</w:t></w:r></w:p></w:body></w:document>",
);
const extractedDocx = extractDocxText(docxBuf);
assert.equal(extractedDocx.ok, true);
assert.equal(extractedDocx.paragraphs, 2);
assert.equal(extractedDocx.text, "Alpha & Beta\nGamma Line");
assert.equal(extractDocxText(Buffer.from("not-a-zip")).ok, false);

const tmpWs = mkdtempSync(join(tmpdir(), "wide-cli-docx-"));
try {
  writeFileSync(join(tmpWs, "spec.docx"), docxBuf);
  const readDocxTool = await executeTool("read_file", { path: "spec.docx" }, { workingDirectory: tmpWs });
  assert.equal(readDocxTool.success, true);
  assert.ok(readDocxTool.output.includes("1: Alpha & Beta"));
  assert.ok(readDocxTool.output.includes("2: Gamma Line"));

  const readDocumentRes = await executeTool("read_document", { path: "spec.docx" }, { workingDirectory: tmpWs });
  assert.equal(readDocumentRes.success, true);
  assert.ok(readDocumentRes.output.includes("1: Alpha & Beta"));
} finally {
  rmSync(tmpWs, { recursive: true, force: true });
}

const sysPromptFull = buildAgentSystemPrompt(undefined, { toolMode: "full", allowBrowser: true });
assert.ok(sysPromptFull.includes("Wide Ecosystem Capability Playbook"));
assert.ok(sysPromptFull.includes("read_document"));
assert.ok(sysPromptFull.includes("fastRead=true"));
assert.ok(sysPromptFull.includes("mode='article'"));
assert.ok(sysPromptFull.includes("crawl_target"));
assert.ok(sysPromptFull.includes("inspect_http_message"));
assert.ok(sysPromptFull.includes("useBreaker=true"));

const mcpBridge = await startCliToolBridge(() => getToolDefinitions({ toolMode: "full", allowBrowser: true }));
try {
  const getToolsRes = await fetch(`http://127.0.0.1:${mcpBridge.port}/tools`, {
    headers: { Authorization: `Bearer ${mcpBridge.token}` },
  });
  const getToolsJson = await getToolsRes.json();
  const toolNames = getToolsJson.tools.map((t) => t.name);
  assert.ok(toolNames.includes("read_document"));
  assert.ok(toolNames.includes("crawl_target"));
  assert.ok(toolNames.includes("inspect_http_message"));
  const browserExtTool = getToolsJson.tools.find((t) => t.name === "browser_extract");
  assert.ok(browserExtTool?.inputSchema?.properties?.mode);

  const rpcListRes = await fetch(mcpBridge.mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mcpBridge.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const rpcListJson = await rpcListRes.json();
  const rpcTools = rpcListJson.result?.tools || [];
  const inspectSpec = rpcTools.find((t) => t.name === "inspect_http_message");
  const sendHttpSpec = rpcTools.find((t) => t.name === "send_http_request");
  assert.ok(inspectSpec?.inputSchema?.properties?.learning);
  assert.ok(sendHttpSpec?.inputSchema?.properties?.useBreaker);

  const rpcCallRes = await fetch(mcpBridge.mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mcpBridge.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "inspect_http_message",
        arguments: { url: "https://shop.test/search?q=1' OR '1'='1", learning: true },
      },
    }),
  });
  const rpcCallJson = await rpcCallRes.json();
  assert.equal(rpcCallJson.result?.isError, false);
  const parsedMcpInspect = JSON.parse(rpcCallJson.result.content[0].text);
  assert.ok(parsedMcpInspect.scores.sql >= 8);
  assert.ok(parsedMcpInspect.drafts.length > 0);
} finally {
  mcpBridge.close();
}

assert.equal(checkUrlSecurity("https://user:pass@example.com/admin").allowed, false);
assert.equal(checkUrlSecurity("ftp://example.com/file").allowed, false);
assert.equal(
  validateRedirectChain(["https://public.test/a", "http://169.254.169.254/latest/meta-data/"], { allowPrivate: false }).allowed,
  false,
);
assert.equal(
  validateRedirectChain(Array.from({ length: 7 }, (_, i) => `https://public.test/${i}`), { maxRedirects: 5 }).allowed,
  false,
);
assert.equal(
  validateRedirectChain(["https://public.test/a", "https://cdn.public.test/b"], { allowPrivate: false }).allowed,
  true,
);

const breaker = new CircuitBreaker({ failureThreshold: 3, initialCooldownMs: 40, maxCooldownMs: 200 });
assert.equal(breaker.canTry(100), true);
breaker.onBlocked(100);
breaker.onBlocked(105);
breaker.onBlocked(110);
assert.equal(breaker.state, "OPEN");
assert.equal(breaker.canTry(120), false);
assert.equal(breaker.canTry(160), true);
assert.equal(breaker.state, "HALF_OPEN");
breaker.onBlocked(165);
assert.equal(breaker.state, "OPEN");
assert.equal(breaker.cooldownMs, 160);
breaker.onSuccess();
assert.equal(breaker.state, "CLOSED");
assert.equal(breaker.cooldownMs, 40);

const hostReg = new HostBreakerRegistry({ failureThreshold: 2, initialCooldownMs: 50 });
hostReg.recordStatus("https://target.test/a", 429, 1000);
hostReg.recordStatus("https://target.test/b", 403, 1010);
assert.equal(hostReg.canTry("https://target.test/c", 1020), false);

const jitterVal = computeJitterBackoffMs(2, 100, 40, () => 0.5);
assert.equal(jitterVal, 420);

const pool = new AgentPool();
const p1 = pool.getAgent("https:", false, "http://127.0.0.1:8080");
const p2 = pool.getAgent("https:", false, "http://127.0.0.1:8080");
assert.equal(p1, p2);
assert.equal(pool.size(), 1);
pool.closeAll();

const credToolRes = await executeTool("send_http_request", { url: "https://user:pass@example.com/" }, { workingDirectory: process.cwd() });
assert.equal(credToolRes.success, false);
assert.ok(String(credToolRes.error || "").includes("credentials"));

let flakyCount = 0;
let blockerCount = 0;
const srv = createServer((req, res) => {
  const urlPath = req.url || "/";
  if (urlPath === "/article") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(articleHtml);
    return;
  }
  if (urlPath === "/flaky") {
    flakyCount += 1;
    if (flakyCount <= 2) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("busy");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("healthy");
    return;
  }
  if (urlPath === "/waf") {
    blockerCount += 1;
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("blocked");
    return;
  }
  if (urlPath === "/redir-loopback") {
    res.writeHead(302, { Location: "http://127.0.0.1/secret" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});

await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
const prevHttpOnly = process.env.WIDE_CLI_BROWSER_HTTP_ONLY;
process.env.WIDE_CLI_BROWSER_HTTP_ONLY = "1";
try {
  const port = srv.address().port;

  const openRes = await executeTool(
    "browser_open",
    { url: `http://127.0.0.1:${port}/article`, fastRead: true },
    { workingDirectory: process.cwd() },
  );
  assert.equal(openRes.success, true);

  const extractJsonRes = await executeTool(
    "browser_extract",
    { mode: "article" },
    { workingDirectory: process.cwd() },
  );
  assert.equal(extractJsonRes.success, true);
  const parsedExtract = JSON.parse(extractJsonRes.output);
  assert.equal(parsedExtract.title, "Resilient Scraper Architecture");
  assert.ok(parsedExtract.cleanText.includes("First paragraph describing clean content extraction"));

  const extractTextRes = await executeTool(
    "browser_extract",
    { cleanText: true },
    { workingDirectory: process.cwd() },
  );
  assert.equal(extractTextRes.success, true);
  assert.ok(extractTextRes.output.includes("Page Title: Resilient Scraper Architecture"));
  assert.equal(extractTextRes.output.includes("All rights reserved footer"), false);

  await executeTool("browser_close", {}, { workingDirectory: process.cwd() });

  const retryRes = await executeTool(
    "send_http_request",
    { url: `http://127.0.0.1:${port}/flaky`, retries: 2 },
    { workingDirectory: process.cwd() },
  );
  assert.equal(retryRes.success, true);
  assert.ok(retryRes.output.includes("Status: 200"));
  assert.ok(retryRes.output.includes("healthy"));

  const wafUrl = `http://127.0.0.1:${port}/waf`;
  await executeTool("send_http_request", { url: wafUrl, useBreaker: true }, { workingDirectory: process.cwd() });
  await executeTool("send_http_request", { url: wafUrl, useBreaker: true }, { workingDirectory: process.cwd() });
  await executeTool("send_http_request", { url: wafUrl, useBreaker: true }, { workingDirectory: process.cwd() });
  const openBreakRes = await executeTool("send_http_request", { url: wafUrl, useBreaker: true }, { workingDirectory: process.cwd() });
  assert.equal(openBreakRes.success, false);
  assert.ok(String(openBreakRes.error || "").includes("Circuit breaker OPEN"));
  assert.equal(blockerCount, 3);
} finally {
  if (prevHttpOnly === undefined) delete process.env.WIDE_CLI_BROWSER_HTTP_ONLY;
  else process.env.WIDE_CLI_BROWSER_HTTP_ONLY = prevHttpOnly;
  await new Promise((resolve) => srv.close(resolve));
}

console.log("[PASS] Article extractor, fastRead filter, .docx reader, redirect SSRF & circuit breaker tests passed.");
