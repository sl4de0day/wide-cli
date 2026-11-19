import * as http from "node:http";
import * as https from "node:https";

export function isInternalHost(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!clean) return false;
  if (
    clean === "localhost" ||
    clean.endsWith(".localhost") ||
    clean.endsWith(".local") ||
    clean.endsWith(".internal") ||
    clean === "metadata.google.internal"
  ) {
    return true;
  }
  const v4 = clean.split(".");
  if (v4.length === 4 && v4.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    const a = Number(v4[0]);
    const b = Number(v4[1]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (/^\d+$/.test(clean) && Number(clean) <= 0xffffffff) return true;
  if (/^0x[0-9a-f]+$/i.test(clean)) return true;
  if (clean === "::1" || clean === "::" || clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80")) {
    return true;
  }
  if (clean.startsWith("::ffff:")) {
    return isInternalHost(clean.slice(7));
  }
  return false;
}

export type UrlSecurityCheckResult =
  | { allowed: true; url: URL }
  | { allowed: false; reason: string };

export interface UrlSecurityOptions {
  allowPrivate?: boolean;
  allowCredentials?: boolean;
  allowNonHttp?: boolean;
  maxRedirects?: number;
}

export function checkUrlSecurity(rawUrl: string, opts: UrlSecurityOptions = {}): UrlSecurityCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return { allowed: false, reason: `Invalid URL: ${rawUrl}` };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (!opts.allowNonHttp && scheme !== "http:" && scheme !== "https:") {
    return { allowed: false, reason: `Disallowed protocol (${parsed.protocol}): ${parsed.href}` };
  }

  if (opts.allowCredentials !== true && (parsed.username || parsed.password)) {
    return { allowed: false, reason: `Blocked URL containing embedded credentials (user:pass@): ${parsed.origin}` };
  }

  if (opts.allowPrivate === false && isInternalHost(parsed.hostname)) {
    return { allowed: false, reason: `Blocked by SSRF NetworkPolicy (internal/private host): ${parsed.hostname}` };
  }

  return { allowed: true, url: parsed };
}

export function validateRedirectChain(
  urls: readonly string[],
  opts: UrlSecurityOptions = {},
): { allowed: true } | { allowed: false; reason: string } {
  const maxHops = Math.max(0, opts.maxRedirects ?? 5);
  if (urls.length > maxHops + 1) {
    return { allowed: false, reason: `Redirect chain too long (>${maxHops} hops)` };
  }
  for (const hopUrl of urls) {
    const check = checkUrlSecurity(hopUrl, opts);
    if (!check.allowed) {
      return { allowed: false, reason: `Redirect target rejected (${hopUrl}): ${check.reason}` };
    }
  }
  return { allowed: true };
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  initialCooldownMs?: number;
  maxCooldownMs?: number;
  multiplier?: number;
}

export class CircuitBreaker {
  state: CircuitState = "CLOSED";
  fails = 0;
  openUntil = 0;
  cooldownMs: number;
  readonly failureThreshold: number;
  readonly initialCooldownMs: number;
  readonly maxCooldownMs: number;
  readonly multiplier: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 3);
    this.initialCooldownMs = Math.max(10, opts.initialCooldownMs ?? 30 * 60_000);
    this.maxCooldownMs = Math.max(this.initialCooldownMs, opts.maxCooldownMs ?? 4 * 3_600_000);
    this.multiplier = Math.max(1, opts.multiplier ?? 2);
    this.cooldownMs = this.initialCooldownMs;
  }

  canTry(now = Date.now()): boolean {
    if (this.state !== "OPEN") return true;
    if (now >= this.openUntil) {
      this.state = "HALF_OPEN";
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.fails = 0;
    this.cooldownMs = this.initialCooldownMs;
    this.state = "CLOSED";
    this.openUntil = 0;
  }

  onBlocked(now = Date.now()): void {
    this.fails += 1;
    if (this.fails >= this.failureThreshold || this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openUntil = now + this.cooldownMs;
      this.cooldownMs = Math.min(this.cooldownMs * this.multiplier, this.maxCooldownMs);
    }
  }

  snapshot(): { state: CircuitState; fails: number; openUntil: number; cooldownMs: number } {
    return {
      state: this.state,
      fails: this.fails,
      openUntil: this.openUntil,
      cooldownMs: this.cooldownMs,
    };
  }
}

export class HostBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly defaultOpts: CircuitBreakerOptions;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.defaultOpts = opts;
  }

  private hostOf(urlOrHost: string): string {
    try {
      return new URL(urlOrHost).hostname.toLowerCase();
    } catch {
      return String(urlOrHost || "").trim().toLowerCase();
    }
  }

  get(urlOrHost: string): CircuitBreaker {
    const key = this.hostOf(urlOrHost) || "default";
    let b = this.breakers.get(key);
    if (!b) {
      b = new CircuitBreaker(this.defaultOpts);
      this.breakers.set(key, b);
    }
    return b;
  }

  canTry(urlOrHost: string, now = Date.now()): boolean {
    return this.get(urlOrHost).canTry(now);
  }

  recordSuccess(urlOrHost: string): void {
    this.get(urlOrHost).onSuccess();
  }

  recordStatus(urlOrHost: string, status: number, now = Date.now()): boolean {
    if (status === 403 || status === 429 || status >= 500) {
      this.get(urlOrHost).onBlocked(now);
      return true;
    }
    this.get(urlOrHost).onSuccess();
    return false;
  }

  recordError(urlOrHost: string, now = Date.now()): void {
    this.get(urlOrHost).onBlocked(now);
  }

  getStatus(urlOrHost: string) {
    return this.get(urlOrHost).snapshot();
  }

  reset(urlOrHost?: string): void {
    if (urlOrHost) this.breakers.delete(this.hostOf(urlOrHost));
    else this.breakers.clear();
  }
}

export function computeJitterBackoffMs(
  attempt: number,
  baseMs = 1000,
  maxJitterMs = 700,
  randomFn: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.min(10, Math.floor(attempt)));
  const exp = Math.pow(2, safeAttempt) * Math.max(1, baseMs);
  const jitter = Math.floor(Math.max(0, Math.min(0.999999, randomFn())) * Math.max(0, maxJitterMs));
  return Math.round(exp + jitter);
}

export class AgentPool {
  private readonly httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly proxyCache = new Map<string, http.Agent>();

  getAgent(protocol: string, insecure = false, proxyKey?: string): http.Agent | https.Agent {
    if (proxyKey) {
      const k = `${protocol}:${insecure ? "1" : "0"}:${proxyKey}`;
      let cached = this.proxyCache.get(k);
      if (!cached) {
        cached = protocol === "https:"
          ? new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: !insecure })
          : new http.Agent({ keepAlive: true, maxSockets: 32 });
        this.proxyCache.set(k, cached);
      }
      return cached;
    }
    return protocol === "https:" ? this.httpsKeepAlive : this.httpKeepAlive;
  }

  size(): number {
    return this.proxyCache.size;
  }

  closeAll(): void {
    this.httpKeepAlive.destroy();
    this.httpsKeepAlive.destroy();
    for (const agent of this.proxyCache.values()) {
      agent.destroy();
    }
    this.proxyCache.clear();
  }
}
