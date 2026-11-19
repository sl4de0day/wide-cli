export type HttpConformanceError =
  | "Incomplete"
  | "HeadTooLarge"
  | "MalformedRequestLine"
  | "MalformedStatusLine"
  | "BareCrLf"
  | "UnsupportedVersion"
  | "MethodTooLong"
  | "InvalidMethodToken"
  | "UriTooLong"
  | "InvalidUriChar"
  | "TooManyHeaders"
  | "HeaderNameTooLong"
  | "HeaderValueTooLong"
  | "InvalidHeaderToken"
  | "InvalidHeaderName"
  | "InvalidHeaderValue"
  | "SpaceBeforeColon"
  | "ObsoleteLineFolding"
  | "MissingHost"
  | "DuplicateHost"
  | "DuplicateContentLength"
  | "InvalidContentLength"
  | "AmbiguousFraming"
  | "InvalidTransferEncoding"
  | "InvalidChunkSize"
  | "ChunkExtensionNotAllowed"
  | "TooManyChunks"
  | "ChunkTooLarge"
  | "BodyTooLarge"
  | "TrailerNotAllowed"
  | "UnexpectedUpgrade"
  | "ResponseSplitting"
  | "TrailingPoisonBytes"
  | "BareControlChar"
  | "InvalidStatusCode"
  | "MalformedHeader";

export interface HttpConformanceHeader {
  name: string;
  value: string;
}

export type HttpFraming =
  | { kind: "none" }
  | { kind: "length"; length: number }
  | { kind: "chunked" }
  | { kind: "until_close" };

export interface RequestConformanceReport {
  ok: boolean;
  error?: HttpConformanceError;
  method?: string;
  target?: string;
  version?: "HTTP/1.0" | "HTTP/1.1";
  headers?: HttpConformanceHeader[];
  framing?: HttpFraming;
  host?: string;
  connectionClose?: boolean;
  headEnd?: number;
  bodyDecoded?: string;
  smugglingVectors: string[];
}

export interface ResponseConformanceReport {
  ok: boolean;
  error?: HttpConformanceError;
  version?: "HTTP/1.0" | "HTTP/1.1";
  status?: number;
  reason?: string;
  headers?: HttpConformanceHeader[];
  framing?: HttpFraming;
  poisoningVectors: string[];
}

const HEAD_BYTES_MAX = 65536;
const HEADER_COUNT_MAX = 128;
const METHOD_BYTES_MAX = 16;
const URI_BYTES_MAX = 16384;
const HEADER_NAME_MAX = 256;
const HEADER_VALUE_MAX = 16384;
const CHUNK_COUNT_MAX = 1024;
const CHUNK_HEADER_MAX = 64;

const TCHAR_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isValidTargetChar(code: number): boolean {
  return code >= 0x21 && code <= 0x7e && code !== 0x7f;
}

function isValidHeaderValue(val: string): boolean {
  for (let i = 0; i < val.length; i += 1) {
    const c = val.charCodeAt(i);
    if (c === 0x09) continue;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function scanRequestHead(buf: Buffer): { end: number } | { error: HttpConformanceError } {
  const limit = Math.min(buf.length, HEAD_BYTES_MAX);
  const truncated = limit < buf.length;
  let lineStart = 0;

  for (let i = 0; i < limit; i += 1) {
    const c = buf[i];
    if (c === 0x0a) return { error: "BareCrLf" };
    if (c !== 0x0d) continue;
    if (i + 1 >= limit) return { error: truncated ? "HeadTooLarge" : "Incomplete" };
    if (buf[i + 1] !== 0x0a) return { error: "BareCrLf" };
    const lineLen = i - lineStart;
    i += 1;
    lineStart = i + 1;
    if (lineLen === 0) return { end: lineStart };
  }
  if (buf.length >= HEAD_BYTES_MAX) return { error: "HeadTooLarge" };
  return { error: "Incomplete" };
}

function parseUintStrict(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  if (s.length > 16) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export function decodeChunkedBodyStrict(rawBuf: Buffer): { ok: true; body: Buffer; consumed: number } | { ok: false; error: HttpConformanceError } {
  let pos = 0;
  let chunks = 0;
  const parts: Buffer[] = [];
  let total = 0;

  while (true) {
    if (chunks >= CHUNK_COUNT_MAX) return { ok: false, error: "TooManyChunks" };
    const crlf = rawBuf.indexOf("\r\n", pos, "latin1");
    if (crlf < 0) {
      if (rawBuf.indexOf(0x0a, pos) >= 0) return { ok: false, error: "BareCrLf" };
      return { ok: false, error: "Incomplete" };
    }
    const line = rawBuf.subarray(pos, crlf).toString("latin1");
    if (line.length === 0 || line.length > CHUNK_HEADER_MAX) return { ok: false, error: "InvalidChunkSize" };
    if (line.includes("\n")) return { ok: false, error: "BareCrLf" };
    if (line.includes(";")) return { ok: false, error: "ChunkExtensionNotAllowed" };
    if (!/^[0-9a-fA-F]+$/.test(line)) return { ok: false, error: "InvalidChunkSize" };
    const size = Number.parseInt(line, 16);
    if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024) return { ok: false, error: "ChunkTooLarge" };

    pos = crlf + 2;
    chunks += 1;

    if (size === 0) {
      if (pos + 2 > rawBuf.length) return { ok: false, error: "Incomplete" };
      if (rawBuf[pos] !== 0x0d || rawBuf[pos + 1] !== 0x0a) return { ok: false, error: "TrailerNotAllowed" };
      return { ok: true, body: Buffer.concat(parts), consumed: pos + 2 };
    }

    const dataEnd = pos + size;
    if (dataEnd + 2 > rawBuf.length) return { ok: false, error: "Incomplete" };
    total += size;
    if (total > 16 * 1024 * 1024) return { ok: false, error: "BodyTooLarge" };
    parts.push(rawBuf.subarray(pos, dataEnd));
    if (rawBuf[dataEnd] !== 0x0d || rawBuf[dataEnd + 1] !== 0x0a) return { ok: false, error: "InvalidChunkSize" };
    pos = dataEnd + 2;
  }
}

export function inspectRawHttpRequest(rawInput: string | Buffer): RequestConformanceReport {
  const buf = typeof rawInput === "string" ? Buffer.from(rawInput, "latin1") : rawInput;
  const scanned = scanRequestHead(buf);
  if ("error" in scanned) {
    return { ok: false, error: scanned.error, smugglingVectors: [scanned.error] };
  }

  const headStr = buf.subarray(0, scanned.end - 2).toString("latin1");
  const lines = headStr.split("\r\n");
  const reqLine = lines[0] ?? "";
  const sp1 = reqLine.indexOf(" ");
  if (sp1 < 0) return { ok: false, error: "MalformedRequestLine", smugglingVectors: ["MalformedRequestLine"] };
  const method = reqLine.slice(0, sp1);
  const rest = reqLine.slice(sp1 + 1);
  const sp2 = rest.indexOf(" ");
  if (sp2 < 0) return { ok: false, error: "MalformedRequestLine", smugglingVectors: ["MalformedRequestLine"] };
  const target = rest.slice(0, sp2);
  const versionStr = rest.slice(sp2 + 1);

  if (!method) return { ok: false, error: "MalformedRequestLine", smugglingVectors: ["MalformedRequestLine"] };
  if (method.length > METHOD_BYTES_MAX) return { ok: false, error: "MethodTooLong", smugglingVectors: ["MethodTooLong"] };
  if (!TCHAR_RE.test(method)) return { ok: false, error: "InvalidMethodToken", smugglingVectors: ["InvalidMethodToken"] };

  if (!target) return { ok: false, error: "MalformedRequestLine", smugglingVectors: ["MalformedRequestLine"] };
  if (target.length > URI_BYTES_MAX) return { ok: false, error: "UriTooLong", smugglingVectors: ["UriTooLong"] };
  for (let i = 0; i < target.length; i += 1) {
    if (!isValidTargetChar(target.charCodeAt(i))) {
      return { ok: false, error: "InvalidUriChar", smugglingVectors: ["InvalidUriChar"] };
    }
  }

  if (versionStr !== "HTTP/1.1" && versionStr !== "HTTP/1.0") {
    return { ok: false, error: "UnsupportedVersion", smugglingVectors: ["UnsupportedVersion"] };
  }

  const headers: HttpConformanceHeader[] = [];
  let host: string | undefined;
  let contentLength: number | null = null;
  let hasTe = false;
  let teChunked = false;
  let connectionClose = false;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (line[0] === " " || line[0] === "\t") {
      return { ok: false, error: "ObsoleteLineFolding", smugglingVectors: ["ObsoleteLineFolding"] };
    }
    if (headers.length >= HEADER_COUNT_MAX) {
      return { ok: false, error: "TooManyHeaders", smugglingVectors: ["TooManyHeaders"] };
    }
    const colon = line.indexOf(":");
    if (colon < 0) return { ok: false, error: "InvalidHeaderToken", smugglingVectors: ["InvalidHeaderToken"] };
    const name = line.slice(0, colon);
    if (!name) return { ok: false, error: "InvalidHeaderToken", smugglingVectors: ["InvalidHeaderToken"] };
    if (name.length > HEADER_NAME_MAX) return { ok: false, error: "HeaderNameTooLong", smugglingVectors: ["HeaderNameTooLong"] };
    if (name[name.length - 1] === " " || name[name.length - 1] === "\t") {
      return { ok: false, error: "SpaceBeforeColon", smugglingVectors: ["SpaceBeforeColon"] };
    }
    if (!TCHAR_RE.test(name)) return { ok: false, error: "InvalidHeaderToken", smugglingVectors: ["InvalidHeaderToken"] };

    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (value.length > HEADER_VALUE_MAX) return { ok: false, error: "HeaderValueTooLong", smugglingVectors: ["HeaderValueTooLong"] };
    if (!isValidHeaderValue(value)) return { ok: false, error: "InvalidHeaderToken", smugglingVectors: ["InvalidHeaderToken"] };

    headers.push({ name, value });
    const lower = name.toLowerCase();
    if (lower === "host") {
      if (host !== undefined) return { ok: false, error: "DuplicateHost", smugglingVectors: ["DuplicateHost"] };
      host = value;
    } else if (lower === "content-length") {
      const n = parseUintStrict(value);
      if (n === null) return { ok: false, error: "InvalidContentLength", smugglingVectors: ["InvalidContentLength"] };
      if (contentLength !== null) {
        return { ok: false, error: "DuplicateContentLength", smugglingVectors: ["DuplicateContentLength"] };
      }
      contentLength = n;
    } else if (lower === "transfer-encoding") {
      if (hasTe) return { ok: false, error: "InvalidTransferEncoding", smugglingVectors: ["InvalidTransferEncoding"] };
      hasTe = true;
      if (value.toLowerCase() !== "chunked") {
        return { ok: false, error: "InvalidTransferEncoding", smugglingVectors: ["InvalidTransferEncoding"] };
      }
      teChunked = true;
    } else if (lower === "connection") {
      const toks = value.split(",").map((s) => s.trim().toLowerCase());
      if (toks.includes("close")) connectionClose = true;
    }
  }

  if (hasTe && contentLength !== null) {
    return { ok: false, error: "AmbiguousFraming", smugglingVectors: ["AmbiguousFraming"] };
  }
  if (versionStr === "HTTP/1.1" && host === undefined) {
    return { ok: false, error: "MissingHost", smugglingVectors: ["MissingHost"] };
  }

  const framing: HttpFraming = hasTe && teChunked
    ? { kind: "chunked" }
    : contentLength !== null && contentLength > 0
      ? { kind: "length", length: contentLength }
      : { kind: "none" };

  let bodyDecoded: string | undefined;
  if (framing.kind === "chunked" && buf.length > scanned.end) {
    const ch = decodeChunkedBodyStrict(buf.subarray(scanned.end));
    if (!ch.ok) return { ok: false, error: ch.error, smugglingVectors: [ch.error] };
    if (scanned.end + ch.consumed < buf.length) {
      return { ok: false, error: "TrailingPoisonBytes", smugglingVectors: ["TrailingPoisonBytes"] };
    }
    bodyDecoded = ch.body.toString("utf8");
  }

  return {
    ok: true,
    method,
    target,
    version: versionStr,
    headers,
    framing,
    host,
    connectionClose,
    headEnd: scanned.end,
    bodyDecoded,
    smugglingVectors: [],
  };
}

export function inspectRawHttpResponse(rawInput: string | Buffer, requestMethod = "GET"): ResponseConformanceReport {
  const buf = typeof rawInput === "string" ? Buffer.from(rawInput, "latin1") : rawInput;
  const limit = Math.min(buf.length, HEAD_BYTES_MAX);
  let headEnd = -1;
  for (let i = 0; i < limit; i += 1) {
    const c = buf[i];
    if (c === 0x0a) return { ok: false, error: "BareControlChar", poisoningVectors: ["BareControlChar"] };
    if (c !== 0x0d) continue;
    if (i + 1 >= limit) return { ok: false, error: "Incomplete", poisoningVectors: ["Incomplete"] };
    if (buf[i + 1] !== 0x0a) return { ok: false, error: "BareControlChar", poisoningVectors: ["BareControlChar"] };
    if (i + 3 < limit && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      headEnd = i + 4;
      break;
    }
    if (i + 2 < limit && buf[i + 2] === 0x0a) {
      return { ok: false, error: "BareControlChar", poisoningVectors: ["BareControlChar"] };
    }
    i += 1;
  }
  if (headEnd < 0) return { ok: false, error: "Incomplete", poisoningVectors: ["Incomplete"] };

  const headStr = buf.subarray(0, headEnd - 2).toString("latin1");
  const lines = headStr.split("\r\n").filter((l, idx) => idx === 0 || l.length > 0);
  const statusLine = lines[0] ?? "";
  if (statusLine.length < 12 || !statusLine.startsWith("HTTP/") || statusLine[8] !== " ") {
    return { ok: false, error: "MalformedStatusLine", poisoningVectors: ["MalformedStatusLine"] };
  }
  const versionStr = statusLine.slice(0, 8);
  if (versionStr !== "HTTP/1.1" && versionStr !== "HTTP/1.0") {
    return { ok: false, error: "UnsupportedVersion", poisoningVectors: ["UnsupportedVersion"] };
  }
  const codeText = statusLine.slice(9, 12);
  if (!/^\d{3}$/.test(codeText)) {
    return { ok: false, error: "InvalidStatusCode", poisoningVectors: ["InvalidStatusCode"] };
  }
  const status = Number(codeText);
  const reason = statusLine.length > 13 ? statusLine.slice(13) : "";

  const headers: HttpConformanceHeader[] = [];
  let hasTe = false;
  let teChunked = false;
  let contentLength: number | null = null;
  let hasUpgrade = false;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon <= 0) return { ok: false, error: "MalformedHeader", poisoningVectors: ["MalformedHeader"] };
    const name = line.slice(0, colon);
    if (!TCHAR_RE.test(name)) return { ok: false, error: "InvalidHeaderName", poisoningVectors: ["InvalidHeaderName"] };
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (!isValidHeaderValue(value)) return { ok: false, error: "InvalidHeaderValue", poisoningVectors: ["InvalidHeaderValue"] };
    headers.push({ name, value });
    const lower = name.toLowerCase();
    if (lower === "content-length") {
      const n = parseUintStrict(value);
      if (n === null) return { ok: false, error: "InvalidContentLength", poisoningVectors: ["InvalidContentLength"] };
      if (contentLength !== null) return { ok: false, error: "DuplicateContentLength", poisoningVectors: ["DuplicateContentLength"] };
      contentLength = n;
    } else if (lower === "transfer-encoding") {
      if (hasTe) return { ok: false, error: "InvalidTransferEncoding", poisoningVectors: ["InvalidTransferEncoding"] };
      hasTe = true;
      if (value.toLowerCase() !== "chunked") {
        return { ok: false, error: "InvalidTransferEncoding", poisoningVectors: ["InvalidTransferEncoding"] };
      }
      teChunked = true;
    } else if (lower === "upgrade") {
      hasUpgrade = true;
    }
  }

  if (status === 101 || (status < 200 && hasUpgrade)) {
    return { ok: false, error: "UnexpectedUpgrade", poisoningVectors: ["UnexpectedUpgrade"] };
  }
  if (hasTe && contentLength !== null) {
    return { ok: false, error: "AmbiguousFraming", poisoningVectors: ["AmbiguousFraming"] };
  }

  const isBodiless = requestMethod.toUpperCase() === "HEAD" || (status >= 100 && status <= 199) || status === 204 || status === 304;
  const framing: HttpFraming = isBodiless
    ? { kind: "none" }
    : hasTe && teChunked
      ? { kind: "chunked" }
      : contentLength !== null
        ? contentLength === 0
          ? { kind: "none" }
          : { kind: "length", length: contentLength }
        : { kind: "until_close" };

  const poisoningVectors: string[] = [];
  if (framing.kind === "length" && buf.length > headEnd + framing.length) {
    poisoningVectors.push("TrailingPoisonBytes");
  }
  if (framing.kind === "none" && buf.length > headEnd) {
    poisoningVectors.push("TrailingPoisonBytes");
  }
  if (poisoningVectors.length > 0) {
    return { ok: false, error: "TrailingPoisonBytes", version: versionStr, status, reason, headers, framing, poisoningVectors };
  }

  return { ok: true, version: versionStr, status, reason, headers, framing, poisoningVectors };
}

export function inspectHttpHeadersSmuggling(headers: Array<[string, string]>): string[] {
  const findings: string[] = [];
  let hostCount = 0;
  let clCount = 0;
  let teCount = 0;
  let teValue = "";

  for (const [rawName, rawVal] of headers || []) {
    const name = String(rawName || "");
    const val = String(rawVal ?? "");
    if (!name || /[ \t]$/.test(name) || !TCHAR_RE.test(name)) {
      findings.push(`InvalidHeaderToken:${name}`);
    }
    if (/[\r\n\0]/.test(val) || !isValidHeaderValue(val)) {
      findings.push(`ResponseSplitting:${name}`);
    }
    const lower = name.toLowerCase();
    if (lower === "host") hostCount += 1;
    if (lower === "content-length") {
      clCount += 1;
      if (parseUintStrict(val.trim()) === null) findings.push("InvalidContentLength");
    }
    if (lower === "transfer-encoding") {
      teCount += 1;
      teValue = val.trim().toLowerCase();
      if (teValue !== "chunked") findings.push("InvalidTransferEncoding");
    }
  }

  if (hostCount > 1) findings.push("DuplicateHost");
  if (clCount > 1) findings.push("DuplicateContentLength");
  if (teCount > 1) findings.push("InvalidTransferEncoding");
  if (clCount > 0 && teCount > 0) findings.push("AmbiguousFraming");

  return Array.from(new Set(findings));
}
