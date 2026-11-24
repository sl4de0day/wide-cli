export type ZoneName = "url" | "args" | "body" | "header" | "file" | "json";
export type ZonePart = "name" | "value" | "raw" | "path";

export interface EvasionSignals {
  leftoverPercent: boolean;
  invalidPercent: boolean;
  percentUEscape: boolean;
  nullByte: boolean;
  invalidUtf8: boolean;
  overlongUtf8: boolean;
}

export interface InspectedField {
  zone: ZoneName;
  part: ZonePart;
  name: string;
  value: string;
  rawValue: string;
  signals: EvasionSignals;
}

export interface ZoneWalkResult {
  fields: InspectedField[];
  signals: EvasionSignals;
  uninspected: string | null;
}

export function emptySignals(): EvasionSignals {
  return {
    leftoverPercent: false,
    invalidPercent: false,
    percentUEscape: false,
    nullByte: false,
    invalidUtf8: false,
    overlongUtf8: false,
  };
}

export function mergeSignals(a: EvasionSignals, b: EvasionSignals): EvasionSignals {
  return {
    leftoverPercent: a.leftoverPercent || b.leftoverPercent,
    invalidPercent: a.invalidPercent || b.invalidPercent,
    percentUEscape: a.percentUEscape || b.percentUEscape,
    nullByte: a.nullByte || b.nullByte,
    invalidUtf8: a.invalidUtf8 || b.invalidUtf8,
    overlongUtf8: a.overlongUtf8 || b.overlongUtf8,
  };
}

export function evasionWeight(s: EvasionSignals): number {
  let n = 0;
  if (s.leftoverPercent) n += 1;
  if (s.invalidPercent) n += 1;
  if (s.percentUEscape) n += 1;
  return n;
}

export function mustRejectSignals(s: EvasionSignals): boolean {
  return s.invalidUtf8 || s.overlongUtf8 || s.nullByte;
}

function hexVal(code: number): number | null {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return null;
}

function validateUtf8Bytes(bytes: Uint8Array): { invalid: boolean; overlong: boolean } {
  let invalid = false;
  let overlong = false;
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      i += 1;
      continue;
    }
    if (b0 < 0xc2) {
      if (b0 >= 0xc0) overlong = true;
      else invalid = true;
      i += 1;
      continue;
    }
    const len = b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : b0 < 0xf5 ? 4 : 0;
    if (len === 0) {
      invalid = true;
      i += 1;
      continue;
    }
    if (i + len > bytes.length) {
      invalid = true;
      break;
    }
    let ok = true;
    for (let k = 1; k < len; k += 1) {
      if ((bytes[i + k] & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      invalid = true;
      i += 1;
      continue;
    }
    if (len === 3) {
      if (b0 === 0xe0 && bytes[i + 1] < 0xa0) overlong = true;
      if (b0 === 0xed && bytes[i + 1] >= 0xa0) invalid = true;
    } else if (len === 4) {
      if (b0 === 0xf0 && bytes[i + 1] < 0x90) overlong = true;
      if (b0 === 0xf4 && bytes[i + 1] >= 0x90) invalid = true;
    }
    i += len;
  }
  return { invalid, overlong };
}

export function normalizeEvasion(
  src: string,
  opts: { plusIsSpace?: boolean; foldCase?: boolean } = {},
): { value: string; bytes: Uint8Array; signals: EvasionSignals } {
  const sig = emptySignals();
  const srcBytes = Buffer.from(src, "utf8");
  const out = new Uint8Array(srcBytes.length);
  let n = 0;
  let i = 0;

  while (i < srcBytes.length) {
    const c = srcBytes[i];
    if (c !== 0x25) {
      out[n] = opts.plusIsSpace && c === 0x2b ? 0x20 : c;
      n += 1;
      i += 1;
      continue;
    }
    if (i + 1 < srcBytes.length && (srcBytes[i + 1] === 0x75 || srcBytes[i + 1] === 0x55)) {
      sig.percentUEscape = true;
      out[n] = c;
      n += 1;
      i += 1;
      continue;
    }
    if (i + 2 < srcBytes.length) {
      const hi = hexVal(srcBytes[i + 1]);
      const lo = hexVal(srcBytes[i + 2]);
      if (hi !== null && lo !== null) {
        out[n] = (hi << 4) | lo;
        n += 1;
        i += 3;
        continue;
      }
    }
    sig.invalidPercent = true;
    out[n] = c;
    n += 1;
    i += 1;
  }

  const sliced = out.subarray(0, n);
  for (let k = 0; k + 2 < sliced.length; k += 1) {
    if (sliced[k] === 0x25 && hexVal(sliced[k + 1]) !== null && hexVal(sliced[k + 2]) !== null) {
      sig.leftoverPercent = true;
      break;
    }
  }
  for (let k = 0; k < sliced.length; k += 1) {
    if (sliced[k] === 0) {
      sig.nullByte = true;
      break;
    }
  }
  const utf8 = validateUtf8Bytes(sliced);
  sig.invalidUtf8 = utf8.invalid;
  sig.overlongUtf8 = utf8.overlong;

  if (opts.foldCase !== false) {
    for (let k = 0; k < sliced.length; k += 1) {
      if (sliced[k] >= 0x41 && sliced[k] <= 0x5a) sliced[k] |= 0x20;
    }
  }

  const value = Buffer.from(sliced).toString(utf8.invalid ? "latin1" : "utf8");
  return { value, bytes: sliced, signals: sig };
}

function parseFormPairs(raw: string): Array<[string, string]> {
  if (!raw) return [];
  return raw.split("&").map((seg) => {
    const eq = seg.indexOf("=");
    if (eq < 0) return [seg, ""];
    return [seg.slice(0, eq), seg.slice(eq + 1)];
  });
}

function flattenJson(val: unknown, prefix: string, emit: (path: string, leaf: string) => void, depth = 0): void {
  if (depth > 32 || val === null || val === undefined) return;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    emit(prefix || "$", String(val));
    return;
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < Math.min(val.length, 64); i += 1) {
      flattenJson(val[i], `${prefix}[${i}]`, emit, depth + 1);
    }
    return;
  }
  if (typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const nextPath = prefix ? `${prefix}.${k}` : k;
      flattenJson(v, nextPath, emit, depth + 1);
    }
  }
}

function parseMultipart(contentType: string, body: string): { pairs: Array<[string, string, string?]>; malformed: boolean } {
  const m = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  if (!m) return { pairs: [], malformed: true };
  const boundary = m[1] || m[2];
  if (!boundary) return { pairs: [], malformed: true };
  const delim = `--${boundary}`;
  const chunks = body.split(delim);
  if (chunks.length < 2) return { pairs: [], malformed: true };

  const pairs: Array<[string, string, string?]> = [];
  for (let i = 1; i < chunks.length; i += 1) {
    const part = chunks[i];
    if (part.startsWith("--")) break;
    const trimmed = part.startsWith("\r\n") ? part.slice(2) : part.startsWith("\n") ? part.slice(1) : part;
    const sep = trimmed.includes("\r\n\r\n") ? "\r\n\r\n" : trimmed.includes("\n\n") ? "\n\n" : "";
    if (!sep) continue;
    const splitAt = trimmed.indexOf(sep);
    const hdrText = trimmed.slice(0, splitAt);
    const valRaw = trimmed.slice(splitAt + sep.length).replace(/\r?\n$/, "");
    const nameMatch = hdrText.match(/\bname="([^"]*)"/i);
    const fileMatch = hdrText.match(/\bfilename="([^"]*)"/i);
    const name = nameMatch ? nameMatch[1] : "";
    if (fileMatch) {
      pairs.push([name, valRaw, fileMatch[1]]);
    } else {
      pairs.push([name, valRaw]);
    }
  }
  return { pairs, malformed: false };
}

export function extractHttpZones(input: {
  url: string;
  headers?: Array<[string, string]> | Record<string, string>;
  body?: string;
}): ZoneWalkResult {
  const fields: InspectedField[] = [];
  let aggSignals = emptySignals();
  let uninspected: string | null = null;

  const pushNormalized = (zone: ZoneName, part: ZonePart, name: string, rawVal: string, plusIsSpace: boolean) => {
    const dec = normalizeEvasion(rawVal, { plusIsSpace, foldCase: false });
    aggSignals = mergeSignals(aggSignals, dec.signals);
    fields.push({ zone, part, name, value: dec.value, rawValue: rawVal, signals: dec.signals });
    if (fields.length > 512 && !uninspected) uninspected = "too_many_fields";
  };

  const hdrEntries: Array<[string, string]> = Array.isArray(input.headers)
    ? input.headers
    : Object.entries(input.headers || {});

  let contentType = "";
  for (const [k, v] of hdrEntries) {
    if (String(k).toLowerCase() === "content-type") contentType = String(v || "");
    pushNormalized("header", "name", k, k, false);
    pushNormalized("header", "value", k.toLowerCase(), String(v ?? ""), false);
  }

  let pathname = input.url;
  let rawQuery = "";
  const qIdx = input.url.indexOf("?");
  if (/^https?:\/\//i.test(input.url)) {
    try {
      const parsed = new URL(input.url);
      pathname = parsed.pathname || "/";
      rawQuery = qIdx >= 0 ? input.url.slice(qIdx + 1) : "";
    } catch {}
  } else if (qIdx >= 0) {
    pathname = input.url.slice(0, qIdx);
    rawQuery = input.url.slice(qIdx + 1);
  }

  pushNormalized("url", "value", "", pathname, false);

  for (const [k, v] of parseFormPairs(rawQuery)) {
    const keyDec = normalizeEvasion(k, { plusIsSpace: true, foldCase: false });
    aggSignals = mergeSignals(aggSignals, keyDec.signals);
    fields.push({ zone: "args", part: "name", name: keyDec.value, value: keyDec.value, rawValue: k, signals: keyDec.signals });
    pushNormalized("args", "value", keyDec.value, v, true);
  }

  const body = input.body || "";
  if (body.length > 0) {
    const ctLower = contentType.toLowerCase();
    if (ctLower.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of parseFormPairs(body)) {
        const keyDec = normalizeEvasion(k, { plusIsSpace: true, foldCase: false });
        aggSignals = mergeSignals(aggSignals, keyDec.signals);
        fields.push({ zone: "body", part: "name", name: keyDec.value, value: keyDec.value, rawValue: k, signals: keyDec.signals });
        pushNormalized("body", "value", keyDec.value, v, true);
      }
    } else if (ctLower.includes("multipart/form-data")) {
      const mp = parseMultipart(contentType, body);
      if (mp.malformed) {
        uninspected = "malformed_multipart";
      } else {
        for (const [k, v, fname] of mp.pairs) {
          if (fname !== undefined) {
            pushNormalized("file", "name", k, fname, false);
          } else {
            pushNormalized("body", "name", k, k, false);
            pushNormalized("body", "value", k, v, false);
          }
        }
      }
    } else if (ctLower.includes("application/json") || ctLower.includes("+json") || ctLower.includes("application/csp-report")) {
      try {
        const parsedJson = JSON.parse(body);
        flattenJson(parsedJson, "", (jsonPath, leafVal) => {
          pushNormalized("json", "path", jsonPath, leafVal, false);
        });
      } catch {
        uninspected = "malformed_json";
        pushNormalized("body", "raw", "", body, false);
      }
    } else {
      if (!contentType) uninspected = "unknown_content_type";
      pushNormalized("body", "raw", "", body, false);
    }
  }

  return { fields, signals: aggSignals, uninspected };
}
