import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, buildAgentSystemPrompt } from "../dist/agent/index.js";
import { executeTool, getToolDefinitions, validateToolCallArgs } from "../dist/tools/index.js";

async function runTrustTests() {
  console.log("Testing Wide CLI Mode Scoping, Strict Validation & Post-Edit Verification...");

  const codeNoBrowser = getToolDefinitions({ toolMode: "code", allowBrowser: false }).map((d) => d.name);
  assert.ok(codeNoBrowser.includes("write_file") && codeNoBrowser.includes("git_inspection"));
  assert.ok(!codeNoBrowser.includes("fuzz_endpoint") && !codeNoBrowser.includes("run_security_scan"));
  assert.ok(!codeNoBrowser.includes("browser_navigate"));

  const codeWithBrowser = getToolDefinitions({ toolMode: "code", allowBrowser: true }).map((d) => d.name);
  assert.ok(codeWithBrowser.includes("browser_navigate") && !codeWithBrowser.includes("fuzz_endpoint"));

  const secNoBrowser = getToolDefinitions({ toolMode: "security", allowBrowser: false }).map((d) => d.name);
  assert.ok(secNoBrowser.includes("fuzz_endpoint") && secNoBrowser.includes("read_file"));
  assert.ok(!secNoBrowser.includes("write_file") && !secNoBrowser.includes("edit_file") && !secNoBrowser.includes("browser_open"));

  const fullAll = getToolDefinitions({ toolMode: "full", allowBrowser: true }).map((d) => d.name);
  assert.ok(fullAll.includes("write_file") && fullAll.includes("fuzz_endpoint") && fullAll.includes("browser_open"));
  console.log("[PASS] Mode scoping (full/code/security) and independent Browser toggle filter tools accurately");

  const aliasRejected = validateToolCallArgs("browser_fill", { target: "@e1", text: "x" });
  assert.strictEqual(aliasRejected.ok, false);
  if (!aliasRejected.ok) assert.ok(aliasRejected.error.startsWith("UNKNOWN_TOOL"));

  const unknownParamRejected = validateToolCallArgs("write_file", { file_path: "a.js", content: "x" });
  assert.strictEqual(unknownParamRejected.ok, false);
  if (!unknownParamRejected.ok) assert.ok(unknownParamRejected.error.startsWith("SCHEMA_VALIDATION_ERROR"));

  const modeBlocked = await executeTool("fuzz_endpoint", { url: "https://example.com", param: "q", payloadType: "xss" }, {
    workingDirectory: process.cwd(),
    toolMode: "code",
    allowBrowser: true,
  });
  assert.strictEqual(modeBlocked.success, false);
  assert.ok(modeBlocked.error?.startsWith("TOOL_DISABLED_IN_MODE"));

  const browserBlocked = await executeTool("browser_open", { url: "https://example.com" }, {
    workingDirectory: process.cwd(),
    toolMode: "full",
    allowBrowser: false,
  });
  assert.strictEqual(browserBlocked.success, false);
  assert.ok(browserBlocked.error?.startsWith("TOOL_DISABLED_IN_MODE"));
  console.log("[PASS] Strict schema validation rejects aliases, unknown params, and disabled-mode calls");

  const tmpWs = mkdtempSync(join(tmpdir(), "wide-cli-verify-"));
  try {
    const badJs = await executeTool("write_file", { path: "app.js", content: "const broken = ;\n" }, {
      workingDirectory: tmpWs,
      toolMode: "code",
      allowBrowser: false,
      autoApproveWrite: true,
    });
    assert.strictEqual(badJs.success, true);
    assert.ok(badJs.output.includes("AUTO-VERIFICATION FAILED"));

    const fixedJs = await executeTool("edit_file", { path: "app.js", target: "const broken = ;", replacement: "const fixed = 42;" }, {
      workingDirectory: tmpWs,
      toolMode: "code",
      allowBrowser: false,
      autoApproveWrite: true,
    });
    assert.strictEqual(fixedJs.success, true);
    assert.ok(fixedJs.output.includes("JavaScript syntax check passed (0 errors)"));

    const badJson = await executeTool("write_file", { path: "cfg.json", content: "{ invalid" }, {
      workingDirectory: tmpWs,
      toolMode: "code",
      allowBrowser: false,
      autoApproveWrite: true,
    });
    assert.strictEqual(badJson.success, true);
    assert.ok(badJson.output.includes("AUTO-VERIFICATION FAILED: Invalid JSON"));
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
  console.log("[PASS] Post-edit verification checks JS and JSON edits immediately");

  const agent = new Agent(process.cwd(), null, { toolMode: "code", allowBrowser: false });
  const initSys = String(agent.getMessages()[0]?.content || "");
  assert.ok(initSys.includes("Active Mode: CODE | Browser Tools: OFF"));
  assert.ok(!initSys.includes("fuzz_endpoint") && !initSys.includes("browser_navigate"));
  agent.setToolMode("security");
  agent.setAllowBrowser(true);
  const updatedSys = String(agent.getMessages()[0]?.content || "");
  assert.ok(updatedSys.includes("Active Mode: SECURITY | Browser Tools: ON"));
  assert.ok(buildAgentSystemPrompt(undefined, { toolMode: "full", allowBrowser: false }).includes("Browser Tools: OFF"));

  const cliBin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const helpOut = execFileSync(process.execPath, [cliBin, "--help"], { encoding: "utf8" });
  assert.ok(helpOut.includes("--mode") && helpOut.includes("--no-browser"));
  let badModeFailed = false;
  try {
    execFileSync(process.execPath, [cliBin, "--mode", "bogus", "-p", "hi"], { encoding: "utf8", stdio: "pipe" });
  } catch {
    badModeFailed = true;
  }
  assert.strictEqual(badModeFailed, true);
  console.log("[PASS] Agent prompt scoping and CLI --mode / --no-browser flags work cleanly");

  const {
    ClaudeCodeProvider,
    ClaudeStreamAccumulator,
    filterCliToolsForClaudeMcp,
    parseClaudeAuthJson,
  } = await import("../dist/providers/claude-code.js");

  const fullTools = getToolDefinitions({ toolMode: "full", allowBrowser: true });
  const mcpTools = filterCliToolsForClaudeMcp(fullTools);
  assert.ok(!mcpTools.some((t) => t.name === "read_file" || t.name === "write_file" || t.name === "run_command"));
  assert.ok(mcpTools.some((t) => t.name === "run_security_scan"));

  const authJson = parseClaudeAuthJson('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"cli@wide.dev"}');
  assert.strictEqual(authJson?.loggedIn, true);
  assert.strictEqual(authJson?.subscriptionType, "pro");

  const acc = new ClaudeStreamAccumulator();
  const streamed = [];
  acc.feedLine(JSON.stringify({ type: "stream_event", event: { type: "message_start" } }), (c) => streamed.push(c));
  acc.feedLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } }), (c) => streamed.push(c));
  acc.feedLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi!" }] } }), (c) => streamed.push(c));
  const fin = acc.feedLine(JSON.stringify({ type: "result", is_error: true, result: "No conversation found with session ID" }), () => {});
  assert.strictEqual(streamed.join(""), "Hi!");
  assert.strictEqual(fin.done, true);
  assert.strictEqual(fin.sessionNotFound, true);

  const tmpCc = mkdtempSync(join(tmpdir(), "wide-cli-cc-"));
  const prevCc = process.env.WIDE_CLAUDE_PATH;
  const ccProvider = new ClaudeCodeProvider("sonnet");
  try {
    const mockCli = join(tmpCc, "mock-claude.js");
    const mockBody = [ // wide-ignore wide/secret-assignment
      "const readline = require('node:readline');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'auth') {",
      "  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n');", // wide-ignore wide/secret-assignment
      "  process.exit(0);",
      "}",
      "let n = 0;",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  n += 1;",
      "  const m = JSON.parse(line);",
      "  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: process.pid + ':' + m.message.content } } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: 'cli-sess-1' }) + '\\n');",
      "});",
    ].join("\n");
    writeFileSync(mockCli, mockBody, "utf8");
    process.env.WIDE_CLAUDE_PATH = mockCli;

    const c1 = [];
    const r1 = await ccProvider.chatStream(
      [{ role: "system", content: "Be concise" }, { role: "user", content: "first" }],
      fullTools,
      (c) => c1.push(c),
    );
    const c2 = [];
    const r2 = await ccProvider.chatStream(
      [{ role: "system", content: "Be concise" }, { role: "user", content: "first" }, { role: "assistant", content: r1.content }, { role: "user", content: "second" }],
      fullTools,
      (c) => c2.push(c),
    );
    const pid1 = r1.content.split(":")[0];
    const pid2 = r2.content.split(":")[0];
    assert.ok(pid1.length > 0 && pid1 === pid2);
    assert.ok(c1.join("").endsWith(":first"));
    assert.ok(c2.join("").endsWith(":second"));
    assert.ok(helpOut.includes("claude-code"));
    console.log("[PASS] ClaudeCodeProvider reuses warm stream-json worker and streams cleanly");
  } finally {
    ccProvider.dispose();
    if (prevCc === undefined) delete process.env.WIDE_CLAUDE_PATH;
    else process.env.WIDE_CLAUDE_PATH = prevCc;
    rmSync(tmpCc, { recursive: true, force: true });
  }

  const {
    AntigravityProvider,
    AntigravityStreamAccumulator,
    buildAntigravityCliArgs,
  } = await import("../dist/providers/antigravity.js");

  const agyPlanArgs = buildAntigravityCliArgs({
    conversationId: "conv-1",
    model: "gemini-4-neon-xhigh",
    allowWrites: false,
  });
  assert.ok(agyPlanArgs.includes("--conversation") && agyPlanArgs.includes("conv-1"));
  assert.ok(agyPlanArgs.includes("--effort") && agyPlanArgs.includes("xhigh"));
  assert.ok(agyPlanArgs.includes("--mode") && agyPlanArgs.includes("plan") && agyPlanArgs.includes("--print="));
  assert.ok(!agyPlanArgs.includes("--dangerously-skip-permissions"));

  const agyAgentArgs = buildAntigravityCliArgs({ model: "default", allowWrites: true });
  assert.ok(agyAgentArgs.includes("accept-edits") && agyAgentArgs.includes("--dangerously-skip-permissions"));
  assert.ok(!agyAgentArgs.includes("--model"));

  const agyAcc = new AntigravityStreamAccumulator();
  const agyStreamed = [];
  agyAcc.feedLine(JSON.stringify({ event: "init", conversation_id: "agy-cli-1" }), (c) => agyStreamed.push(c));
  agyAcc.feedLine(
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "agy-cli-1", step_type: "agent_response", text_delta: "Hello " },
    }),
    (c) => agyStreamed.push(c),
  );
  const agyFin = agyAcc.feedLine(
    JSON.stringify({
      event: "result",
      result: { conversation_id: "agy-cli-1", status: "ERROR", error: "Conversation not found" },
    }),
    () => {},
  );
  assert.strictEqual(agyStreamed.join(""), "Hello ");
  assert.strictEqual(agyAcc.conversationId, "agy-cli-1");
  assert.strictEqual(agyFin.done, true);
  assert.strictEqual(agyFin.sessionNotFound, true);

  const tmpAgy = mkdtempSync(join(tmpdir(), "wide-cli-agy-"));
  const prevAgy = process.env.WIDE_AGY_PATH;
  const agyProvider = new AntigravityProvider("gemini-4-neon-high");
  try {
    const mockAgyCli = join(tmpAgy, "mock-agy.js");
    const mockAgyBody = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const m = JSON.parse(line);",
      "  const text = m.message.content;",
      "  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'agy-sess-1' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-sess-1', step_type: 'agent_response', text_delta: process.pid + ':' + text } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-sess-1', status: 'SUCCESS', response: process.pid + ':' + text } }) + '\\n');",
      "});",
    ].join("\n");
    writeFileSync(mockAgyCli, mockAgyBody, "utf8");
    process.env.WIDE_AGY_PATH = mockAgyCli;

    const ac1 = [];
    const ar1 = await agyProvider.chatStream(
      [{ role: "system", content: "Be concise" }, { role: "user", content: "first" }],
      fullTools,
      (c) => ac1.push(c),
    );
    const ac2 = [];
    const ar2 = await agyProvider.chatStream(
      [
        { role: "system", content: "Be concise" },
        { role: "user", content: "first" },
        { role: "assistant", content: ar1.content },
        { role: "user", content: "second" },
      ],
      fullTools,
      (c) => ac2.push(c),
    );
    const apid1 = ar1.content.split(":")[0];
    const apid2 = ar2.content.split(":")[0];
    assert.ok(apid1.length > 0 && apid1 === apid2);
    assert.ok(ac1.join("").includes("Be concise") && ac1.join("").endsWith("first"));
    assert.ok(ac2.join("").endsWith(":second"));
    assert.ok(helpOut.includes("antigravity"));
    console.log("[PASS] AntigravityProvider reuses warm stream-json worker and streams cleanly");
  } finally {
    agyProvider.dispose();
    if (prevAgy === undefined) delete process.env.WIDE_AGY_PATH;
    else process.env.WIDE_AGY_PATH = prevAgy;
    rmSync(tmpAgy, { recursive: true, force: true });
  }

  const { CodexProvider, CodexStreamAccumulator, parseCodexModelAndEffort, sanitizeCodexEnv } = await import(
    "../dist/providers/codex.js"
  );
  const cleanCodexEnv = sanitizeCodexEnv({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-strip",
    CODEX_API_KEY: "ck-strip",
  });
  assert.equal(cleanCodexEnv.PATH, "/usr/bin");
  assert.equal("OPENAI_API_KEY" in cleanCodexEnv, false);
  assert.equal("CODEX_API_KEY" in cleanCodexEnv, false);
  assert.deepEqual(parseCodexModelAndEffort("gpt-6.2-sol-xhigh"), { model: "gpt-6.2-sol", effort: "xhigh" });

  const codexAcc = new CodexStreamAccumulator();
  const codexChunks = [];
  codexAcc.feedNotification("item/agentMessage/delta", { itemId: "a1", delta: "hel" }, (c) => codexChunks.push(c));
  codexAcc.feedNotification("item/agentMessage/delta", { itemId: "a1", delta: "lo" }, (c) => codexChunks.push(c));
  codexAcc.feedNotification("item/completed", { item: { type: "agentMessage", id: "a1", text: "hello" } }, (c) => codexChunks.push(c));
  const cOutcome = codexAcc.feedNotification("turn/completed", { turn: { status: "completed" } }, (c) => codexChunks.push(c));
  assert.equal(cOutcome.done, true);
  assert.equal(codexAcc.getFullText(), "hello");
  assert.deepEqual(codexChunks, ["hel", "lo"]);

  const tmpCodex = mkdtempSync(join(tmpdir(), "wide-cli-codex-"));
  const prevCodex = process.env.WIDE_CODEX_PATH;
  const prevCliOpenAi = process.env.OPENAI_API_KEY;
  const codexProvider = new CodexProvider("gpt-6.2-sol-ultra");
  try {
    const mockCodexCli = join(tmpCodex, "mock-codex.js");
    const mockCodexBody = [
      "const readline = require('node:readline');",
      "const sawApiKey = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);",
      "let activeSandbox = '';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const m = JSON.parse(line);",
      "  if (m.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: 'codex/0.170.0' } }) + '\\n');",
      "  } else if (m.method === 'account/read') {",
      "    process.stdout.write(JSON.stringify({ id: m.id, result: { account: sawApiKey ? { type: 'apiKey' } : { type: 'chatgpt', planType: 'pro' } } }) + '\\n');",
      "  } else if (m.method === 'thread/start') {",
      "    activeSandbox = m.params?.sandbox || '';",
      "    process.stdout.write(JSON.stringify({ id: m.id, result: { thread: { id: 'cli-codex-1' } } }) + '\\n');",
      "  } else if (m.method === 'turn/start') {",
      "    process.stdout.write(JSON.stringify({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } }) + '\\n');",
      "    const txt = String(m.params?.input?.[0]?.text || '');",
      "    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'x1', delta: process.pid + ':' + activeSandbox + ':' + (m.params?.effort || '') + ':' + txt } }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } }) + '\\n');",
      "  }",
      "});",
    ].join("\n");
    writeFileSync(mockCodexCli, mockCodexBody, "utf8");
    process.env.WIDE_CODEX_PATH = mockCodexCli;
    process.env.OPENAI_API_KEY = "sk-should-be-stripped";

    const cc1 = [];
    const cr1 = await codexProvider.chatStream(
      [{ role: "system", content: "Be concise" }, { role: "user", content: "first" }],
      fullTools,
      (c) => cc1.push(c),
    );
    const cc2 = [];
    const cr2 = await codexProvider.chatStream(
      [
        { role: "system", content: "Be concise" },
        { role: "user", content: "first" },
        { role: "assistant", content: cr1.content },
        { role: "user", content: "second" },
      ],
      fullTools,
      (c) => cc2.push(c),
    );
    const cp1 = cr1.content.split(":");
    const cp2 = cr2.content.split(":");
    assert.ok(cp1[0].length > 0 && cp1[0] === cp2[0]);
    assert.equal(cp1[1], "workspace-write");
    assert.equal(cp1[2], "ultra");
    assert.ok(cc1.join("").includes("Be concise") && cc1.join("").endsWith("first"));
    assert.ok(cc2.join("").endsWith(":second"));
    assert.ok(helpOut.includes("codex"));
    console.log("[PASS] CodexProvider strips OpenAI API keys, reuses warm app-server worker, and scopes sandbox cleanly");
  } finally {
    codexProvider.dispose();
    if (prevCodex === undefined) delete process.env.WIDE_CODEX_PATH;
    else process.env.WIDE_CODEX_PATH = prevCodex;
    if (prevCliOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevCliOpenAi;
    rmSync(tmpCodex, { recursive: true, force: true });
  }
}

await runTrustTests();
