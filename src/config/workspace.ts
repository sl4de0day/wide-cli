import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceConfig {
  rules: string[];
  ignoredPatterns: string[];
  isWideRepo: boolean;
}

export function loadWorkspaceConfig(dir = process.cwd()): WorkspaceConfig {
  const rulesPath = join(dir, ".wide", "rules");
  const ignorePath = join(dir, ".wideignore");
  const repoMarker = join(dir, ".widerepo");

  const rules: string[] = [];
  const ignoredPatterns: string[] = [];

  if (existsSync(rulesPath)) {
    try {
      const content = readFileSync(rulesPath, "utf8");
      rules.push(...content.split("\n").map(l => l.trim()).filter(Boolean));
    } catch {
    }
  }

  if (existsSync(ignorePath)) {
    try {
      const content = readFileSync(ignorePath, "utf8");
      ignoredPatterns.push(...content.split("\n").map(l => l.trim()).filter(Boolean));
    } catch {
    }
  }

  return {
    rules,
    ignoredPatterns,
    isWideRepo: existsSync(repoMarker)
  };
}
