import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type { Finding } from "./scanner.js";

export interface AdvisoryEntry {
  name: string;
  ge?: string;
  lt?: string;
  le?: string;
  id: string;
  ghsaId?: string;
  cve?: string;
  cwe?: string;
  sev: string;
  note?: string;
  kev?: boolean;
  epss?: number;
}

export interface ManifestDependency {
  ecosystem: string;
  name: string;
  version: string;
  line: number;
  snippet: string;
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "poetry.lock",
  "pipfile.lock",
  "go.mod",
  "cargo.toml",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "pom.xml"
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "vendor", ".next",
  "target", "coverage", ".venv", "venv", "__pycache__", ".gemini", ".vscode"
]);

function cleanVersionParts(raw: string): number[] {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^[vV^~=<>\s]+/, "")
    .split(/[-+\s]/)[0];
  if (!cleaned) return [];
  return cleaned.split(".").map((part) => {
    const m = /^(\d+)/.exec(part);
    return m ? parseInt(m[1], 10) : 0;
  });
}

export function compareVersions(a: string, b: string): number {
  const pa = cleanVersionParts(a);
  const pb = cleanVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export function isVersionAffected(version: string, adv: { ge?: string; lt?: string; le?: string }): boolean {
  if (!version || /^\*|latest|workspace:/i.test(version)) return false;
  if (!/^\d/.test(version.replace(/^[vV^~=<>]+/, ""))) return false;
  if (adv.ge && compareVersions(version, adv.ge) < 0) return false;
  if (adv.lt && compareVersions(version, adv.lt) >= 0) return false;
  if (adv.le && compareVersions(version, adv.le) > 0) return false;
  return Boolean(adv.lt || adv.le || adv.ge);
}

function findLineForToken(lines: string[], token: string): number {
  const lower = token.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lower)) return i + 1;
  }
  return 1;
}

export function parseManifestDependencies(filePath: string, content: string): ManifestDependency[] {
  const base = basename(filePath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const deps: ManifestDependency[] = [];
  const seen = new Set<string>();

  const pushDep = (ecosystem: string, name: string, rawVersion: string, line: number, snippet: string) => {
    const cleanVer = String(rawVersion || "").trim().replace(/^[~^>=<\s]+/, "").split(/\s+/)[0];
    if (!name || !cleanVer || /^\*|latest|workspace:|file:|git\+|https?:/i.test(cleanVer)) return;
    if (!/\d/.test(cleanVer)) return;
    const key = `${ecosystem}:${name.toLowerCase()}@${cleanVer}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    deps.push({ ecosystem, name, version: cleanVer, line, snippet: snippet.trim() });
  };

  if (base === "package.json") {
    try {
      const pkg = JSON.parse(content);
      const merged = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies);
      for (const [name, ver] of Object.entries(merged)) {
        if (typeof ver !== "string") continue;
        const ln = findLineForToken(lines, `"${name}"`);
        pushDep("npm", name, ver, ln, lines[ln - 1] || `"${name}": "${ver}"`);
      }
    } catch {}
    return deps;
  }

  if (base === "package-lock.json") {
    try {
      const lock = JSON.parse(content);
      if (lock.packages && typeof lock.packages === "object") {
        for (const [pkgPath, info] of Object.entries<any>(lock.packages)) {
          const pkgName = pkgPath.split("node_modules/").pop();
          if (pkgName && info && typeof info.version === "string") {
            const ln = findLineForToken(lines, `"${pkgPath}"`);
            pushDep("npm", pkgName, info.version, ln, lines[ln - 1] || `"${pkgPath}": "${info.version}"`);
          }
        }
      } else if (lock.dependencies && typeof lock.dependencies === "object") {
        for (const [pkgName, info] of Object.entries<any>(lock.dependencies)) {
          if (info && typeof info.version === "string") {
            const ln = findLineForToken(lines, `"${pkgName}"`);
            pushDep("npm", pkgName, info.version, ln, lines[ln - 1] || `"${pkgName}": "${info.version}"`);
          }
        }
      }
    } catch {}
    return deps;
  }

  if (base === "yarn.lock") {
    let currentPkgs: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^[^\s#"][^:\n]*:$/.test(t) || /^"[^"]+.*":$/.test(t)) {
        currentPkgs = t
          .replace(/:$/, "")
          .split(",")
          .map((spec) => {
            const cleaned = spec.trim().replace(/^["']|["']$/g, "");
            const atIdx = cleaned.lastIndexOf("@");
            return atIdx > 0 ? cleaned.slice(0, atIdx) : "";
          })
          .filter(Boolean);
        continue;
      }
      const vm = /^\s+version\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(lines[i]);
      if (vm && currentPkgs.length > 0) {
        const ver = vm[1] || vm[2] || vm[3];
        for (const name of currentPkgs) pushDep("npm", name, ver, i + 1, lines[i]);
        currentPkgs = [];
      }
    }
    return deps;
  }

  if (base === "pnpm-lock.yaml") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s{2,4}'?\/?(@?[^/\s':]+(?:\/[^@\s(':]+)?)[@/]([0-9][0-9A-Za-z.\-+]*)/.exec(lines[i]);
      if (m) pushDep("npm", m[1], m[2], i + 1, lines[i]);
    }
    return deps;
  }

  if (base === "requirements.txt") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_.\-]+)(?:\[[^\]]+\])?\s*(?:==|>=|~=)\s*([0-9][0-9A-Za-z.\-]*)/.exec(line);
      if (m) pushDep("pip", m[1], m[2], i + 1, line);
    }
    return deps;
  }

  if (base === "poetry.lock") {
    let curName = "";
    let curLine = 1;
    for (let i = 0; i < lines.length; i++) {
      const nm = /^name\s*=\s*"([^"]+)"/.exec(lines[i].trim());
      if (nm) { curName = nm[1]; curLine = i + 1; continue; }
      const vm = /^version\s*=\s*"([^"]+)"/.exec(lines[i].trim());
      if (vm && curName) {
        pushDep("pip", curName, vm[1], curLine, `${curName} = "${vm[1]}"`);
        curName = "";
      }
    }
    return deps;
  }

  if (base === "pipfile.lock") {
    try {
      const doc = JSON.parse(content);
      for (const sec of ["default", "develop"]) {
        const map = doc[sec];
        if (!map || typeof map !== "object") continue;
        for (const [name, info] of Object.entries<any>(map)) {
          const ver = String(info?.version || "").replace(/^==\s*/, "");
          if (ver) {
            const ln = findLineForToken(lines, `"${name}"`);
            pushDep("pip", name, ver, ln, lines[ln - 1] || `"${name}": "${ver}"`);
          }
        }
      }
    } catch {}
    return deps;
  }

  if (base === "go.mod") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\/\//.test(line)) continue;
      const m = /^\s*(?:require\s+)?([A-Za-z0-9._~/-]+\.[A-Za-z0-9._~/-]+)\s+(v[0-9][0-9A-Za-z.\-+]*)/.exec(line);
      if (m) pushDep("go", m[1], m[2], i + 1, line);
    }
    return deps;
  }

  if (base === "cargo.lock") {
    let curName = "";
    let curLine = 1;
    for (let i = 0; i < lines.length; i++) {
      const nm = /^\s*name\s*=\s*"([^"]+)"/.exec(lines[i]);
      if (nm) { curName = nm[1]; curLine = i + 1; continue; }
      const vm = /^\s*version\s*=\s*"([^"]+)"/.exec(lines[i]);
      if (vm && curName) {
        pushDep("cargo", curName, vm[1], curLine, `${curName} = "${vm[1]}"`);
        curName = "";
      }
    }
    return deps;
  }

  if (base === "cargo.toml") {
    let section = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      const secMatch = /^\[([^\]]+)\]/.exec(line);
      if (secMatch) { section = secMatch[1].trim().toLowerCase(); continue; }
      if (!section.endsWith("dependencies")) continue;
      const simple = /^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (simple) { pushDep("cargo", simple[1], simple[2], i + 1, line); continue; }
      const inlineTable = /^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bversion\s*=\s*["']([^"']+)["']/.exec(line);
      if (inlineTable) pushDep("cargo", inlineTable[1], inlineTable[2], i + 1, line);
    }
    return deps;
  }

  if (base === "pom.xml") {
    const depBlockRe = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi;
    let m: RegExpExecArray | null;
    while ((m = depBlockRe.exec(content)) !== null) {
      const block = m[1];
      const groupId = /<groupId>\s*([^<\s]+)\s*<\/groupId>/i.exec(block)?.[1];
      const artifactId = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/i.exec(block)?.[1];
      const version = /<version>\s*([^<\s]+)\s*<\/version>/i.exec(block)?.[1];
      if (groupId && artifactId && version && !version.startsWith("${")) {
        const line = content.slice(0, m.index).split(/\r?\n/).length;
        pushDep("maven", `${groupId}:${artifactId}`, version, line, `<dependency>${groupId}:${artifactId}:${version}</dependency>`);
        pushDep("maven", artifactId, version, line, `<dependency>${groupId}:${artifactId}:${version}</dependency>`);
      }
    }
    return deps;
  }

  if (base === "composer.lock") {
    try {
      const doc = JSON.parse(content);
      const pkgs = [
        ...(Array.isArray(doc.packages) ? doc.packages : []),
        ...(Array.isArray(doc["packages-dev"]) ? doc["packages-dev"] : [])
      ];
      for (const p of pkgs) {
        if (!p?.name || !p?.version) continue;
        const ln = findLineForToken(lines, `"${p.name}"`);
        pushDep("composer", p.name, String(p.version), ln, lines[ln - 1] || `"${p.name}": "${p.version}"`);
      }
    } catch {}
    return deps;
  }

  if (base === "gemfile.lock") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s{4}([A-Za-z0-9_.-]+)\s+\(([0-9][0-9A-Za-z.-]*)\)/.exec(lines[i]);
      if (m) pushDep("rubygems", m[1], m[2], i + 1, lines[i]);
    }
    return deps;
  }

  return deps;
}

function normalizeImportedPackage(spec: string): string {
  const clean = spec.trim().replace(/^['"]|['"]$/g, "");
  if (!clean || clean.startsWith(".")) return "";
  if (clean.startsWith("@")) {
    const parts = clean.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : clean.toLowerCase();
  }
  return clean.split("/")[0].toLowerCase();
}

export function collectImportedPackagesFromContent(content: string, imported: Set<string>): void {
  const jsRe = /(?:import\s+(?:[\s\S]{1,120}?\s+from\s+)?|require\s*\()\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = jsRe.exec(content)) !== null) {
    const pkg = normalizeImportedPackage(m[1]);
    if (pkg) imported.add(pkg);
  }
  const pyRe = /^\s*(?:from|import)\s+([A-Za-z0-9_.-]+)/gm;
  while ((m = pyRe.exec(content)) !== null) {
    const base = m[1].split(".")[0].toLowerCase();
    imported.add(base);
    imported.add(base.replace(/_/g, "-"));
  }
  const goRe = /"([A-Za-z0-9._~/-]+\.[A-Za-z0-9._~/-]+)"/g;
  while ((m = goRe.exec(content)) !== null) imported.add(m[1].toLowerCase());
  const rustRe = /^\s*(?:use|extern\s+crate)\s+([A-Za-z0-9_]+)/gm;
  while ((m = rustRe.exec(content)) !== null) {
    imported.add(m[1].toLowerCase());
    imported.add(m[1].toLowerCase().replace(/_/g, "-"));
  }
}

const CODE_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".php", ".rb", ".java"]);

export function collectWorkspaceImports(dir: string, limit = 600): Set<string> {
  const imported = new Set<string>();
  const walk = (cur: string, count: { n: number }) => {
    if (!existsSync(cur) || count.n >= limit) return;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (count.n >= limit) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) walk(full, count);
      else if (entry.isFile() && CODE_EXTS.has(extname(entry.name).toLowerCase())) {
        try {
          const st = statSync(full);
          if (st.size <= 512 * 1024) {
            collectImportedPackagesFromContent(readFileSync(full, "utf8"), imported);
            count.n++;
          }
        } catch {}
      }
    }
  };
  walk(dir, { n: 0 });
  return imported;
}

function normalizeSeverity(raw: string): Finding["severity"] {
  const u = String(raw || "MEDIUM").toUpperCase();
  if (u === "CRITICAL" || u === "HIGH" || u === "MEDIUM" || u === "LOW") return u;
  if (u === "ERROR") return "HIGH";
  if (u === "WARNING") return "MEDIUM";
  return "LOW";
}

function collectManifestFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectManifestFiles(full));
    else if (entry.isFile() && MANIFEST_NAMES.has(entry.name.toLowerCase())) results.push(full);
  }
  return results;
}

export function scanWorkspaceDependencies(options: {
  workspaceDir: string;
  advisories: Record<string, readonly AdvisoryEntry[]>;
  minRank: number;
  severityRanks: Record<Finding["severity"], number>;
  importedPackages?: ReadonlySet<string>;
}): Finding[] {
  const { workspaceDir, advisories, minRank, severityRanks } = options;
  if (!advisories || typeof advisories !== "object") return [];

  const files = collectManifestFiles(workspaceDir);
  if (files.length === 0) return [];
  const imported = options.importedPackages || collectWorkspaceImports(workspaceDir);
  const hasImports = imported.size > 0;
  const findings: Finding[] = [];
  const emitted = new Set<string>();

  for (const fullPath of files) {
    let raw: Buffer;
    try {
      const st = statSync(fullPath);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      raw = readFileSync(fullPath);
    } catch {
      continue;
    }
    const relPath = relative(workspaceDir, fullPath).replace(/\\/g, "/");
    const deps = parseManifestDependencies(relPath, raw.toString("utf8"));

    for (const dep of deps) {
      const ecoList = advisories[dep.ecosystem] || [];
      if (!Array.isArray(ecoList) || ecoList.length === 0) continue;
      const depLower = dep.name.toLowerCase();
      const isReachable = imported.has(depLower) || (depLower.includes(":") && imported.has(depLower.split(":")[1]));

      for (const adv of ecoList) {
        if (!adv || !adv.name || adv.name.toLowerCase() !== depLower) continue;
        if (!isVersionAffected(dep.version, adv)) continue;
        const severity = normalizeSeverity(adv.sev);
        if (severityRanks[severity] < minRank) continue;

        const dedupKey = `${relPath}:${dep.line}:${adv.id}`;
        if (emitted.has(dedupKey)) continue;
        emitted.add(dedupKey);

        const tags: string[] = [];
        if (hasImports) tags.push(isReachable ? "REACHABLE" : "INSTALLED");
        if (adv.kev) tags.push("CISA KEV");
        if (typeof adv.epss === "number" && adv.epss > 0) tags.push(`EPSS ${(adv.epss * 100).toFixed(1)}%`);
        const tagSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";

        findings.push({
          id: adv.id,
          ruleId: adv.id,
          cwe: adv.cwe || "CWE-1395",
          category: "SCA",
          severity,
          file: relPath,
          line: dep.line,
          snippet: dep.snippet,
          message: `${dep.name}@${dep.version} is affected by ${adv.id}${tagSuffix}: ${adv.note || "known security advisory"}`,
          remediation: adv.lt
            ? `Upgrade ${dep.name} to version ${adv.lt} or later.`
            : adv.le
              ? `Upgrade ${dep.name} to a version newer than ${adv.le}.`
              : `Upgrade ${dep.name} to a patched release.`,
          source: "sca",
          reachable: hasImports ? isReachable : undefined,
          kev: Boolean(adv.kev),
          epss: typeof adv.epss === "number" ? adv.epss : undefined
        });
      }
    }
  }

  return findings;
}
