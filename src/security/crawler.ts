import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { checkUrlSecurity, HostBreakerRegistry, isInternalHost as sharedIsInternalHost, validateRedirectChain } from "../tools/resilience.js";
import { evaluateHttpInspection } from "./inspect.js";

const DEFAULT_DENIED_EXTENSIONS = new Set([
  "3g2", "3gp", "7z", "apk", "arj", "avi", "axd", "bmp", "csv", "deb", "dll", "doc", "drv",
  "eot", "exe", "flv", "gif", "gifv", "gz", "h264", "ico", "iso", "jar", "jpeg", "jpg", "lock",
  "m4a", "m4v", "map", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg", "msi", "ogg", "ogm", "ogv",
  "otf", "pdf", "pkg", "png", "ppt", "psd", "rar", "rm", "rpm", "svg", "swf", "sys", "tar",
  "tif", "tiff", "ttf", "vob", "wav", "webm", "webp", "wmv", "woff", "woff2", "xcf", "xls",
  "xlsx", "zip",
]);

const PROBE_PATHS = [
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known/security.txt",
  "/graphql",
  "/swagger.json",
  "/openapi.json",
  "/api-docs",
  "/.env",
  "/.git/HEAD",
  "/admin",
  "/login",
];

const SL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.tr", "org.tr", "gov.tr", "edu.tr", "net.tr",
  "com.au", "org.au", "net.au", "co.jp", "or.jp", "com.br", "co.in", "com.cn", "co.kr",
]);

export function isInternalHost(host: string): boolean {
  return sharedIsInternalHost(host);
}

export class NetworkPolicy {
  private readonly allowPrivate: boolean;
  private readonly allowNonHttp: boolean;

  constructor(opts: { allowPrivate?: boolean; allowNonHttp?: boolean } = {}) {
    this.allowPrivate = Boolean(opts.allowPrivate);
    this.allowNonHttp = Boolean(opts.allowNonHttp);
  }

  allows(rawUrl: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (!this.allowNonHttp && parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!this.allowPrivate && isInternalHost(parsed.hostname)) return false;
    return true;
  }
}

export function registrableDomain(hostname: string): string {
  const clean = hostname.trim().toLowerCase().replace(/\.$/, "");
  const parts = clean.split(".").filter(Boolean);
  if (parts.length <= 2) return clean;
  const tail2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (SL_SUFFIXES.has(tail2) && parts.length >= 3) return `${parts[parts.length - 3]}.${tail2}`;
  return tail2;
}

export class ScopeManager {
  private readonly fieldScope: string;
  private readonly inScope: RegExp[];
  private readonly outScope: RegExp[];
  private readonly network: NetworkPolicy;
  private readonly noScope: boolean;

  constructor(opts: {
    fieldScope?: string;
    inScope?: string[];
    outScope?: string[];
    allowPrivate?: boolean;
    noScope?: boolean;
  } = {}) {
    this.fieldScope = (opts.fieldScope || "rdn").toLowerCase();
    this.inScope = (opts.inScope || []).map((p) => new RegExp(p));
    this.outScope = (opts.outScope || []).map((p) => new RegExp(p));
    this.network = new NetworkPolicy({ allowPrivate: Boolean(opts.allowPrivate), allowNonHttp: false });
    this.noScope = Boolean(opts.noScope);
  }

  validate(rawUrl: string, rootHostname: string): boolean {
    if (!this.network.allows(rawUrl)) return false;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (!this.noScope) {
      const h = parsed.hostname.toLowerCase();
      const r = rootHostname.toLowerCase();
      if (this.fieldScope === "fqdn") {
        if (h !== r) return false;
      } else if (this.fieldScope === "dn") {
        const kw = (registrableDomain(r).split(".")[0] || r).toLowerCase();
        if (!kw || !h.includes(kw)) return false;
      } else {
        const reg = registrableDomain(r) || r;
        if (h !== reg && !h.endsWith(`.${reg}`)) return false;
      }
    }
    for (const re of this.outScope) {
      if (re.test(parsed.href)) return false;
    }
    if (this.inScope.length === 0) return true;
    return this.inScope.some((re) => re.test(parsed.href));
  }
}

interface TrieNode {
  children: Map<string, TrieNode>;
  paramChild: TrieNode | null;
  promoted: boolean;
}

export class PathTrie {
  private readonly threshold: number;
  private readonly roots = new Map<string, TrieNode>();

  constructor(threshold = 10) {
    this.threshold = Math.max(1, threshold);
  }

  fingerprint(host: string, segments: string[]): string[] {
    let node = this.roots.get(host);
    if (!node) {
      node = { children: new Map(), paramChild: null, promoted: false };
      this.roots.set(host, node);
    }
    const out: string[] = [];
    for (const seg of segments) {
      if (node.promoted) {
        out.push("{param}");
        if (!node.paramChild) node.paramChild = { children: new Map(), paramChild: null, promoted: false };
        node = node.paramChild;
        continue;
      }
      let next = node.children.get(seg);
      if (!next) {
        next = { children: new Map(), paramChild: null, promoted: false };
        node.children.set(seg, next);
        if (node.children.size > this.threshold) {
          node.promoted = true;
          node.children.clear();
          node.paramChild = { children: new Map(), paramChild: null, promoted: false };
          out.push("{param}");
          node = node.paramChild;
          continue;
        }
      }
      out.push(seg);
      node = next;
    }
    return out;
  }
}

export function fingerprintUrl(rawUrl: string, trie?: PathTrie): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const trimmed = parsed.pathname.replace(/^\/+|\/+$/g, "");
  let segs = trimmed ? trimmed.split("/") : [];
  segs = segs.map((s) => {
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) return "{uuid}";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "{date}";
    if (/^-?\d+$/.test(s)) return "{num}";
    if (s.length >= 24 && /^[0-9a-fA-F]+$/.test(s)) return "{hex}";
    return s;
  });
  if (trie) segs = trie.fingerprint(parsed.hostname, segs);
  let normalizedPath = `/${segs.join("/")}`;
  if (parsed.pathname.endsWith("/") && segs.length > 0) normalizedPath += "/";
  const keys = Array.from(new Set(Array.from(parsed.searchParams.keys()))).sort();
  return `${parsed.protocol}//${parsed.host}${normalizedPath}${keys.length ? `?${keys.join("&")}` : ""}`;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv64(text: string): bigint {
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(text, "utf8")) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

export function simhash64(features: string[]): bigint {
  if (features.length === 0) return 0n;
  const weights = new Int32Array(64);
  for (const f of features) {
    const h = fnv64(f);
    for (let i = 0; i < 64; i++) {
      if ((h >> BigInt(i)) & 1n) weights[i] += 1;
      else weights[i] -= 1;
    }
  }
  let fp = 0n;
  for (let i = 0; i < 64; i++) {
    if (weights[i] > 0) fp |= 1n << BigInt(i);
  }
  return fp;
}

export function hammingDistance64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

export function shannonEntropy(input: string): number {
  if (!input) return 0;
  const counts = new Map<string, number>();
  for (const ch of input) counts.set(ch, (counts.get(ch) || 0) + 1);
  let sum = 0;
  for (const c of counts.values()) {
    const p = c / input.length;
    sum -= p * Math.log2(p);
  }
  return sum;
}

export function auditSecurityHeaders(headers: Record<string, string>): Array<{ header: string; issue: string; severity: string }> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const issues: Array<{ header: string; issue: string; severity: string }> = [];
  for (const req of ["content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options"]) {
    if (!(req in lower)) {
      issues.push({
        header: req,
        issue: "missing",
        severity: req === "content-security-policy" || req === "strict-transport-security" ? "medium" : "low",
      });
    }
  }
  for (const dis of ["server", "x-powered-by", "x-aspnet-version"]) {
    if (dis in lower) issues.push({ header: dis, issue: `discloses version (${lower[dis]})`, severity: "info" });
  }
  return issues;
}

export function decodeJwtTokens(text: string): Array<{ rawPrefix: string; header: Record<string, unknown>; payload: Record<string, unknown>; issues: string[] }> {
  const seen = new Set<string>();
  const out: Array<{ rawPrefix: string; header: Record<string, unknown>; payload: Record<string, unknown>; issues: string[] }> = [];
  const now = Math.floor(Date.now() / 1000);
  for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{0,128}\b/g)) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    seen.add(tok);
    const parts = tok.split(".");
    try {
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
      const issues: string[] = [];
      if (typeof header.alg === "string" && header.alg.toLowerCase() === "none") issues.push("alg is none");
      if (typeof payload.exp === "number" && payload.exp < now) issues.push("token is expired");
      out.push({ rawPrefix: `${tok.slice(0, 24)}...`, header, payload, issues });
    } catch {}
  }
  return out;
}

export function scanSecretsWithEntropy(text: string): Array<{ kind: string; preview: string; entropy: number }> {
  const rules: Array<{ kind: string; re: RegExp; group: number; minEntropy: number }> = [
    { kind: "AWS Access Key ID", re: /\b(?:AKIA|ASIA|AGPA|AIDA)[0-9A-Z]{16}\b/g, group: 0, minEntropy: 0 },
    { kind: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0, minEntropy: 0 },
    { kind: "GitHub Token", re: /\b(?:gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{36,})\b/g, group: 0, minEntropy: 0 },
    { kind: "Stripe Secret Key", re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{24,99}\b/g, group: 0, minEntropy: 0 },
    { kind: "Private Key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, group: 0, minEntropy: 0 },
    {
      kind: "Generic High-Entropy Secret",
      re: /(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token)["'\s]*[:=]["'\s]*([A-Za-z0-9+/_\-.]{16,})/gi,
      group: 1,
      minEntropy: 3.5,
    },
  ];
  const seen = new Set<string>();
  const out: Array<{ kind: string; preview: string; entropy: number }> = [];
  for (const r of rules) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(text)) !== null) {
      const val = m[r.group];
      if (!val) continue;
      const entropy = shannonEntropy(val);
      if (r.minEntropy > 0 && entropy < r.minEntropy) continue;
      const key = `${r.kind}:${val}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const preview = val.length <= 8 ? "****" : `${val.slice(0, 4)}...${val.slice(-4)}`;
      out.push({ kind: r.kind, preview, entropy: Number(entropy.toFixed(2)) });
    }
  }
  return out;
}

export function extractJsEndpoints(baseUrl: string, body: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /fetch\s*\(\s*["'`]([^"'`${}\s]+)["'`]/g,
    /\.(?:get|post|put|delete|patch|head|options)\s*\(\s*["'`]([^"'`${}\s]+)["'`]/g,
    /["'`]((?:https?:)?\/\/[^\s"'`<>]+|\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{2,})["'`]/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      try {
        const u = new URL(m[1], baseUrl);
        if (u.protocol === "http:" || u.protocol === "https:") {
          u.hash = "";
          out.add(u.href);
        }
      } catch {}
    }
  }
  return Array.from(out);
}

export function parseResponseLinks(baseUrl: string, headers: Record<string, string>, body: string): string[] {
  const links = new Set<string>();
  const attrRe = /(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(body)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|data|tel):/i.test(raw)) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.hash = "";
        links.add(u.href);
      }
    } catch {}
  }
  const ct = (headers["content-type"] || "").toLowerCase();
  if (ct.includes("javascript") || baseUrl.endsWith(".js")) {
    for (const u of extractJsEndpoints(baseUrl, body)) links.add(u);
  } else {
    for (const sm of body.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const u of extractJsEndpoints(baseUrl, sm[1])) links.add(u);
    }
  }
  return Array.from(links);
}

export function tlsProfileHeaders(profile?: string): Record<string, string> {
  const p = (profile || "").toLowerCase();
  if (p === "chrome") {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
  }
  if (p === "firefox") {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    };
  }
  if (p === "safari") {
    return {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
  }
  return {};
}

export interface CrawlCliOptions {
  maxDepth?: number;
  maxPages?: number;
  fieldScope?: "rdn" | "fqdn" | "dn";
  allowPrivate?: boolean;
  probePaths?: boolean;
  robotsAndSitemap?: boolean;
  filterSimilar?: boolean;
  tlsProfile?: string;
  headers?: Record<string, string>;
}

export interface CrawlCliPage {
  url: string;
  status: number;
  depth: number;
  links: string[];
  securityIssues: number;
  jwtCount: number;
  secretCount: number;
  inspectAction?: string;
  inspectTrigger?: string | null;
  smugglingVectors?: string[];
}

export interface CrawlCliResult {
  seed: string;
  engine: "native-rust" | "node-ts";
  visited: number;
  pages: CrawlCliPage[];
  endpoints: string[];
}

function findSpiderBinary(): string | null {
  const bin = process.platform === "win32" ? "wide-spider.exe" : "wide-spider";
  const candidates = [
    process.env.WIDE_SPIDER_BIN,
    resolve(process.cwd(), "native-core", "target", "release", bin),
    resolve(process.cwd(), "..", "wide-app", "native-core", "target", "release", bin),
  ].filter((x): x is string => Boolean(x));
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

export class WideCrawler {
  async crawl(seedUrl: string, opts: CrawlCliOptions = {}): Promise<CrawlCliResult> {
    const parsed = new URL(seedUrl);
    const scope = new ScopeManager({
      fieldScope: opts.fieldScope || "rdn",
      allowPrivate: Boolean(opts.allowPrivate),
    });
    if (!scope.validate(parsed.href, parsed.hostname)) {
      throw new Error(`Blocked by Wide scope or SSRF NetworkPolicy: ${seedUrl}`);
    }

    const nativeBin = findSpiderBinary();
    if (nativeBin) {
      const nativeResult = await this.runNative(nativeBin, parsed.href, opts);
      if (nativeResult) return nativeResult;
    }

    const maxDepth = opts.maxDepth ?? 3;
    const maxPages = opts.maxPages ?? 80;
    const trie = new PathTrie(10);
    const seen = new Set<string>([fingerprintUrl(parsed.href, trie)]);
    const queue: Array<{ url: string; depth: number }> = [{ url: parsed.href, depth: 0 }];
    if (opts.probePaths !== false) {
      for (const p of PROBE_PATHS) {
        const u = `${parsed.origin}${p}`;
        const fp = fingerprintUrl(u, trie);
        if (!seen.has(fp) && scope.validate(u, parsed.hostname)) {
          seen.add(fp);
          queue.push({ url: u, depth: 1 });
        }
      }
    }

    const pages: CrawlCliPage[] = [];
    const discoveredAll = new Set<string>([parsed.href]);
    const simHashes: bigint[] = [];
    const reqHeaders = { ...tlsProfileHeaders(opts.tlsProfile), ...(opts.headers || {}) };
    const hostBreakers = new HostBreakerRegistry({ failureThreshold: 3, initialCooldownMs: 30000 });
    const allowPrivate = Boolean(opts.allowPrivate);

    while (queue.length > 0 && pages.length < maxPages) {
      const item = queue.shift()!;
      const ext = (new URL(item.url).pathname.split("/").pop() || "").split(".").pop()?.toLowerCase() || "";
      if (ext && DEFAULT_DENIED_EXTENSIONS.has(ext) && item.url.includes(".")) continue;
      if (!hostBreakers.canTry(item.url)) continue;
      if (!checkUrlSecurity(item.url, { allowPrivate, allowCredentials: false }).allowed) continue;
      try {
        let curUrl = item.url;
        const hopChain = [curUrl];
        let resp: Response | null = null;
        for (let hop = 0; hop <= 5; hop += 1) {
          resp = await fetch(curUrl, { headers: reqHeaders, signal: AbortSignal.timeout(12000), redirect: "manual" });
          if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get("location");
            if (loc && hop < 5) {
              const nextUrl = new URL(loc, curUrl).toString();
              hopChain.push(nextUrl);
              if (!validateRedirectChain(hopChain, { maxRedirects: 5, allowPrivate, allowCredentials: false }).allowed) {
                resp = null;
                break;
              }
              curUrl = nextUrl;
              continue;
            }
          }
          break;
        }
        if (!resp) continue;
        hostBreakers.recordStatus(curUrl, resp.status);
        const body = await resp.text();
        const hdrs: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          hdrs[k.toLowerCase()] = v;
        });
        const finalUrl = curUrl;

        if (opts.filterSimilar !== false && item.depth > 0) {
          const tokens = body.replace(/<[^>]+>/g, " ").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
          if (tokens.length >= 10) {
            const fp = simhash64(tokens.slice(0, 500));
            if (simHashes.some((old) => hammingDistance64(fp, old) <= 6)) continue;
            simHashes.push(fp);
          }
        }

        const links = parseResponseLinks(finalUrl, hdrs, body);
        const sec = auditSecurityHeaders(hdrs);
        const jwts = decodeJwtTokens(body);
        const secrets = scanSecretsWithEntropy(body);
        const inspected = evaluateHttpInspection({
          url: finalUrl,
          method: "GET",
          headers: hdrs,
          body: body.slice(0, 65536),
        });
        pages.push({
          url: finalUrl,
          status: resp.status,
          depth: item.depth,
          links,
          securityIssues: sec.length,
          jwtCount: jwts.length,
          secretCount: secrets.length,
          inspectAction: inspected.action,
          inspectTrigger: inspected.trigger,
          smugglingVectors: inspected.smugglingVectors,
        });
        discoveredAll.add(finalUrl);
        for (const nextUrl of links) {
          discoveredAll.add(nextUrl);
          if (item.depth < maxDepth && scope.validate(nextUrl, parsed.hostname)) {
            const fp = fingerprintUrl(nextUrl, trie);
            if (!seen.has(fp)) {
              seen.add(fp);
              queue.push({ url: nextUrl, depth: item.depth + 1 });
            }
          }
        }
      } catch {}
    }

    return {
      seed: parsed.href,
      engine: "node-ts",
      visited: pages.length,
      pages,
      endpoints: Array.from(discoveredAll).sort(),
    };
  }

  private runNative(bin: string, seedUrl: string, opts: CrawlCliOptions): Promise<CrawlCliResult | null> {
    return new Promise((resolvePromise) => {
      let proc;
      try {
        proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch {
        resolvePromise(null);
        return;
      }
      let buf = "";
      const pages: CrawlCliPage[] = [];
      const endpoints = new Set<string>([seedUrl]);
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as { type: string; page?: any };
            if (ev.type === "page" && ev.page) {
              const p = ev.page;
              const u = String(p.finalUrl || p.url);
              endpoints.add(u);
              for (const l of p.links || []) endpoints.add(String(l));
              const inspected = evaluateHttpInspection({
                url: u,
                method: "GET",
                headers: p.headers && typeof p.headers === "object" ? p.headers : {},
                body: typeof p.bodyPreview === "string" ? p.bodyPreview.slice(0, 65536) : "",
              });
              pages.push({
                url: u,
                status: Number(p.status || 0),
                depth: Number(p.depth || 0),
                links: Array.isArray(p.links) ? p.links : [],
                securityIssues: Array.isArray(p.audit?.securityHeaders) ? p.audit.securityHeaders.length : 0,
                jwtCount: Array.isArray(p.audit?.jwtTokens) ? p.audit.jwtTokens.length : 0,
                secretCount: Array.isArray(p.audit?.secrets) ? p.audit.secrets.length : 0,
                inspectAction: inspected.action,
                inspectTrigger: inspected.trigger,
                smugglingVectors: inspected.smugglingVectors,
              });
            }
          } catch {}
        }
      });
      proc.on("error", () => resolvePromise(null));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolvePromise(null);
          return;
        }
        resolvePromise({
          seed: seedUrl,
          engine: "native-rust",
          visited: pages.length,
          pages,
          endpoints: Array.from(endpoints).sort(),
        });
      });
      proc.stdin.end(
        `${JSON.stringify({
          cmd: "crawl",
          seeds: [seedUrl],
          maxDepth: opts.maxDepth ?? 3,
          maxPages: opts.maxPages ?? 80,
          fieldScope: opts.fieldScope || "rdn",
          allowPrivate: Boolean(opts.allowPrivate),
          probePaths: opts.probePaths !== false,
          robotsAndSitemap: opts.robotsAndSitemap !== false,
          filterSimilar: opts.filterSimilar !== false,
          tlsProfile: opts.tlsProfile || "none",
        })}\n`,
      );
    });
  }
}
