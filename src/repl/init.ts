import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface InitWorkspaceResult {
  created: string[];
  skipped: string[];
  detectedStack: string[];
}

export function detectWorkspaceStack(cwd: string): string[] {
  const stack: string[] = [];
  if (existsSync(join(cwd, "package.json"))) stack.push("node");
  if (existsSync(join(cwd, "tsconfig.json"))) stack.push("typescript");
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "requirements.txt"))) stack.push("python");
  if (existsSync(join(cwd, "Cargo.toml"))) stack.push("rust");
  if (existsSync(join(cwd, "go.mod"))) stack.push("go");
  if (existsSync(join(cwd, "Dockerfile"))) stack.push("docker");
  return stack;
}

export function initWideWorkspace(cwd: string): InitWorkspaceResult {
  const stack = detectWorkspaceStack(cwd);
  const created: string[] = [];
  const skipped: string[] = [];

  const wideDir = join(cwd, ".wide");
  if (!existsSync(wideDir)) {
    mkdirSync(wideDir, { recursive: true });
  }

  const rulesPath = join(wideDir, "rules");
  if (!existsSync(rulesPath)) {
    const lines = [
      "Prefer minimal, clean, production-grade diffs and verify changes with project tests.",
      "Never commit raw secrets, tokens, or credentials.",
    ];
    if (stack.includes("typescript")) lines.push("Run TypeScript typechecks before finishing edits.");
    if (stack.includes("python")) lines.push("Run Python unit tests before finishing edits.");
    if (stack.includes("rust")) lines.push("Verify cargo check/test passes after Rust edits.");
    writeFileSync(rulesPath, `${lines.join("\n")}\n`, "utf8");
    created.push(".wide/rules");
  } else {
    skipped.push(".wide/rules");
  }

  const settingsPath = join(wideDir, "settings.json");
  if (!existsSync(settingsPath)) {
    const allow: string[] = ["command(git status)", "command(git diff)"];
    if (stack.includes("node")) allow.push("command(npm test)", "command(npm run build)");
    if (stack.includes("python")) allow.push("command(pytest)", "command(python -m unittest)");
    if (stack.includes("rust")) allow.push("command(cargo test)", "command(cargo check)");
    const settings = {
      permissions: {
        allow,
        ask: ["command(*)"],
        deny: ["command(rm -rf)", "write_file(.git/)"],
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    created.push(".wide/settings.json");
  } else {
    skipped.push(".wide/settings.json");
  }

  const ignorePath = join(cwd, ".wideignore");
  if (!existsSync(ignorePath)) {
    const ignores = ["node_modules/", "dist/", "build/", "coverage/", ".git/", "target/", "__pycache__/", "*.min.js"];
    writeFileSync(ignorePath, `${ignores.join("\n")}\n`, "utf8");
    created.push(".wideignore");
  } else {
    skipped.push(".wideignore");
  }

  return { created, skipped, detectedStack: stack };
}
