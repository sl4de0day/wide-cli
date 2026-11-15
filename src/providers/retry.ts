import { debugLog } from "../config/logger.js";

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

export interface RetryFetchOptions {
  maxRetries?: number;
  timeoutMs?: number;
  label?: string;
}

function createAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryFetchOptions = {}
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 60000;
  const label = options.label || "http";
  const callerSignal = init.signal;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (callerSignal?.aborted) throw createAbortError();

    const attemptController = new AbortController();
    const onCallerAbort = () => attemptController.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => attemptController.abort(), timeoutMs);
    timer.unref?.();

    const startedAt = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: attemptController.signal });
      debugLog(label, `${init.method || "GET"} attempt ${attempt + 1} -> HTTP ${res.status} (${Date.now() - startedAt}ms)`);
      if (TRANSIENT_STATUS.has(res.status) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after") || "0");
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10000)
          : 350 * (2 ** attempt);
        try { await res.body?.cancel(); } catch {}
        await sleepWithAbort(delayMs, callerSignal);
        continue;
      }
      return res;
    } catch (err: any) {
      if (callerSignal?.aborted) throw createAbortError();
      const transient = err?.name === "AbortError" || err?.name === "TypeError";
      debugLog(label, `attempt ${attempt + 1} failed: ${err?.message || String(err)}`);
      if (!transient || attempt >= maxRetries) {
        throw err;
      }
      await sleepWithAbort(350 * (2 ** attempt), callerSignal);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  throw new Error(`${label} request failed after ${maxRetries + 1} attempts.`);
}
