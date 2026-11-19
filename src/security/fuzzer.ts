import { NetworkPolicy } from "./crawler.js";
import { inspectRawHttpResponse, normalizeEvasion } from "./inspect.js";
import { getPayloadsForType } from "./payloads.js";

export type FuzzLocation = "query" | "form" | "json" | "header" | "cookie" | "path";

export interface FuzzOptions {
  location?: FuzzLocation;
  headers?: Record<string, string>;
  compareHeaders?: Record<string, string>;
  timeoutMs?: number;
  allowPrivate?: boolean;
}

export interface FuzzFinding {
  payload: string;
  statusCode: number;
  reflectionFound: boolean;
  sqlErrorDetected: boolean;
  lengthDiff: number;
  elapsedMs: number;
  indicator: string;
}

export interface FuzzReport {
  url: string;
  param: string;
  payloadType: string;
  location: FuzzLocation;
  baselineStatus: number;
  baselineLength: number;
  baselineElapsedMs: number;
  findings: FuzzFinding[];
  isVulnerable: boolean;
  summary: string;
}

const SQL_ERROR_PATTERNS = [
  /you have an error in your sql syntax/i,
  /warning: mysql/i,
  /unclosed quotation mark after the character string/i,
  /quoted string not properly terminated/i,
  /postgresql.*?error/i,
  /sqlite3::SQLException/i,
  /syntax error in query expression/i,
  /microsoft ole db provider for sql server/i
];

const TRAVERSAL_MARKERS = [/root:[x*]:0:0:/, /\[extensions\]/i, /\[fonts\]/i];
const CMD_MARKERS = [/uid=\d+\([^)]+\)\s+gid=\d+/, /Windows IP Configuration/i, /Volume Serial Number/i];
const SSRF_MARKERS = [/ami-id/i, /instance-id/i, /computeMetadata/i, /meta-data\/iam/i];

function buildRequest(
  baseUrl: string,
  param: string,
  value: string,
  method: string,
  location: FuzzLocation,
  customHeaders: Record<string, string> = {},
  timeoutMs = 10000
): { targetUrl: string; init: RequestInit } {
  const target = new URL(baseUrl);
  const headers: Record<string, string> = {
    "User-Agent": "Wide-Security-Agent/1.0",
    ...customHeaders
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  };

  if (location === "json") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({ [param]: value });
  } else if (location === "form") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const body = new URLSearchParams();
    body.set(param, value);
    init.body = body.toString();
  } else if (location === "header") {
    headers[param] = value;
  } else if (location === "cookie") {
    headers["Cookie"] = `${param}=${encodeURIComponent(value)}`;
  } else if (location === "path") {
    const token = `{${param}}`;
    if (target.pathname.includes(token) || decodeURIComponent(target.pathname).includes(token)) {
      target.pathname = decodeURIComponent(target.pathname).replace(token, encodeURIComponent(value));
    } else {
      target.pathname = `${target.pathname.replace(/\/+$/, "")}/${encodeURIComponent(value)}`;
    }
  } else {
    target.searchParams.set(param, value);
  }

  return { targetUrl: target.toString(), init };
}

function detectEvidenceIndicator(
  payloadType: string,
  payload: string,
  text: string,
  baselineBody: string,
  statusCode: number,
  baselineStatus: number,
  elapsedMs: number,
  baselineElapsedMs: number
): { hit: boolean; sqlErrorDetected: boolean; reflectionFound: boolean; indicator: string } {
  const reflectionFound = text.includes(payload);
  let sqlErrorDetected = false;

  if (payloadType === "sqli") {
    for (const pat of SQL_ERROR_PATTERNS) {
      if (pat.test(text) && !pat.test(baselineBody)) {
        sqlErrorDetected = true;
        break;
      }
    }
    if (sqlErrorDetected) {
      return { hit: true, sqlErrorDetected: true, reflectionFound, indicator: "SQL Syntax Error Triggered" };
    }
    if (/SLEEP\(/i.test(payload) && elapsedMs - baselineElapsedMs >= 3500) {
      return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: `Time-Based SQLi Delay (${elapsedMs}ms vs ${baselineElapsedMs}ms baseline)` };
    }
  }

  if (payloadType === "xss" && reflectionFound) {
    return { hit: true, sqlErrorDetected: false, reflectionFound: true, indicator: "Raw Unencoded Reflection Detected" };
  }

  if (payloadType === "ssti" && /\b7\*7\b/.test(payload) && text.includes("49") && !baselineBody.includes("49")) {
    return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: "SSTI Arithmetic Evaluation Detected (7*7 -> 49)" };
  }

  if (payloadType === "traversal" && TRAVERSAL_MARKERS.some((re) => re.test(text) && !re.test(baselineBody))) {
    return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: "Arbitrary Local File Marker Exposed" };
  }

  if (payloadType === "cmd" && CMD_MARKERS.some((re) => re.test(text) && !re.test(baselineBody))) {
    return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: "OS Command Execution Output Detected" };
  }

  if (payloadType === "evasion") {
    const decoded = normalizeEvasion(payload).value;
    const hitEvasion = reflectionFound || (decoded.length > 0 && text.includes(decoded) && !baselineBody.includes(decoded));
    if (hitEvasion) {
      return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: "Evasion Payload Decoded or Reflected" };
    }
    if (SQL_ERROR_PATTERNS.some((re) => re.test(text) && !re.test(baselineBody))) {
      return { hit: true, sqlErrorDetected: true, reflectionFound, indicator: "SQL Error Triggered via Evasion Encoding" };
    }
  }

  if (payloadType === "smuggling") {
    const rawConf = inspectRawHttpResponse(text);
    if (!rawConf.ok && rawConf.poisoningVectors.length > 0) {
      return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: `HTTP Response Splitting / Poisoning (${rawConf.poisoningVectors[0]})` };
    }
    if (reflectionFound || text.includes("X-Wide-Smuggle")) {
      return { hit: true, sqlErrorDetected: false, reflectionFound: true, indicator: "HTTP Request Smuggling / CRLF Injection Reflected" };
    }
  }

  if (payloadType === "ssrf" && SSRF_MARKERS.some((re) => re.test(text) && !re.test(baselineBody))) {
    return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: "Internal Metadata Response Exposed via SSRF" };
  }

  if (statusCode === 500 && baselineStatus === 200) {
    return { hit: true, sqlErrorDetected: false, reflectionFound, indicator: "Server Internal Error (HTTP 500)" };
  }

  return { hit: false, sqlErrorDetected: false, reflectionFound, indicator: "Normal Response" };
}

export async function fuzzTargetEndpoint(
  url: string,
  param: string,
  payloadType: string,
  method = "GET",
  options: FuzzOptions = {}
): Promise<FuzzReport> {
  if (options.allowPrivate === false && !new NetworkPolicy({ allowPrivate: false }).allows(url)) {
    throw new Error(`Blocked by Wide SSRF NetworkPolicy: ${url}`);
  }
  const location: FuzzLocation = options.location || (method === "GET" || method === "HEAD" ? "query" : "form");
  const timeoutMs = options.timeoutMs || 10000;
  const payloads = payloadType.toLowerCase() === "idor"
    ? ["1", "2", "0"]
    : getPayloadsForType(payloadType);

  if (payloads.length === 0) {
    throw new Error(`Unsupported payload type: '${payloadType}'. Available: sqli, xss, ssrf, traversal, cmd, ssti, idor, evasion, smuggling.`);
  }

  const baseReq = buildRequest(url, param, "testbaselinevalue123", method, location, options.headers, timeoutMs);
  let baselineStatus = 200;
  let baselineBody = "";
  let baselineElapsedMs = 0;

  try {
    const t0 = Date.now();
    const baseRes = await fetch(baseReq.targetUrl, baseReq.init);
    baselineStatus = baseRes.status;
    baselineBody = await baseRes.text();
    baselineElapsedMs = Date.now() - t0;
  } catch (err: any) {
    throw new Error(`Baseline probe failed for ${url}: ${err.message}`);
  }

  const findings: FuzzFinding[] = [];

  if (payloadType.toLowerCase() === "idor" && options.compareHeaders) {
    const t0 = Date.now();
    const replayReq = buildRequest(url, param, "testbaselinevalue123", method, location, options.compareHeaders, timeoutMs);
    try {
      const replayRes = await fetch(replayReq.targetUrl, replayReq.init);
      const replayText = await replayRes.text();
      const elapsedMs = Date.now() - t0;
      if (baselineStatus >= 200 && baselineStatus < 300 && replayRes.status >= 200 && replayRes.status < 300 && replayText === baselineBody && baselineBody.length > 0) {
        findings.push({
          payload: "auth-context-replay",
          statusCode: replayRes.status,
          reflectionFound: false,
          sqlErrorDetected: false,
          lengthDiff: 0,
          elapsedMs,
          indicator: "Differential Access Control Failure (secondary credentials received identical 2xx resource body)"
        });
      }
    } catch {}
  }

  for (const payload of payloads) {
    if (payloadType.toLowerCase() === "idor") break;
    const req = buildRequest(url, param, payload, method, location, options.headers, timeoutMs);
    try {
      const t0 = Date.now();
      const res = await fetch(req.targetUrl, req.init);
      const text = await res.text();
      const elapsedMs = Date.now() - t0;
      const lengthDiff = Math.abs(text.length - baselineBody.length);
      const ev = detectEvidenceIndicator(payloadType.toLowerCase(), payload, text, baselineBody, res.status, baselineStatus, elapsedMs, baselineElapsedMs);

      if (ev.hit) {
        findings.push({
          payload,
          statusCode: res.status,
          reflectionFound: ev.reflectionFound,
          sqlErrorDetected: ev.sqlErrorDetected,
          lengthDiff,
          elapsedMs,
          indicator: ev.indicator
        });
      }
    } catch {}
  }

  const isVulnerable = findings.length > 0;
  const summary = isVulnerable
    ? `Endpoint ${url} parameter '${param}' (${location}) appears VULNERABLE to ${payloadType.toUpperCase()}. ${findings.length} anomalies confirmed.`
    : `Endpoint ${url} parameter '${param}' (${location}) tested with ${payloads.length} ${payloadType.toUpperCase()} payloads. No high-confidence anomalies triggered.`;

  return {
    url,
    param,
    payloadType,
    location,
    baselineStatus,
    baselineLength: baselineBody.length,
    baselineElapsedMs,
    findings,
    isVulnerable,
    summary
  };
}
