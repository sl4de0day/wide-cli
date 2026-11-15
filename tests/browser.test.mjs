import assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { HeadlessBrowserController, stripBrowserEmojis } from "../dist/tools/browser.js";
import { executeTool, ALL_TOOLS } from "../dist/tools/index.js";

async function runBrowserTests() {
  console.log("Testing Wide CLI Browser Engine...");

  const expectedBrowserTools = [
    "browser_open",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_press",
    "browser_hover",
    "browser_select",
    "browser_scroll",
    "browser_wait",
    "browser_extract",
    "browser_screenshot",
    "browser_console",
    "browser_cookies",
    "browser_eval",
    "browser_export_har",
    "browser_close"
  ];
  for (const name of expectedBrowserTools) {
    assert.ok(ALL_TOOLS[name], `Missing tool registration: ${name}`);
  }

  const ctrl = new HeadlessBrowserController();
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Wide Security Testing Hub</title>
        <script>console.log("test");</script>
      </head>
      <body>
        <h1>Terminal Security Lab</h1>
        <form action="/login" method="POST">
          <input type="text" name="user" placeholder="Username" />
          <input type="password" name="pass" placeholder="Password" />
          <button type="submit">Sign In</button>
        </form>
        <a href="/security/report">Vulnerability Report</a>
      </body>
    </html>
  `;

  const parsed = ctrl.parseHtml(sampleHtml);
  assert.strictEqual(parsed.title, "Wide Security Testing Hub");
  assert.ok(parsed.elements.length >= 4);
  assert.strictEqual(parsed.elements[0].ref, "@e1");

  const roles = parsed.elements.map(e => e.role);
  assert.ok(roles.includes("input[text]"));
  assert.ok(roles.includes("button"));
  assert.ok(roles.includes("link"));
  console.log("[PASS] HTML and @eN DOM element parser");

  const fillRes = await ctrl.fill("@e1", "admin_sec");
  assert.ok(fillRes.includes("Filled"));
  console.log("[PASS] Form input filling by @eN ref");

  ctrl["state"].rawHtml = sampleHtml;
  ctrl["state"].title = "Wide Security Testing Hub";
  ctrl["state"].textContent = parsed.textContent;
  ctrl["state"].elements = parsed.elements;

  const extractRes = ctrl.extract("Terminal");
  assert.ok(extractRes.includes("Terminal Security Lab"));
  console.log("[PASS] Text extraction and keyword matching");

  const shot = ctrl.screenshot();
  assert.ok(shot.includes("HEADLESS BROWSER SNAPSHOT"));
  assert.ok(shot.includes("Wide Security Testing Hub"));
  console.log("[PASS] Viewport snapshot formatting");

  const toolTypeRes = await executeTool("browser_type", { target: "user", text: "sl4de" }, { workingDirectory: process.cwd() });
  assert.strictEqual(toolTypeRes.success, true);
  console.log("[PASS] browser_type tool execution");

  const toolShotRes = await executeTool("browser_screenshot", {}, { workingDirectory: process.cwd() });
  assert.strictEqual(toolShotRes.success, true);
  console.log("[PASS] browser_screenshot tool execution");

  const toolCloseRes = await executeTool("browser_close", {}, { workingDirectory: process.cwd() });
  assert.strictEqual(toolCloseRes.success, true);
  console.log("[PASS] browser_close tool execution");

  const exe = ctrl.findSystemBrowserExecutable();
  if (exe) {
    const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "wide-cli-live-test-"));
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Wide Live CDP Page</title></head>
          <body>
            <h1>Interactive Live DOM</h1>
            <input id="q" name="query" placeholder="Search" />
            <button id="go" type="button" onclick="document.getElementById('out').textContent = 'Typed:' + document.getElementById('q').value; console.log('wide-btn-clicked');">Apply</button>
            <div id="out">Idle</div>
          </body>
        </html>
      `);
    });

    try {
      await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}/`;

      const navRes = await executeTool("browser_navigate", { url: baseUrl }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(navRes.success, true);
      assert.ok(navRes.output.includes("Wide Live CDP Page"));
      assert.ok(navRes.output.includes("@e1"));

      const snapRes = await executeTool("browser_snapshot", {}, { workingDirectory: tmpWorkDir });
      assert.strictEqual(snapRes.success, true);
      assert.ok(snapRes.output.includes("@e2"));

      const typeRes = await executeTool("browser_type", { target: "@e1", text: "security-check" }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(typeRes.success, true);

      const clickRes = await executeTool("browser_click", { target: "@e2" }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(clickRes.success, true);
      assert.ok(clickRes.output.includes("Typed:security-check"));

      const evalRes = await executeTool("browser_eval", { script: "document.getElementById('out').textContent" }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(evalRes.success, true);
      assert.ok(evalRes.output.includes("Typed:security-check"));

      const consoleRes = await executeTool("browser_console", { clear: false }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(consoleRes.success, true);
      assert.ok(consoleRes.output.includes("wide-btn-clicked"));

      const liveShot = await executeTool("browser_screenshot", {}, { workingDirectory: tmpWorkDir });
      assert.strictEqual(liveShot.success, true);
      assert.ok(liveShot.output.includes(".png"));

      const scrollRes = await executeTool("browser_scroll", { direction: "down", pixels: 120 }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(scrollRes.success, true);

      const cookieSet = await executeTool("browser_cookies", { action: "set", name: "wide_sid", value: "abc123", url: baseUrl }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(cookieSet.success, true);
      const cookieGet = await executeTool("browser_cookies", { action: "get" }, { workingDirectory: tmpWorkDir });
      assert.ok(cookieGet.output.includes("wide_sid"));

      const harRes = await executeTool("browser_export_har", {}, { workingDirectory: tmpWorkDir });
      assert.strictEqual(harRes.success, true);
      const harObj = JSON.parse(harRes.output);
      assert.strictEqual(harObj?.log?.version, "1.2");
      assert.ok(Array.isArray(harObj?.log?.entries));

      await executeTool("browser_close", {}, { workingDirectory: tmpWorkDir });
      const stealthOpen = await executeTool("browser_open", { url: baseUrl, stealth: true }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(stealthOpen.success, true);
      const webdriverRes = await executeTool("browser_eval", { script: "String(navigator.webdriver)" }, { workingDirectory: tmpWorkDir });
      assert.strictEqual(webdriverRes.success, true);
      assert.ok(!webdriverRes.output.includes("true"), `Expected stealth navigator.webdriver not to be true, got ${webdriverRes.output}`);

      console.log("[PASS] Real Chromium/Edge CDP browser lifecycle (@eN refs, click, type, eval, console, screenshot, cookies, HAR 1.2, stealth)");
    } finally {
      await executeTool("browser_close", {}, { workingDirectory: tmpWorkDir });
      await new Promise((r) => setTimeout(r, 150));
      await new Promise((r) => server.close(r));
      fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  }

  assert.strictEqual(stripBrowserEmojis("\uD83D\uDE80 Wide \u2B50 Dashboard"), "Wide Dashboard");
  const emojiParsed = ctrl.parseHtml("<title>\uD83D\uDE80 Launch Portal \u2728</title><h1>Hi</h1>");
  assert.strictEqual(emojiParsed.title, "Launch Portal");
  console.log("[PASS] Emoji stripping in CLI browser titles");

  process.env.WIDE_CLI_BROWSER_HTTP_ONLY = "1";
  try {
    const harServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "secret_session=xyz" });
      res.end("<html><head><title>\uD83D\uDE80 HAR Title</title></head><body>ok</body></html>");
    });
    await new Promise((resolvePromise) => harServer.listen(0, "127.0.0.1", resolvePromise));
    try {
      const addr = harServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const httpCtrl = new HeadlessBrowserController();
      await httpCtrl.open(`http://127.0.0.1:${port}/?token=demo`, { stealth: true });
      const snapTxt = await httpCtrl.snapshot();
      assert.ok(snapTxt.includes("Page Title: HAR Title"));
      const har = httpCtrl.exportHar();
      assert.strictEqual(har.log.version, "1.2");
      assert.strictEqual(har.log.entries.length, 1);
      const setCookieHdr = har.log.entries[0].response.headers.find((h) => h.name.toLowerCase() === "set-cookie");
      assert.strictEqual(setCookieHdr?.value, "[REDACTED]");
      httpCtrl.close();
      console.log("[PASS] HTTP fallback HAR 1.2 export with header redaction");
    } finally {
      await new Promise((r) => harServer.close(r));
    }
  } finally {
    delete process.env.WIDE_CLI_BROWSER_HTTP_ONLY;
  }

  console.log("All Browser tests passed successfully.\n");
}

await runBrowserTests();
