import assert from "node:assert";
import { HeadlessBrowserController, browserTypeTool, browserExtractTool, browserScreenshotTool, browserCloseTool } from "../dist/tools/browser.js";
import { executeTool } from "../dist/tools/index.js";

async function runBrowserTests() {
  console.log("Testing Wide CLI Headless Browser...");

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

  const roles = parsed.elements.map(e => e.role);
  assert.ok(roles.includes("input[text]"));
  assert.ok(roles.includes("button"));
  assert.ok(roles.includes("link"));
  console.log("[PASS] Headless HTML and DOM element parser");

  const fillRes = await ctrl.fill("user", "admin_sec");
  assert.ok(fillRes.includes("Filled"));
  console.log("[PASS] Form input filling");

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
  console.log("[PASS] Headless viewport snapshot");

  const toolTypeRes = await executeTool("browser_type", { target: "user", text: "sl4de" }, { workingDirectory: process.cwd() });
  assert.strictEqual(toolTypeRes.success, true);
  console.log("[PASS] browser_type tool execution");

  const toolShotRes = await executeTool("browser_screenshot", {}, { workingDirectory: process.cwd() });
  assert.strictEqual(toolShotRes.success, true);
  console.log("[PASS] browser_screenshot tool execution");

  const toolCloseRes = await executeTool("browser_close", {}, { workingDirectory: process.cwd() });
  assert.strictEqual(toolCloseRes.success, true);
  console.log("[PASS] browser_close tool execution");

  console.log("All Headless Browser tests passed successfully.\n");
}

await runBrowserTests();
