import { getPayloadsForType } from "./payloads.js";

export interface FuzzFinding {
  payload: string;
  statusCode: number;
  reflectionFound: boolean;
  sqlErrorDetected: boolean;
  lengthDiff: number;
  indicator: string;
}

export interface FuzzReport {
  url: string;
  param: string;
  payloadType: string;
  baselineStatus: number;
  baselineLength: number;
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

export async function fuzzTargetEndpoint(
  url: string,
  param: string,
  payloadType: string,
  method = "GET"
): Promise<FuzzReport> {
  const payloads = getPayloadsForType(payloadType);
  if (payloads.length === 0) {
    throw new Error(`Unsupported payload type: '${payloadType}'. Available: sqli, xss, ssrf, traversal, cmd, ssti.`);
  }

  const baselineUrl = new URL(url);
  if (method === "GET") {
    baselineUrl.searchParams.set(param, "testbaselinevalue123");
  }

  let baselineStatus = 200;
  let baselineBody = "";
  try {
    const baseRes = await fetch(baselineUrl.toString(), {
      method,
      headers: { "User-Agent": "Wide-Security-Agent/1.0" }
    });
    baselineStatus = baseRes.status;
    baselineBody = await baseRes.text();
  } catch (err: any) {
    throw new Error(`Baseline probe failed for ${url}: ${err.message}`);
  }

  const findings: FuzzFinding[] = [];

  for (const payload of payloads) {
    const targetUrl = new URL(url);
    const fetchOptions: RequestInit = {
      method,
      headers: { "User-Agent": "Wide-Security-Agent/1.0" }
    };

    if (method === "GET") {
      targetUrl.searchParams.set(param, payload);
    } else {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        "Content-Type": "application/x-www-form-urlencoded"
      };
      const bodyParams = new URLSearchParams();
      bodyParams.set(param, payload);
      fetchOptions.body = bodyParams.toString();
    }

    try {
      const res = await fetch(targetUrl.toString(), fetchOptions);
      const text = await res.text();
      const lengthDiff = Math.abs(text.length - baselineBody.length);
      const reflectionFound = text.includes(payload);

      let sqlErrorDetected = false;
      if (payloadType === "sqli") {
        for (const pattern of SQL_ERROR_PATTERNS) {
          if (pattern.test(text) && !pattern.test(baselineBody)) {
            sqlErrorDetected = true;
            break;
          }
        }
      }

      let indicator = "Normal Response";
      if (sqlErrorDetected) {
        indicator = "SQL Syntax Error Triggered";
      } else if (reflectionFound && payloadType === "xss") {
        indicator = "Raw Unencoded Reflection Detected";
      } else if (res.status === 500 && baselineStatus === 200) {
        indicator = "Server Internal Error (HTTP 500)";
      } else if (lengthDiff > 500) {
        indicator = `Significant Response Size Anomaly (${lengthDiff} bytes diff)`;
      }

      if (sqlErrorDetected || (reflectionFound && payloadType === "xss") || (res.status === 500 && baselineStatus === 200)) {
        findings.push({
          payload,
          statusCode: res.status,
          reflectionFound,
          sqlErrorDetected,
          lengthDiff,
          indicator
        });
      }
    } catch {
    }
  }

  const isVulnerable = findings.length > 0;
  const summary = isVulnerable
    ? `Endpoint ${url} parameter '${param}' appears VULNERABLE to ${payloadType.toUpperCase()}. ${findings.length} anomalies confirmed.`
    : `Endpoint ${url} parameter '${param}' tested with ${payloads.length} ${payloadType.toUpperCase()} payloads. No high-confidence anomalies triggered.`;

  return {
    url,
    param,
    payloadType,
    baselineStatus,
    baselineLength: baselineBody.length,
    findings,
    isVulnerable,
    summary
  };
}
