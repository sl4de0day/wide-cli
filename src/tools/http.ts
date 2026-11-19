import { NetworkPolicy, tlsProfileHeaders } from "../security/crawler.js";
import { checkUrlSecurity, computeJitterBackoffMs, HostBreakerRegistry, validateRedirectChain } from "./resilience.js";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.js";

const cliHttpBreakers = new HostBreakerRegistry();

export const httpRequestTool: Tool = {
  definition: {
    name: "send_http_request",
    description: "Send an HTTP/HTTPS request with hop-by-hop redirect SSRF protection, optional jitter backoff retries, and circuit breaker guard.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL (must include http:// or https://)." },
        method: {
          type: "string",
          description: "HTTP method to use.",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]
        },
        headers: { type: "object", description: "Optional key-value pairs of request headers." },
        body: { type: "string", description: "Optional request body." },
        timeoutMs: { type: "number", description: "Request timeout in milliseconds (default: 15000)." },
        tlsProfile: { type: "string", enum: ["none", "chrome", "firefox", "safari"], description: "Browser header profile impersonation." },
        allowPrivate: { type: "boolean", description: "Allow private/loopback addresses. Set false to enforce SSRF NetworkPolicy across all redirect hops." },
        allowCredentials: { type: "boolean", description: "Allow embedded user:pass@ credentials in URLs. Defaults to false." },
        maxRedirects: { type: "number", description: "Maximum redirect hops to follow safely (default: 5)." },
        retries: { type: "number", description: "Optional retry count on transient 429/5xx errors with jitter backoff (default: 0)." },
        useBreaker: { type: "boolean", description: "Enable per-host circuit breaker guard against repeated blocks." }
      },
      required: ["url"]
    }
  },
  async execute(params, _context): Promise<ToolResult> {
    const targetUrl = String(params.url || "").trim();
    const initialMethod = String(params.method || "GET").toUpperCase();
    const timeout = Number(params.timeoutMs) || 15000;
    const allowPrivate = params.allowPrivate !== false;
    const allowCredentials = params.allowCredentials === true;
    const maxRedirects = Number.isFinite(Number(params.maxRedirects)) ? Math.max(0, Math.min(10, Math.floor(Number(params.maxRedirects)))) : 5;
    const retries = Number.isFinite(Number(params.retries)) ? Math.max(0, Math.min(4, Math.floor(Number(params.retries)))) : 0;
    const useBreaker = Boolean(params.useBreaker);

    const initCheck = checkUrlSecurity(targetUrl, { allowPrivate, allowCredentials, allowNonHttp: false });
    if (!initCheck.allowed) {
      return { success: false, output: "", error: initCheck.reason };
    }
    if (!allowPrivate) {
      const policy = new NetworkPolicy({ allowPrivate: false, allowNonHttp: false });
      if (!policy.allows(targetUrl)) {
        return { success: false, output: "", error: `Blocked by SSRF NetworkPolicy: ${targetUrl}` };
      }
    }
    if (useBreaker && !cliHttpBreakers.canTry(targetUrl)) {
      return { success: false, output: "", error: `Circuit breaker OPEN for ${targetUrl}` };
    }

    const reqHeaders: Record<string, string> = {
      ...tlsProfileHeaders(params.tlsProfile),
      ...(params.headers || {})
    };

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const startTime = Date.now();
        let curUrl = targetUrl;
        let curMethod = initialMethod;
        let curBody = params.body && curMethod !== "GET" && curMethod !== "HEAD" ? String(params.body) : undefined;
        const chain: string[] = [curUrl];
        let res: Response | null = null;

        for (let hop = 0; hop <= maxRedirects; hop += 1) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const fetchOptions: RequestInit = {
              method: curMethod,
              headers: reqHeaders,
              signal: controller.signal,
              redirect: "manual",
            };
            if (curBody !== undefined) fetchOptions.body = curBody;
            res = await fetch(curUrl, fetchOptions);
          } finally {
            clearTimeout(timer);
          }

          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (loc) {
              if (hop >= maxRedirects) {
                return { success: false, output: "", error: `Redirect chain exceeded maximum (${maxRedirects} hops)` };
              }
              const nextUrl = new URL(loc, curUrl).toString();
              chain.push(nextUrl);
              const hopCheck = validateRedirectChain(chain, { maxRedirects, allowPrivate, allowCredentials });
              if (!hopCheck.allowed) {
                return { success: false, output: "", error: hopCheck.reason };
              }
              curUrl = nextUrl;
              if (res.status === 303 || (curMethod !== "GET" && curMethod !== "HEAD" && res.status !== 307 && res.status !== 308)) {
                curMethod = "GET";
                curBody = undefined;
              }
              continue;
            }
          }
          break;
        }

        if (!res) {
          throw new Error("No HTTP response received");
        }

        const retryable = (res.status === 429 || res.status >= 500) && attempt < retries;
        if (useBreaker) {
          cliHttpBreakers.recordStatus(curUrl, res.status);
        }
        if (retryable) {
          await new Promise((r) => setTimeout(r, computeJitterBackoffMs(attempt, 200, 200)));
          continue;
        }

        const durationMs = Date.now() - startTime;
        let resText = await res.text();
        if (resText.length > 8000) {
          resText = resText.slice(0, 8000) + "\n... [Body truncated]";
        }

        const resHeaders: string[] = [];
        res.headers.forEach((val, key) => {
          resHeaders.push(`${key}: ${val}`);
        });

        const output = [
          `Status: ${res.status} ${res.statusText}`,
          `Final URL: ${curUrl}`,
          chain.length > 1 ? `Redirects: ${chain.length - 1} (${chain.join(" -> ")})` : "",
          `Duration: ${durationMs}ms`,
          `Headers:\n${resHeaders.join("\n")}`,
          `Body:\n${resText || "[Empty Body]"}`
        ].filter(Boolean).join("\n\n");

        return { success: true, output };
      } catch (err: any) {
        lastErr = err;
        if (useBreaker) cliHttpBreakers.recordError(targetUrl);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, computeJitterBackoffMs(attempt, 200, 200)));
          continue;
        }
      }
    }

    return {
      success: false,
      output: "",
      error: `HTTP request failed: ${(lastErr as Error)?.message || String(lastErr)}`
    };
  }
};
