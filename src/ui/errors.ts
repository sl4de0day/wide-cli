import { renderBox, termWidth } from "./ansi.js";
import { glyphs, theme } from "./theme.js";

export interface ErrorGuidance {
  title: string;
  detail: string;
  hint?: string;
}

export function classifyError(err: unknown): ErrorGuidance {
  const msg = err instanceof Error ? err.message : String(err || "Unknown error");
  const lower = msg.toLowerCase();

  if (lower.includes("api key") || lower.includes("no ai model provider is configured")) {
    return {
      title: "Provider authentication required",
      detail: msg,
      hint: "Run /setup (or wide config set-key <provider> <key>) to configure credentials.",
    };
  }
  if (lower.includes("antigravity") && (lower.includes("not found") || lower.includes("sign in") || lower.includes("auth"))) {
    return {
      title: "Antigravity CLI unavailable",
      detail: msg,
      hint: "Install/sign in via `agy` in your terminal, then check `wide doctor` or switch via /provider.",
    };
  }
  if (lower.includes("claude") && (lower.includes("not found") || lower.includes("login") || lower.includes("auth"))) {
    return {
      title: "Claude Code authentication required",
      detail: msg,
      hint: "Run `claude auth login` in your terminal, or switch providers via /provider.",
    };
  }
  if (lower.includes("ollama") || lower.includes("11434") || lower.includes("econnrefused")) {
    return {
      title: "Local model endpoint unreachable",
      detail: msg,
      hint: "Start Ollama (`ollama serve`) or switch to a cloud/CLI provider via /provider.",
    };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
    return {
      title: "Provider rate limit reached",
      detail: msg,
      hint: "Wait briefly and retry, or switch models with /model.",
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return {
      title: "Operation timed out",
      detail: msg,
      hint: "Retry the request or check network/provider status with /doctor.",
    };
  }

  return {
    title: "Error",
    detail: msg,
  };
}

export function formatErrorCard(err: unknown, maxWidth?: number): string {
  const guidance = classifyError(err);
  const w = Math.min(maxWidth ?? termWidth(80) - 2, 92);
  const lines: string[] = [
    `${theme.errorBold(glyphs.cross)} ${theme.fgBold(guidance.title)}`,
    theme.fg(guidance.detail),
  ];
  if (guidance.hint) {
    lines.push(`${theme.info("Next:")} ${theme.muted(guidance.hint)}`);
  }
  const box = renderBox(lines, {
    width: Math.max(36, w),
    borderStyle: (s) => theme.error(s),
    paddingX: 1,
  });
  return box.map((l) => `  ${l}`).join("\n");
}
