import { spawn, spawnSync } from "node:child_process";
import { theme } from "../ui/theme.js";
import { assessShellRisk } from "./risk.js";
import { normalizeApprovalOutcome, type Tool, type ToolExecutionContext, type ToolResult } from "./types.js";

const INTERACTIVE_PROMPT_TAIL = /(confirm|continue|proceed|overwrite|password|passphrase|enter\s+.*:|\[[yn]\/[yn]\]|\(yes\/no\)|:\s*$|\?\s*$)/i;

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    } catch {
    }
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
}

export async function runShellProcess(
  command: string,
  workingDirectory: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    streamToStdout?: boolean;
    onOutputLine?: (line: string, stream: "stdout" | "stderr") => void;
  } = {}
): Promise<ToolResult & { exitCode: number }> {
  const timeoutMs = Math.max(500, options.timeoutMs || 30000);
  if (options.signal?.aborted) {
    return { success: false, output: "", error: "Command aborted.", exitCode: 130 };
  }

  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd: workingDirectory,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      child.stdin?.end();
    } catch {
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let interactiveStall = false;
    let aborted = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onAbort);

      let out = stdout;
      let err = stderr;
      if (out.length > 8000) out = out.slice(0, 8000) + "\n... [Output truncated]";
      if (err.length > 4000) err = err.slice(0, 4000) + "\n... [Stderr truncated]";

      const finalCode = aborted ? 130 : (interactiveStall || timedOut ? 124 : code);
      const statusNote = aborted
        ? "Command aborted by user (Ctrl+C)."
        : interactiveStall
          ? "Command aborted after interactive prompt idle wait (non-interactive shell)."
          : timedOut
            ? `Command timed out after ${timeoutMs}ms.`
            : "";

      const parts = [
        out ? `Stdout:\n${out.trimEnd()}` : "",
        err ? `Stderr:\n${err.trimEnd()}` : "",
        statusNote,
        `Exit Code: ${finalCode}`,
      ].filter(Boolean);

      resolvePromise({
        success: finalCode === 0,
        output: parts.join("\n\n"),
        error: finalCode === 0 ? undefined : statusNote || `Command exited with code ${finalCode}`,
        exitCode: finalCode,
      });
    };

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const tail = (stdout + "\n" + stderr).slice(-300).trimEnd();
        if (tail && INTERACTIVE_PROMPT_TAIL.test(tail)) {
          interactiveStall = true;
          terminateProcessTree(child.pid);
          finish(124);
        }
      }, 5000);
      idleTimer.unref?.();
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
      finish(124);
    }, timeoutMs);
    hardTimer.unref?.();

    const onAbort = () => {
      aborted = true;
      terminateProcessTree(child.pid);
      finish(130);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let stdoutLineBuf = "";
    let stderrLineBuf = "";
    const emitLines = (chunk: string, kind: "stdout" | "stderr") => {
      if (!options.onOutputLine) return;
      const combined = (kind === "stdout" ? stdoutLineBuf : stderrLineBuf) + chunk;
      const parts = combined.split(/\r?\n/);
      const rest = parts.pop() ?? "";
      if (kind === "stdout") stdoutLineBuf = rest;
      else stderrLineBuf = rest;
      for (const line of parts) {
        if (line.trim()) options.onOutputLine(line, kind);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdout.length < 32768) stdout += text;
      if (options.streamToStdout) process.stdout.write(text);
      emitLines(text, "stdout");
      resetIdleCheck();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderr.length < 16384) stderr += text;
      if (options.streamToStdout) process.stderr.write(text);
      emitLines(text, "stderr");
      resetIdleCheck();
    });

    child.on("error", (err) => {
      stderr += err.message;
      finish(1);
    });

    child.on("close", (code) => {
      finish(typeof code === "number" ? code : 0);
    });
  });
}

export const runCommandTool: Tool = {
  definition: {
    name: "run_command",
    description: "Execute a shell command in the project directory and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command line to execute." },
        timeoutMs: { type: "number", description: "Optional timeout in milliseconds (default: 30000)." }
      },
      required: ["command"]
    }
  },
  async execute(params, context): Promise<ToolResult> {
    const cmd = String(params.command || "").trim();
    if (!cmd) {
      return { success: false, output: "", error: "run_command requires a non-empty command." };
    }

    if (context.permissionProfile === "plan") {
      return {
        success: false,
        output: "",
        error: "Blocked in Plan mode (read-only). Switch mode with Shift+Tab to execute shell commands.",
      };
    }

    const risk = assessShellRisk(cmd);
    const ruleDecision = context.evaluatePermission?.("command", cmd) ?? null;
    if (ruleDecision === "deny") {
      return {
        success: false,
        output: "",
        error: `Command blocked by permission deny rule: ${cmd}`,
      };
    }
    const sessionAutoAllowed = !risk.destructive && (
      context.sessionApprovedTools?.has("run_command") ||
      ruleDecision === "allow" ||
      context.permissionProfile === "auto"
    );
    const needsApproval = risk.destructive
      ? true
      : ruleDecision === "ask"
        ? true
        : !context.autoApproveRun && !sessionAutoAllowed;

    if (needsApproval) {
      if (!context.requestApproval) {
        return {
          success: false,
          output: "",
          error: risk.destructive
            ? `Blocked destructive command (${risk.reason}). Interactive approval required.`
            : "Command rejected: run_command requires approval (run interactively or pass --yes)."
        };
      }
      const firstToken = cmd.split(/\s+/)[0] || cmd;
      const rawOutcome = await context.requestApproval({
        tool: "run_command",
        title: risk.destructive ? `Destructive command blocked for confirmation (${risk.reason})` : "Allow shell command execution?",
        detail: cmd,
        preview: `${theme.faint("$")} ${theme.fgBold(cmd)}`,
        destructive: risk.destructive,
        sessionKey: risk.destructive ? undefined : "run_command",
        suggestedPattern: risk.destructive ? undefined : `command(${firstToken})`,
      });
      const outcome = normalizeApprovalOutcome(rawOutcome);
      if (outcome.decision === "deny") {
        const fb = outcome.feedback ? ` User guidance: ${outcome.feedback}` : "";
        return { success: false, output: "", error: `Command execution declined by user.${fb}` };
      }
      if (outcome.decision === "always" && !risk.destructive) {
        context.sessionApprovedTools?.add("run_command");
      }
    }

    return runShellProcess(cmd, context.workingDirectory, {
      timeoutMs: params.timeoutMs || 30000,
      signal: context.signal,
      onOutputLine: context.onOutputLine,
    });
  }
};
