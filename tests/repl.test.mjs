import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent/index.js";
import { coerceConfigValue } from "../dist/config/index.js";
import { expandAtFileMentions } from "../dist/repl/mentions.js";
import { executeTool } from "../dist/tools/index.js";
import { assessShellRisk } from "../dist/tools/risk.js";
import { runShellProcess } from "../dist/tools/shell.js";

async function runLiveSubprocessReplTest(tempHome, tempWs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "bin", "wide.js")], {
      cwd: tempWs,
      env: {
        ...process.env,
        USERPROFILE: tempHome,
        HOME: tempHome,
        GEMINI_API_KEY: "",
        WIDE_GEMINI_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let step = 0;

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      reject(new Error(`REPL subprocess timed out at step ${step}.\nStdout:\n${stdout}\nStderr:\n${stderr}`));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (step === 0 && stdout.includes("unconfigured")) {
        step = 1;
        child.stdin.write("/help\n");
      } else if (step === 1 && stdout.includes("Slash Commands:")) {
        step = 2;
        child.stdin.write("!echo WIDE_REPL_ALIVE\n");
      } else if (step === 2 && stdout.includes("WIDE_REPL_ALIVE")) {
        step = 3;
        child.stdin.write("/status\n");
      } else if (step === 3 && stdout.includes("Session ID:")) {
        step = 4;
        child.stdin.write("exit\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
      try {
        assert.strictEqual(code, 0, `Expected clean exit 0, got ${code}. Stdout:\n${plain}\nStderr:\n${stderr}`);
        assert.ok(plain.includes("Wide v"), "Missing banner output");
        assert.ok(plain.includes("Slash Commands:"), "Missing /help output");
        assert.ok(plain.includes("WIDE_REPL_ALIVE"), "Missing direct !shell output");
        assert.ok(plain.includes("Session ID:"), "Missing /status output");
        assert.ok(plain.includes("Goodbye!"), "Missing clean Goodbye output");
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function testReplAndSafety() {
  console.log("Testing Wide CLI Interactive REPL & Safety...");

  const tempHome = mkdtempSync(join(tmpdir(), "wide-cli-home-"));
  const tempWs = mkdtempSync(join(tmpdir(), "wide-cli-ws-"));

  try {
    const lazyAgent = new Agent(tempWs, null);
    assert.strictEqual(lazyAgent.hasProvider(), false);
    assert.ok(lazyAgent.getAgentRules().length > 0);
    console.log("[PASS] Lazy Agent starts without throwing when provider is unconfigured");

    assert.strictEqual(coerceConfigValue("autoApproveWrite", "true"), true);
    assert.strictEqual(coerceConfigValue("autoApproveRun", "false"), false);
    assert.strictEqual(coerceConfigValue("maxIterations", "12"), 12);
    console.log("[PASS] Config value coercion handles booleans and numbers");

    assert.strictEqual(assessShellRisk("git status").destructive, false);
    assert.strictEqual(assessShellRisk("rm -rf /tmp/foo").destructive, true);
    assert.strictEqual(assessShellRisk("git push --force origin main").destructive, true);
    assert.strictEqual(assessShellRisk("reg delete HKLM\\Software\\Test").destructive, true);
    console.log("[PASS] Shell risk classifier flags destructive commands");

    const sampleFile = join(tempWs, "sample.ts");
    writeFileSync(sampleFile, "export const x = 1;\n", "utf8");
    const mention = expandAtFileMentions("Review @sample.ts please", tempWs);
    assert.deepStrictEqual(mention.attachedFiles, ["sample.ts"]);
    assert.ok(mention.prompt.includes('<attached_file path="sample.ts">'));
    console.log("[PASS] @file mention context expansion");

    const writeRes = await executeTool("write_file", { path: "note.txt", content: "hello" }, {
      workingDirectory: tempWs,
      autoApproveWrite: true,
    });
    assert.strictEqual(writeRes.success, true);
    assert.strictEqual(readFileSync(join(tempWs, "note.txt"), "utf8"), "hello");

    const blockedEdit = await executeTool("edit_file", { path: "note.txt", target: "hello", replacement: "bye" }, {
      workingDirectory: tempWs,
      autoApproveWrite: false,
      requestApproval: async () => "deny",
    });
    assert.strictEqual(blockedEdit.success, false);
    assert.strictEqual(readFileSync(join(tempWs, "note.txt"), "utf8"), "hello");
    console.log("[PASS] File edits auto-apply by default and honor explicit approval gate when disabled");

    const runDenied = await executeTool("run_command", { command: "echo nope" }, {
      workingDirectory: tempWs,
      autoApproveRun: false,
      requestApproval: async () => "deny",
    });
    assert.strictEqual(runDenied.success, false);
    assert.ok((runDenied.error || "").includes("declined"));

    const sessionApproved = new Set();
    const runAlways = await executeTool("run_command", { command: "echo WIDE_CMD_OK" }, {
      workingDirectory: tempWs,
      autoApproveRun: false,
      sessionApprovedTools: sessionApproved,
      requestApproval: async () => "always",
    });
    assert.strictEqual(runAlways.success, true);
    assert.ok(runAlways.output.includes("WIDE_CMD_OK"));
    assert.ok(sessionApproved.has("run_command"));

    let destructiveAsked = false;
    const destructiveBlocked = await executeTool("run_command", { command: "rm -rf C:\\Windows" }, {
      workingDirectory: tempWs,
      autoApproveRun: false,
      sessionApprovedTools: sessionApproved,
      requestApproval: async (req) => {
        destructiveAsked = Boolean(req.destructive);
        return "deny";
      },
    });
    assert.strictEqual(destructiveAsked, true);
    assert.strictEqual(destructiveBlocked.success, false);
    console.log("[PASS] Shell execution respects approval policy and forces confirmation on destructive commands");

    const promptWaitScript = `"${process.execPath}" -e "process.stdout.write('Proceed [y/N]: '); setTimeout(() => {}, 15000);"`;
    const stalledRes = await runShellProcess(promptWaitScript, tempWs, { timeoutMs: 20000 });
    assert.strictEqual(stalledRes.exitCode, 124);
    assert.ok(stalledRes.output.includes("interactive prompt idle wait"));
    console.log("[PASS] Interactive prompt stall detection terminates cleanly (exit 124)");

    await runLiveSubprocessReplTest(tempHome, tempWs);
    assert.ok(existsSync(join(tempHome, ".wide", "cli-history")), "Expected CLI history file saved");
    console.log("[PASS] Live persistent REPL subprocess stays alive across commands and exits cleanly");
  } finally {
    try {
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(tempWs, { recursive: true, force: true });
    } catch {
    }
  }
}

await testReplAndSafety();
