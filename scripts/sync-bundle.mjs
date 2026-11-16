import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(currentDir, "..");
const rulesDistDir = process.env.WIDE_RULES_DIST_DIR
  ? resolve(rootDir, process.env.WIDE_RULES_DIST_DIR)
  : resolve(rootDir, "../wide-rules/dist");
const rulesSrc = resolve(rulesDistDir, "rules.min.json");
const osvSrc = resolve(rulesDistDir, "osv-bundle.min.json");
const outDir = resolve(rootDir, "data");

if (!existsSync(rulesSrc) || !existsSync(osvSrc)) {
  console.error(`Missing rules.min.json or osv-bundle.min.json in ${rulesDistDir}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(rulesSrc, resolve(outDir, "rules.json"));
copyFileSync(osvSrc, resolve(outDir, "osv-bundle.json"));
console.log("Synced wide-rules offline bundle into data/rules.json and data/osv-bundle.json");
