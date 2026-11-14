import assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { HeadlessBrowserController } from "../dist/tools/browser.js";
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

      console.log("[PASS] Real Chromium/Edge CDP browser lifecycle (@eN refs, click, type, eval, console, screenshot, cookies)");
    } finally {
      await executeTool("browser_close", {}, { workingDirectory: tmpWorkDir });
      await new Promise((r) => setTimeout(r, 150));
      await new Promise((r) => server.close(r));
      fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  }

  console.log("All Browser tests passed successfully.\n");
}

await runBrowserTests();
