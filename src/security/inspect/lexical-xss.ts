import { XSS_BLACK_ATTRS, XSS_BLACK_EVENTS, XSS_BLACK_TAGS } from "./libinjection-tables.js";

type XssTokenType =
  | "DATA_TEXT"
  | "TAG_NAME_OPEN"
  | "TAG_NAME_CLOSE"
  | "TAG_NAME_SELFCLOSE"
  | "TAG_CLOSE"
  | "ATTR_NAME"
  | "ATTR_VALUE"
  | "TAG_COMMENT"
  | "DOCTYPE";

export type Html5Context =
  | "data"
  | "value_no_quote"
  | "value_single_quote"
  | "value_double_quote"
  | "value_back_quote";

type HtmlState =
  | "eof"
  | "data"
  | "tag_open"
  | "end_tag_open"
  | "tag_name"
  | "tag_name_close"
  | "self_closing_start_tag"
  | "before_attribute_name"
  | "attribute_name"
  | "after_attribute_name"
  | "before_attribute_value"
  | "attribute_value_double_quote"
  | "attribute_value_single_quote"
  | "attribute_value_back_quote"
  | "attribute_value_no_quote"
  | "after_attribute_value_quoted"
  | "comment"
  | "cdata"
  | "bogus_comment"
  | "bogus_comment2"
  | "markup_declaration_open"
  | "doctype";

function isWhite(c: number): boolean {
  return c === 0 || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d;
}

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

class Html5Tokenizer {
  readonly s: Buffer;
  pos = 0;
  state: HtmlState;
  isClose = false;
  tokenType: XssTokenType = "DATA_TEXT"; // wide-ignore wide/secret-assignment
  tokenValue: Buffer = Buffer.alloc(0);

  constructor(buf: Buffer, ctx: Html5Context) {
    this.s = buf;
    this.state =
      ctx === "data"
        ? "data"
        : ctx === "value_no_quote"
          ? "before_attribute_name"
          : ctx === "value_single_quote"
            ? "attribute_value_single_quote"
            : ctx === "value_double_quote"
              ? "attribute_value_double_quote"
              : "attribute_value_back_quote";
  }

  private emit(t: XssTokenType, start: number, len: number): boolean {
    this.tokenType = t;
    this.tokenValue = this.s.subarray(start, start + len);
    return true;
  }

  private skipWhite(): number | null {
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (isWhite(c)) {
        this.pos += 1;
      } else {
        return c;
      }
    }
    return null;
  }

  next(): boolean {
    let budget = 8 * (this.s.length + 4);
    while (budget > 0) {
      budget -= 1;
      if (this.state === "eof") return false;
      const step = this.stepState();
      if (step !== null) return step;
    }
    this.state = "eof";
    return false;
  }

  private stepState(): boolean | null {
    const s = this.s;
    switch (this.state) {
      case "data": {
        const idx = s.indexOf(0x3c, this.pos);
        if (idx < 0) {
          const start = this.pos;
          const len = s.length - start;
          this.state = "eof";
          if (len === 0) return false;
          return this.emit("DATA_TEXT", start, len);
        }
        const start = this.pos;
        const len = idx - start;
        this.pos = idx + 1;
        this.state = "tag_open";
        if (len === 0) return null;
        return this.emit("DATA_TEXT", start, len);
      }
      case "tag_open": {
        if (this.pos >= s.length) return false;
        const c = s[this.pos];
        if (c === 0x21) {
          this.pos += 1;
          this.state = "markup_declaration_open";
          return null;
        }
        if (c === 0x2f) {
          this.pos += 1;
          this.isClose = true;
          this.state = "end_tag_open";
          return null;
        }
        if (c === 0x3f) {
          this.pos += 1;
          this.state = "bogus_comment";
          return null;
        }
        if (c === 0x25) {
          this.pos += 1;
          this.state = "bogus_comment2";
          return null;
        }
        if (c === 0 || isAlpha(c)) {
          this.state = "tag_name";
          return null;
        }
        if (this.pos === 0) {
          this.state = "data";
          return null;
        }
        this.state = "data";
        return this.emit("DATA_TEXT", this.pos - 1, 1);
      }
      case "end_tag_open": {
        if (this.pos >= s.length) return false;
        const c = s[this.pos];
        if (c === 0x3e) {
          this.state = "data";
          return null;
        }
        if (isAlpha(c)) {
          this.state = "tag_name";
          return null;
        }
        this.isClose = false;
        this.state = "bogus_comment";
        return null;
      }
      case "tag_name_close": {
        this.isClose = false;
        const start = this.pos;
        this.pos += 1;
        this.state = this.pos < s.length ? "data" : "eof";
        return this.emit("TAG_NAME_CLOSE", start, 1);
      }
      case "tag_name": {
        let p = this.pos;
        while (p < s.length) {
          const c = s[p];
          if (c === 0) {
            p += 1;
            continue;
          }
          if (isWhite(c)) {
            const start = this.pos;
            this.pos = p + 1;
            this.state = "before_attribute_name";
            return this.emit("TAG_NAME_OPEN", start, p - start);
          }
          if (c === 0x2f) {
            const start = this.pos;
            this.pos = p + 1;
            this.state = "self_closing_start_tag";
            return this.emit("TAG_NAME_OPEN", start, p - start);
          }
          if (c === 0x3e) {
            const start = this.pos;
            if (this.isClose) {
              this.pos = p + 1;
              this.isClose = false;
              this.state = "data";
              return this.emit("TAG_CLOSE", start, p - start);
            }
            this.pos = p;
            this.state = "tag_name_close";
            return this.emit("TAG_NAME_OPEN", start, p - start);
          }
          p += 1;
        }
        const start = this.pos;
        this.state = "eof";
        return this.emit("TAG_NAME_OPEN", start, s.length - start);
      }
      case "before_attribute_name": {
        const c = this.skipWhite();
        if (c === null) return false;
        if (c === 0x2f) {
          this.pos += 1;
          if (this.pos < s.length && s[this.pos] !== 0x3e) return null;
          this.state = "self_closing_start_tag";
          return null;
        }
        if (c === 0x3e) {
          const start = this.pos;
          this.pos += 1;
          this.state = "data";
          return this.emit("TAG_NAME_CLOSE", start, 1);
        }
        this.state = "attribute_name";
        return null;
      }
      case "attribute_name": {
        let p = this.pos + 1;
        while (p < s.length) {
          const c = s[p];
          let ns: HtmlState | null = null;
          if (c === 0x2f) ns = "self_closing_start_tag";
          else if (c === 0x3d) ns = "before_attribute_value";
          else if (c === 0x3e) ns = "tag_name_close";
          else if (isWhite(c)) ns = "after_attribute_name";
          if (ns !== null) {
            const start = this.pos;
            this.state = ns;
            this.pos = c === 0x3e ? p : p + 1;
            return this.emit("ATTR_NAME", start, p - start);
          }
          p += 1;
        }
        const start = this.pos;
        this.state = "eof";
        this.pos = s.length;
        return this.emit("ATTR_NAME", start, s.length - start);
      }
      case "after_attribute_name": {
        const c = this.skipWhite();
        if (c === null) return false;
        if (c === 0x2f) {
          this.pos += 1;
          this.state = "self_closing_start_tag";
          return null;
        }
        if (c === 0x3d) {
          this.pos += 1;
          this.state = "before_attribute_value";
          return null;
        }
        if (c === 0x3e) {
          this.state = "tag_name_close";
          return null;
        }
        this.state = "attribute_name";
        return null;
      }
      case "before_attribute_value": {
        const c = this.skipWhite();
        if (c === null) {
          this.state = "eof";
          return false;
        }
        if (c === 0x22) this.state = "attribute_value_double_quote";
        else if (c === 0x27) this.state = "attribute_value_single_quote";
        else if (c === 0x60) this.state = "attribute_value_back_quote";
        else this.state = "attribute_value_no_quote";
        return null;
      }
      case "attribute_value_double_quote":
        return this.attrValueQuote(0x22);
      case "attribute_value_single_quote":
        return this.attrValueQuote(0x27);
      case "attribute_value_back_quote":
        return this.attrValueQuote(0x60);
      case "attribute_value_no_quote": {
        let p = this.pos;
        while (p < s.length) {
          const c = s[p];
          if (isWhite(c)) {
            const start = this.pos;
            this.pos = p + 1;
            this.state = "before_attribute_name";
            return this.emit("ATTR_VALUE", start, p - start);
          }
          if (c === 0x3e) {
            const start = this.pos;
            this.pos = p;
            this.state = "tag_name_close";
            return this.emit("ATTR_VALUE", start, p - start);
          }
          p += 1;
        }
        const start = this.pos;
        this.state = "eof";
        return this.emit("ATTR_VALUE", start, s.length - start);
      }
      case "after_attribute_value_quoted": {
        if (this.pos >= s.length) return false;
        const c = s[this.pos];
        if (isWhite(c)) {
          this.pos += 1;
          this.state = "before_attribute_name";
          return null;
        }
        if (c === 0x2f) {
          this.pos += 1;
          this.state = "self_closing_start_tag";
          return null;
        }
        if (c === 0x3e) {
          const start = this.pos;
          this.pos += 1;
          this.state = "data";
          return this.emit("TAG_NAME_CLOSE", start, 1);
        }
        this.state = "before_attribute_name";
        return null;
      }
      case "self_closing_start_tag": {
        if (this.pos >= s.length) return false;
        if (s[this.pos] === 0x3e) {
          const start = Math.max(0, this.pos - 1);
          this.state = "data";
          this.pos += 1;
          return this.emit("TAG_NAME_SELFCLOSE", start, 2);
        }
        this.state = "before_attribute_name";
        return null;
      }
      case "bogus_comment": {
        const start = this.pos;
        const idx = s.indexOf(0x3e, this.pos);
        if (idx >= 0) {
          this.pos = idx + 1;
          this.state = "data";
          return this.emit("TAG_COMMENT", start, idx - start);
        }
        this.pos = s.length;
        this.state = "eof";
        return this.emit("TAG_COMMENT", start, s.length - start);
      }
      case "bogus_comment2": {
        const start = this.pos;
        let p = this.pos;
        while (true) {
          const idx = s.indexOf(0x25, p);
          if (idx < 0 || idx + 1 >= s.length) break;
          if (s[idx + 1] !== 0x3e) {
            p = idx + 1;
            continue;
          }
          this.pos = idx + 2;
          this.state = "data";
          return this.emit("TAG_COMMENT", start, idx - start);
        }
        this.pos = s.length;
        this.state = "eof";
        return this.emit("TAG_COMMENT", start, s.length - start);
      }
      case "markup_declaration_open": {
        const rest = s.subarray(Math.min(this.pos, s.length));
        if (rest.length >= 7 && rest.subarray(0, 7).toString("latin1").toUpperCase() === "DOCTYPE") {
          this.state = "doctype";
          return null;
        }
        if (rest.length >= 7 && rest.subarray(0, 7).toString("latin1") === "[CDATA[") {
          this.pos += 7;
          this.state = "cdata";
          return null;
        }
        if (rest.length >= 2 && rest[0] === 0x2d && rest[1] === 0x2d) {
          this.pos += 2;
          this.state = "comment";
          return null;
        }
        this.state = "bogus_comment";
        return null;
      }
      case "comment": {
        const start = this.pos;
        let p = this.pos;
        while (true) {
          const idx = s.indexOf(0x2d, p);
          if (idx < 0 || idx + 3 > s.length) break;
          let off = 1;
          while (idx + off < s.length && s[idx + off] === 0) off += 1;
          if (idx + off >= s.length) break;
          const c1 = s[idx + off];
          if (c1 !== 0x2d && c1 !== 0x21) {
            p = idx + 1;
            continue;
          }
          off += 1;
          if (idx + off >= s.length) break;
          if (s[idx + off] !== 0x3e) {
            p = idx + 1;
            continue;
          }
          off += 1;
          this.pos = idx + off;
          this.state = "data";
          return this.emit("TAG_COMMENT", start, idx - start);
        }
        this.state = "eof";
        return this.emit("TAG_COMMENT", start, s.length - start);
      }
      case "cdata": {
        const start = this.pos;
        const idx = s.indexOf("]]>", this.pos, "latin1");
        if (idx >= 0) {
          this.pos = idx + 3;
          this.state = "data";
          return this.emit("TAG_COMMENT", start, idx - start);
        }
        this.state = "eof";
        return this.emit("TAG_COMMENT", start, s.length - start);
      }
      case "doctype": {
        const start = this.pos;
        const idx = s.indexOf(0x3e, this.pos);
        if (idx >= 0) {
          this.pos = idx + 1;
          this.state = "data";
          return this.emit("DOCTYPE", start, idx - start);
        }
        this.state = "eof";
        return this.emit("DOCTYPE", start, s.length - start);
      }
      default:
        this.state = "eof";
        return false;
    }
  }

  private attrValueQuote(q: number): boolean | null {
    if (this.pos > 0) this.pos += 1;
    const idx = this.s.indexOf(q, this.pos);
    if (idx < 0) {
      const start = this.pos;
      this.state = "eof";
      return this.emit("ATTR_VALUE", start, this.s.length - start);
    }
    const start = this.pos;
    const len = idx - start;
    this.state = "after_attribute_value_quoted";
    this.pos += len + 1;
    return this.emit("ATTR_VALUE", start, len);
  }
}

function eqFoldSkippingNul(aUpper: string, b: Buffer, n: number): boolean {
  let ai = 0;
  let bi = 0;
  let left = n;
  while (left > 0) {
    left -= 1;
    if (bi >= b.length) return false;
    const raw = b[bi];
    bi += 1;
    if (raw === 0) continue;
    if (ai >= aUpper.length) return false;
    const up = raw >= 0x61 && raw <= 0x7a ? raw - 0x20 : raw;
    if (aUpper.charCodeAt(ai) !== up) return false;
    ai += 1;
  }
  return ai === aUpper.length;
}

function startsWithFold(prefixUpper: string, buf: Buffer): boolean {
  let ai = 0;
  for (let i = 0; i < buf.length && ai < prefixUpper.length; i += 1) {
    const raw = buf[i];
    if (raw === 0) continue;
    const up = raw >= 0x61 && raw <= 0x7a ? raw - 0x20 : raw;
    if (prefixUpper.charCodeAt(ai) !== up) return false;
    ai += 1;
  }
  return ai === prefixUpper.length;
}

function decodeCharAt(buf: Buffer, off: number): { ch: number; consumed: number } {
  if (off >= buf.length) return { ch: -1, consumed: 0 };
  if (buf[off] !== 0x26 || off + 2 >= buf.length) return { ch: buf[off], consumed: 1 };
  if (buf[off + 1] !== 0x23) return { ch: 0x26, consumed: 1 };

  const isHex = off + 3 < buf.length && (buf[off + 2] === 0x78 || buf[off + 2] === 0x58);
  if (isHex) {
    let val = 0;
    let i = off + 3;
    let digits = 0;
    while (i < buf.length) {
      const c = buf[i];
      if (c === 0x3b) return digits > 0 ? { ch: val, consumed: i - off + 1 } : { ch: 0x26, consumed: 1 };
      let d = -1;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
      if (d < 0) return digits > 0 ? { ch: val, consumed: i - off } : { ch: 0x26, consumed: 1 };
      val = val * 16 + d;
      digits += 1;
      if (val > 0x1000ff) return { ch: 0x26, consumed: 1 };
      i += 1;
    }
    return digits > 0 ? { ch: val, consumed: i - off } : { ch: 0x26, consumed: 1 };
  }

  let val = 0;
  let i = off + 2;
  let digits = 0;
  while (i < buf.length) {
    const c = buf[i];
    if (c === 0x3b) return digits > 0 ? { ch: val, consumed: i - off + 1 } : { ch: 0x26, consumed: 1 };
    if (c < 0x30 || c > 0x39) return digits > 0 ? { ch: val, consumed: i - off } : { ch: 0x26, consumed: 1 };
    val = val * 10 + (c - 0x30);
    digits += 1;
    if (val > 0x1000ff) return { ch: 0x26, consumed: 1 };
    i += 1;
  }
  return digits > 0 ? { ch: val, consumed: i - off } : { ch: 0x26, consumed: 1 };
}

function htmlEncodeStartsWith(upperPrefix: string, buf: Buffer): boolean {
  let ai = 0;
  let idx = 0;
  let first = true;
  while (idx < buf.length) {
    if (ai === upperPrefix.length) return true;
    const dec = decodeCharAt(buf, idx);
    idx += Math.max(dec.consumed, 1);
    let cb = dec.ch;
    if (first && cb <= 32) continue;
    first = false;
    if (cb === 0 || cb === 10) continue;
    if (cb >= 0x61 && cb <= 0x7a) cb -= 0x20;
    if (upperPrefix.charCodeAt(ai) !== cb) return false;
    ai += 1;
  }
  return ai === upperPrefix.length;
}

export function isBlackTag(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  for (const tag of XSS_BLACK_TAGS) {
    if (eqFoldSkippingNul(tag, buf, buf.length)) return true;
  }
  return startsWithFold("SVG", buf) || startsWithFold("XSL", buf);
}

export function blackAttrKind(buf: Buffer): number {
  if (buf.length < 2) return 0;
  if (buf.length >= 5) {
    const b0 = buf[0];
    const b1 = buf[1];
    if ((b0 === 0x6f || b0 === 0x4f) && (b1 === 0x6e || b1 === 0x4e)) {
      const tail = buf.subarray(2);
      for (const [name, kind] of XSS_BLACK_EVENTS) {
        const n = Math.min(tail.length, name.length);
        if (eqFoldSkippingNul(name, tail, n)) return kind;
      }
    }
    if (eqFoldSkippingNul("XMLNS", buf, 5) || eqFoldSkippingNul("XLINK", buf, 5)) return 1;
  }
  for (const [name, kind] of XSS_BLACK_ATTRS) {
    if (eqFoldSkippingNul(name, buf, buf.length)) return kind;
  }
  return 0;
}

export function isBlackUrl(buf: Buffer): boolean {
  let start = 0;
  while (start < buf.length && (buf[start] <= 32 || buf[start] >= 127)) start += 1;
  const trimmed = buf.subarray(start);
  return (
    htmlEncodeStartsWith("DATA", trimmed) ||
    htmlEncodeStartsWith("VIEW-SOURCE", trimmed) ||
    htmlEncodeStartsWith("JAVA", trimmed) ||
    htmlEncodeStartsWith("VBSCRIPT", trimmed)
  );
}

export function detectXssInContext(input: string | Buffer, ctx: Html5Context): boolean {
  const buf = typeof input === "string" ? Buffer.from(input, "latin1") : input;
  const tok = new Html5Tokenizer(buf, ctx);
  let attrKind = 0;

  while (tok.next()) {
    if (tok.tokenType !== "ATTR_VALUE") attrKind = 0;
    switch (tok.tokenType) {
      case "DOCTYPE":
        return true;
      case "TAG_NAME_OPEN":
        if (isBlackTag(tok.tokenValue)) return true;
        break;
      case "ATTR_NAME":
        attrKind = blackAttrKind(tok.tokenValue);
        break;
      case "ATTR_VALUE":
        if (attrKind === 1 || attrKind === 3) return true;
        if (attrKind === 2 && isBlackUrl(tok.tokenValue)) return true;
        if (attrKind === 4 && blackAttrKind(tok.tokenValue) !== 0) return true;
        attrKind = 0;
        break;
      case "TAG_COMMENT": {
        const v = tok.tokenValue;
        if (v.includes(0x60)) return true;
        if (v.length > 3) {
          if (v[0] === 0x5b && (v[1] === 0x69 || v[1] === 0x49) && (v[2] === 0x66 || v[2] === 0x46)) return true;
          if ((v[0] === 0x78 || v[0] === 0x58) && (v[1] === 0x6d || v[1] === 0x4d) && (v[2] === 0x6c || v[2] === 0x4c)) {
            return true;
          }
        }
        if (v.length > 5 && (eqFoldSkippingNul("IMPORT", v, 6) || eqFoldSkippingNul("ENTITY", v, 6))) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

export function detectXss(input: string | Buffer): { xss: boolean; context: Html5Context | null } {
  const buf = typeof input === "string" ? Buffer.from(input, "latin1") : input;
  if (buf.length === 0) return { xss: false, context: null };
  const contexts: Html5Context[] = ["data", "value_no_quote", "value_single_quote", "value_double_quote", "value_back_quote"];
  for (const ctx of contexts) {
    if (detectXssInContext(buf, ctx)) return { xss: true, context: ctx };
  }
  return { xss: false, context: null };
}
