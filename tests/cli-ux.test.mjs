import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateCompletionScript, installShellCompletion, normalizeShellName } from "../dist/completion.js";
import { formatColoredDiffPreview } from "../dist/ui/diff.js";
import { executeTool } from "../dist/tools/index.js";

async function runCliUxTests() {
  console.log("Testing Wide CLI Diff Preview & Shell Completion...");

  const oldText = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const newText = Array.from({ length: 10 }, (_, i) => (i === 4 ? "line 5 updated" : `line ${i + 1}`)).join("\n");
  const diffRes = formatColoredDiffPreview("sample.ts", oldText, newText, { forceColor: true });
  assert.strictEqual(diffRes.added, 1);
  assert.strictEqual(diffRes.removed, 1);
  assert.strictEqual(diffRes.hunks, 1);
  assert.strictEqual(diffRes.truncated, 0);
  assert.ok(diffRes.preview.includes("\x1b[38;2;163;190;140m"));
  assert.ok(diffRes.preview.includes("\x1b[38;2;191;97;106m"));
  assert.ok(diffRes.preview.includes("updated"));
  assert.ok(diffRes.preview.replace(/\x1b\[[0-9;]*m/g, "").includes("-line 5"));

  const hugeOld = Array.from({ length: 120 }, (_, i) => `row ${i}`).join("\n");
  const hugeNew = Array.from({ length: 120 }, (_, i) => `row ${i} changed`).join("\n");
  const bounded = formatColoredDiffPreview("huge.ts", hugeOld, hugeNew, { maxLines: 25 });
  assert.ok(bounded.truncated > 0);
  assert.ok(bounded.preview.includes("additional diff line(s) omitted"));
  console.log("[PASS] ANSI colored diff preview with hunk stats and line truncation");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wide-cli-ux-"));
  try {
    const targetFile = path.join(tmpDir, "app.ts");
    fs.writeFileSync(targetFile, "const port = 3000;\n", "utf8");

    let capturedPreview = "";
    let capturedTitle = "";
    const denied = await executeTool(
      "edit_file",
      { path: "app.ts", target: "const port = 3000;", replacement: "const port = 8080;" },
      {
        workingDirectory: tmpDir,
        autoApproveWrite: false,
        requestApproval: async (req) => {
          capturedPreview = req.preview || "";
          capturedTitle = req.title;
          return "deny";
        },
      }
    );
    assert.strictEqual(denied.success, false);
    assert.ok(capturedTitle.includes("(+1/-1)"));
    assert.ok(capturedPreview.includes("const port = 8080;"));
    assert.strictEqual(fs.readFileSync(targetFile, "utf8"), "const port = 3000;\n");

    const approved = await executeTool(
      "edit_file",
      { path: "app.ts", target: "const port = 3000;", replacement: "const port = 8080;" },
      {
        workingDirectory: tmpDir,
        autoApproveWrite: false,
        requestApproval: async () => "once",
      }
    );
    assert.strictEqual(approved.success, true);
    assert.strictEqual(fs.readFileSync(targetFile, "utf8"), "const port = 8080;\n");
    console.log("[PASS] Interactive write approval receives diff preview and respects deny/once");

    assert.strictEqual(normalizeShellName("pwsh"), "powershell");
    assert.strictEqual(normalizeShellName("bash"), "bash");
    assert.strictEqual(normalizeShellName("zsh"), "zsh");

    const psScript = generateCompletionScript("powershell");
    const bashScript = generateCompletionScript("bash");
    const zshScript = generateCompletionScript("zsh");
    assert.ok(psScript.includes("Register-ArgumentCompleter -Native -CommandName wide"));
    assert.ok(bashScript.includes("complete -F _wide_complete wide"));
    assert.ok(zshScript.includes("function _wide"));
    assert.ok(!psScript.includes("#") || psScript.includes("-s"));
    assert.ok(!bashScript.split(/\r?\n/).some((line) => line.trim().startsWith("#")));
    assert.ok(!zshScript.split(/\r?\n/).some((line) => line.trim().startsWith("#")));

    const fakeProfile = path.join(tmpDir, "profile.ps1");
    const firstInstall = installShellCompletion({ shell: "powershell", profilePath: fakeProfile });
    assert.strictEqual(firstInstall.updated, true);
    const secondInstall = installShellCompletion({ shell: "powershell", profilePath: fakeProfile });
    assert.strictEqual(secondInstall.updated, false);

    const cliBin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const cliOut = execFileSync(process.execPath, [cliBin, "completion", "--shell", "bash"], { encoding: "utf8" });
    assert.ok(cliOut.includes("complete -F _wide_complete wide"));
    console.log("[PASS] Shell completion script generation, idempotent install, and CLI execution");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("All CLI UX tests passed successfully.\n");
}

await runCliUxTests();
