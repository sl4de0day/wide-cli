import { SQLI_FINGERPRINTS, SQLI_KEYWORDS } from "./libinjection-tables.js";

const VAL_SIZE = 32;
const MAX_TOKENS = 5;

const T_NONE = 0;
const T_KEYWORD = "k".charCodeAt(0);
const T_UNION = "U".charCodeAt(0);
const T_GROUP = "B".charCodeAt(0);
const T_EXPRESSION = "E".charCodeAt(0);
const T_SQLTYPE = "t".charCodeAt(0);
const T_FUNCTION = "f".charCodeAt(0);
const T_BAREWORD = "n".charCodeAt(0);
const T_NUMBER = "1".charCodeAt(0);
const T_VARIABLE = "v".charCodeAt(0);
const T_STRING = "s".charCodeAt(0);
const T_OPERATOR = "o".charCodeAt(0);
const T_LOGIC = "&".charCodeAt(0);
const T_COMMENT = "c".charCodeAt(0);
const T_COLLATE = "A".charCodeAt(0);
const T_LPAREN = "(".charCodeAt(0);
const T_RPAREN = ")".charCodeAt(0);
const T_LBRACE = "{".charCodeAt(0);
const T_RBRACE = "}".charCodeAt(0);
const T_DOT = ".".charCodeAt(0);
const T_COMMA = ",".charCodeAt(0);
const T_COLON = ":".charCodeAt(0);
const T_SEMI = ";".charCodeAt(0);
const T_TSQL = "T".charCodeAt(0);
const T_UNKNOWN = "?".charCodeAt(0);
const T_EVIL = "X".charCodeAt(0);
const T_BACKSLASH = "\\".charCodeAt(0);

type QuoteMode = "none" | "single" | "double";
type Dialect = "ansi" | "mysql";

interface SqlToken {
  type: number;
  pos: number;
  val: string;
  count: number;
  strOpen: number;
  strClose: number;
}

interface TokenStats {
  commentDdx: number;
  commentC: number;
  commentHash: number;
  folds: number;
  tokens: number;
}

function emptyToken(): SqlToken {
  return { type: T_NONE, pos: 0, val: "", count: 0, strOpen: 0, strClose: 0 };
}

function cloneToken(t: SqlToken): SqlToken {
  return { type: t.type, pos: t.pos, val: t.val, count: t.count, strOpen: t.strOpen, strClose: t.strClose };
}

function makeCharSet(members: string): Uint8Array {
  const arr = new Uint8Array(256);
  arr[0] = 1;
  for (let i = 0; i < members.length; i += 1) arr[members.charCodeAt(i)] = 1;
  return arr;
}

const WHITE_SET = makeCharSet(" \t\n\x0b\x0c\r\xa0");
const WORD_STOP = makeCharSet(" []{}<>:\\?=@!#~+-*/&|^%(),';\t\n\x0b\x0c\r\"\xa0");
const VAR_STOP = makeCharSet(" <>:\\?=@!#~+-*/&|^%(),';\t\n\x0b\x0c\r'`\"");

function lookupKeyword(raw: string): number | null {
  if (!raw || raw.length >= VAL_SIZE) return null;
  const code = SQLI_KEYWORDS[raw.toUpperCase()];
  return code ? code.charCodeAt(0) : null;
}

const DISPATCH = new Uint8Array(256);
{
  const K_WHITE = 1;
  const K_OP1 = 2;
  const K_OP2 = 3;
  const K_CHAR = 4;
  const K_OTHER = 5;
  const K_HASH = 6;
  const K_DASH = 7;
  const K_SLASH = 8;
  const K_BACK = 9;
  const K_STR = 10;
  const K_ESTR = 11;
  const K_USTR = 12;
  const K_QSTR = 13;
  const K_NQSTR = 14;
  const K_BSTR = 15;
  const K_XSTR = 16;
  const K_BWORD = 17;
  const K_WORD = 18;
  const K_TICK = 19;
  const K_MONEY = 20;
  const K_NUM = 21;
  const K_VAR = 22;

  for (let i = 0; i <= 0x20; i += 1) DISPATCH[i] = K_WHITE;
  DISPATCH[0x21] = K_OP2;
  DISPATCH[0x22] = K_STR;
  DISPATCH[0x23] = K_HASH;
  DISPATCH[0x24] = K_MONEY;
  DISPATCH[0x25] = K_OP1;
  DISPATCH[0x26] = K_OP2;
  DISPATCH[0x27] = K_STR;
  DISPATCH[0x28] = K_CHAR;
  DISPATCH[0x29] = K_CHAR;
  DISPATCH[0x2a] = K_OP2;
  DISPATCH[0x2b] = K_OP1;
  DISPATCH[0x2c] = K_CHAR;
  DISPATCH[0x2d] = K_DASH;
  DISPATCH[0x2e] = K_NUM;
  DISPATCH[0x2f] = K_SLASH;
  for (let i = 0x30; i <= 0x39; i += 1) DISPATCH[i] = K_NUM;
  DISPATCH[0x3a] = K_OP2;
  DISPATCH[0x3b] = K_CHAR;
  DISPATCH[0x3c] = K_OP2;
  DISPATCH[0x3d] = K_OP2;
  DISPATCH[0x3e] = K_OP2;
  DISPATCH[0x3f] = K_OTHER;
  DISPATCH[0x40] = K_VAR;
  for (let i = 0x41; i <= 0x5a; i += 1) DISPATCH[i] = K_WORD;
  DISPATCH[0x42] = K_BSTR;
  DISPATCH[0x45] = K_ESTR;
  DISPATCH[0x4e] = K_NQSTR;
  DISPATCH[0x51] = K_QSTR;
  DISPATCH[0x55] = K_USTR;
  DISPATCH[0x58] = K_XSTR;
  DISPATCH[0x5b] = K_BWORD;
  DISPATCH[0x5c] = K_BACK;
  DISPATCH[0x5d] = K_OTHER;
  DISPATCH[0x5e] = K_OP1;
  DISPATCH[0x5f] = K_WORD;
  DISPATCH[0x60] = K_TICK;
  for (let i = 0x61; i <= 0x7a; i += 1) DISPATCH[i] = K_WORD;
  DISPATCH[0x62] = K_BSTR;
  DISPATCH[0x65] = K_ESTR;
  DISPATCH[0x6e] = K_NQSTR;
  DISPATCH[0x71] = K_QSTR;
  DISPATCH[0x75] = K_USTR;
  DISPATCH[0x78] = K_XSTR;
  DISPATCH[0x7b] = K_CHAR;
  DISPATCH[0x7c] = K_OP2;
  DISPATCH[0x7d] = K_CHAR;
  DISPATCH[0x7e] = K_OP1;
  DISPATCH[0x7f] = K_WHITE;
  for (let i = 0x80; i <= 0xff; i += 1) DISPATCH[i] = i === 0xa0 ? K_WHITE : K_WORD;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

class SqlTokenizer {
  readonly s: Buffer;
  readonly quote: QuoteMode;
  readonly dialect: Dialect;
  pos = 0;
  current: SqlToken = emptyToken();
  stats: TokenStats = { commentDdx: 0, commentC: 0, commentHash: 0, folds: 0, tokens: 0 };

  constructor(buf: Buffer, quote: QuoteMode = "none", dialect: Dialect = "ansi") {
    this.s = buf;
    this.quote = quote;
    this.dialect = dialect;
  }

  private assign(typ: number, pos: number, len: number, srcOff = pos): void {
    const cap = Math.min(len, VAL_SIZE - 1);
    this.current.type = typ;
    this.current.pos = pos;
    this.current.val = this.s.subarray(srcOff, srcOff + cap).toString("latin1");
  }

  private assignChar(typ: number, pos: number, ch: number): void {
    this.current.type = typ;
    this.current.pos = pos;
    this.current.val = String.fromCharCode(ch);
  }

  next(): boolean {
    if (this.s.length === 0) return false;
    this.current = emptyToken();

    if (this.pos === 0 && this.quote !== "none") {
      const delim = this.quote === "single" ? 0x27 : 0x22;
      this.pos = this.parseStringCore(0, delim, 0);
      this.stats.tokens += 1;
      return true;
    }

    while (this.pos < this.s.length) {
      const k = DISPATCH[this.s[this.pos]];
      switch (k) {
        case 1:
          this.pos += 1;
          break;
        case 2:
          this.assignChar(T_OPERATOR, this.pos, this.s[this.pos]);
          this.pos += 1;
          break;
        case 3:
          this.pos = this.parseOperator2();
          break;
        case 4:
          this.assignChar(this.s[this.pos], this.pos, this.s[this.pos]);
          this.pos += 1;
          break;
        case 5:
          this.assignChar(T_UNKNOWN, this.pos, this.s[this.pos]);
          this.pos += 1;
          break;
        case 6:
          this.pos = this.parseHash();
          break;
        case 7:
          this.pos = this.parseDash();
          break;
        case 8:
          this.pos = this.parseSlash();
          break;
        case 9:
          this.pos = this.parseBackslash();
          break;
        case 10:
          this.pos = this.parseStringCore(this.pos, this.s[this.pos], 1);
          break;
        case 11:
          this.pos = this.parseEstring();
          break;
        case 12:
          this.pos = this.parseUstring();
          break;
        case 13:
          this.pos = this.parseQstringCore(0);
          break;
        case 14:
          this.pos = this.parseNqstring();
          break;
        case 15:
          this.pos = this.parseQuotedDigits("01");
          break;
        case 16:
          this.pos = this.parseQuotedDigits("0123456789ABCDEFabcdef");
          break;
        case 17:
          this.pos = this.parseBword();
          break;
        case 18:
          this.pos = this.parseWord();
          break;
        case 19:
          this.pos = this.parseTick();
          break;
        case 20:
          this.pos = this.parseMoney();
          break;
        case 21:
          this.pos = this.parseNumber();
          break;
        case 22:
          this.pos = this.parseVar();
          break;
        default:
          this.pos += 1;
          break;
      }
      if (this.current.type !== T_NONE) {
        this.stats.tokens += 1;
        return true;
      }
    }
    return false;
  }

  private parseEolComment(): number {
    const start = this.pos;
    const nl = this.s.indexOf(0x0a, start);
    if (nl >= 0) {
      this.assign(T_COMMENT, start, nl - start);
      return nl + 1;
    }
    this.assign(T_COMMENT, start, this.s.length - start);
    return this.s.length;
  }

  private parseHash(): number {
    this.stats.commentHash += 1;
    if (this.dialect === "mysql") {
      this.stats.commentHash += 1;
      return this.parseEolComment();
    }
    this.assignChar(T_OPERATOR, this.pos, 0x23);
    return this.pos + 1;
  }

  private parseDash(): number {
    const p = this.pos;
    const slen = this.s.length;
    if (p + 2 < slen && this.s[p + 1] === 0x2d && WHITE_SET[this.s[p + 2]]) {
      return this.parseEolComment();
    }
    if (p + 2 === slen && this.s[p + 1] === 0x2d) {
      return this.parseEolComment();
    }
    if (p + 1 < slen && this.s[p + 1] === 0x2d && this.dialect === "ansi") {
      this.stats.commentDdx += 1;
      return this.parseEolComment();
    }
    this.assignChar(T_OPERATOR, p, 0x2d);
    return p + 1;
  }

  private parseSlash(): number {
    const p = this.pos;
    const slen = this.s.length;
    if (p + 1 >= slen || this.s[p + 1] !== 0x2a) {
      this.assignChar(T_OPERATOR, p, this.s[p]);
      return p + 1;
    }
    let ctype = T_COMMENT;
    const afterStart = p + 2;
    const end = this.s.indexOf("*/", afterStart, "latin1");
    const clen = end >= 0 ? end - afterStart + 4 : slen - p;
    if (end >= 0) {
      const inner = this.s.subarray(afterStart, Math.min(end + 1, slen));
      if (inner.includes("/*")) ctype = T_EVIL;
    }
    if (ctype === T_COMMENT && p + 2 < slen && this.s[p + 2] === 0x21) {
      ctype = T_EVIL;
    }
    this.stats.commentC += 1;
    this.assign(ctype, p, clen);
    return p + clen;
  }

  private parseBackslash(): number {
    const p = this.pos;
    if (p + 1 < this.s.length && this.s[p + 1] === 0x4e) {
      this.assign(T_NUMBER, p, 2);
      return p + 2;
    }
    this.assignChar(T_BACKSLASH, p, this.s[p]);
    return p + 1;
  }

  private parseOperator2(): number {
    const p = this.pos;
    if (p + 1 >= this.s.length) {
      this.assignChar(T_OPERATOR, p, this.s[p]);
      return p + 1;
    }
    if (p + 2 < this.s.length && this.s[p] === 0x3c && this.s[p + 1] === 0x3d && this.s[p + 2] === 0x3e) {
      this.assign(T_OPERATOR, p, 3);
      return p + 3;
    }
    const two = this.s.subarray(p, p + 2).toString("latin1");
    const ch = lookupKeyword(two);
    if (ch !== null) {
      this.assign(ch, p, 2);
      return p + 2;
    }
    if (this.s[p] === 0x3a) {
      this.assignChar(T_COLON, p, 0x3a);
      return p + 1;
    }
    this.assignChar(T_OPERATOR, p, this.s[p]);
    return p + 1;
  }

  private isBackslashEscaped(endIncl: number, start: number): boolean {
    if (endIncl < start) return false;
    let i = endIncl;
    let count = 0;
    while (i >= start && this.s[i] === 0x5c) {
      count += 1;
      if (i === 0) break;
      i -= 1;
    }
    return (count & 1) === 1;
  }

  private parseStringCore(posIn: number, delim: number, offset: number): number {
    const bodyStart = posIn + offset;
    this.current.strOpen = offset > 0 ? delim : 0;
    let q = bodyStart <= this.s.length ? this.s.indexOf(delim, bodyStart) : -1;

    while (q >= 0) {
      if (q > 0 && this.isBackslashEscaped(q - 1, bodyStart)) {
        q = this.s.indexOf(delim, q + 1);
        continue;
      }
      if (q + 1 < this.s.length && this.s[q + 1] === delim) {
        q = this.s.indexOf(delim, q + 2);
        continue;
      }
      this.assign(T_STRING, bodyStart, q - bodyStart, bodyStart);
      this.current.strClose = delim;
      return q + 1;
    }

    this.assign(T_STRING, bodyStart, this.s.length - bodyStart, bodyStart);
    this.current.strClose = 0;
    return this.s.length;
  }

  private parseEstring(): number {
    if (this.pos + 2 >= this.s.length || this.s[this.pos + 1] !== 0x27) return this.parseWord();
    return this.parseStringCore(this.pos, 0x27, 2);
  }

  private parseUstring(): number {
    if (this.pos + 2 < this.s.length && this.s[this.pos + 1] === 0x26 && this.s[this.pos + 2] === 0x27) {
      const r = this.parseStringCore(this.pos + 2, 0x27, 1);
      this.current.strOpen = 0x75;
      if (this.current.strClose === 0x27) this.current.strClose = 0x75;
      return r;
    }
    return this.parseWord();
  }

  private parseQstringCore(offset: number): number {
    const p = this.pos + offset;
    if (p + 2 >= this.s.length || (this.s[p] !== 0x71 && this.s[p] !== 0x51) || this.s[p + 1] !== 0x27) {
      return this.parseWord();
    }
    let ch = this.s[p + 2];
    if (ch < 33 || ch > 127) return this.parseWord();
    if (ch === 0x28) ch = 0x29;
    else if (ch === 0x5b) ch = 0x5d;
    else if (ch === 0x7b) ch = 0x7d;
    else if (ch === 0x3c) ch = 0x3e;
    const bodyStart = p + 3;
    const needle = String.fromCharCode(ch, 0x27);
    const e = this.s.indexOf(needle, bodyStart, "latin1");
    if (e >= 0) {
      this.assign(T_STRING, bodyStart, e - bodyStart, bodyStart);
      this.current.strOpen = 0x71;
      this.current.strClose = 0x71;
      return e + 2;
    }
    this.assign(T_STRING, bodyStart, this.s.length - bodyStart, bodyStart);
    this.current.strOpen = 0x71;
    this.current.strClose = 0;
    return this.s.length;
  }

  private parseNqstring(): number {
    if (this.pos + 2 < this.s.length && this.s[this.pos + 1] === 0x27) return this.parseEstring();
    return this.parseQstringCore(1);
  }

  private parseQuotedDigits(accept: string): number {
    const p = this.pos;
    if (p + 2 >= this.s.length || this.s[p + 1] !== 0x27) return this.parseWord();
    let i = p + 2;
    while (i < this.s.length && accept.includes(String.fromCharCode(this.s[i]))) i += 1;
    if (i >= this.s.length || this.s[i] !== 0x27) return this.parseWord();
    this.assign(T_NUMBER, p, i - p + 1);
    return i + 1;
  }

  private parseBword(): number {
    const close = this.s.indexOf(0x5d, this.pos);
    if (close >= 0) {
      this.assign(T_BAREWORD, this.pos, close - this.pos + 1);
      return close + 1;
    }
    this.assign(T_BAREWORD, this.pos, this.s.length - this.pos);
    return this.s.length;
  }

  private parseWord(): number {
    const p = this.pos;
    let end = p;
    while (end < this.s.length && !WORD_STOP[this.s[end]]) end += 1;
    const wlen = end - p;
    this.assign(T_BAREWORD, p, wlen);

    for (let i = 0; i < this.current.val.length; i += 1) {
      const ch = this.current.val[i];
      if (ch !== "." && ch !== "`") continue;
      const kw = lookupKeyword(this.current.val.slice(0, i));
      if (kw !== null && kw !== T_BAREWORD) {
        this.assign(kw, p, i);
        return p + i;
      }
    }
    if (wlen < VAL_SIZE) {
      this.current.type = lookupKeyword(this.current.val) ?? T_BAREWORD;
    }
    return end;
  }

  private parseTick(): number {
    const r = this.parseStringCore(this.pos, 0x60, 1);
    const ch = lookupKeyword(this.current.val);
    this.current.type = ch === T_FUNCTION ? T_FUNCTION : T_BAREWORD;
    return r;
  }

  private parseVar(): number {
    let p = this.pos + 1;
    if (p < this.s.length && this.s[p] === 0x40) {
      p += 1;
      this.current.count = 2;
    } else {
      this.current.count = 1;
    }
    if (p < this.s.length) {
      if (this.s[p] === 0x60) {
        this.pos = p;
        const r = this.parseTick();
        this.current.type = T_VARIABLE;
        return r;
      }
      if (this.s[p] === 0x27 || this.s[p] === 0x22) {
        this.pos = p;
        const r = this.parseStringCore(p, this.s[p], 1);
        this.current.type = T_VARIABLE;
        return r;
      }
    }
    let end = p;
    while (end < this.s.length && !VAR_STOP[this.s[end]]) end += 1;
    this.assign(T_VARIABLE, p, end - p);
    return end;
  }

  private parseMoney(): number {
    const p = this.pos;
    if (p + 1 >= this.s.length) {
      this.assignChar(T_BAREWORD, p, 0x24);
      return this.s.length;
    }
    let i = p + 1;
    while (i < this.s.length && "0123456789.,".includes(String.fromCharCode(this.s[i]))) i += 1;
    const xlen = i - (p + 1);
    if (xlen > 1 || (xlen === 1 && this.s[p + 1] !== 0x2e)) {
      this.assign(T_NUMBER, p, 1 + xlen);
      return p + 1 + xlen;
    }
    if (xlen === 1) return this.parseWord();
    if (this.s[p + 1] === 0x24) {
      const e = this.s.indexOf("$$", p + 2, "latin1");
      if (e >= 0) {
        this.assign(T_STRING, p + 2, e - (p + 2), p + 2);
        this.current.strOpen = 0x24;
        this.current.strClose = 0x24;
        return e + 2;
      }
      this.assign(T_STRING, p + 2, this.s.length - (p + 2), p + 2);
      this.current.strOpen = 0x24;
      this.current.strClose = 0;
      return this.s.length;
    }
    this.assignChar(T_BAREWORD, p, 0x24);
    return p + 1;
  }

  private parseNumber(): number {
    const start = this.pos;
    let p = start;
    if (this.s[p] === 0x30 && p + 1 < this.s.length) {
      const next = this.s[p + 1];
      const accept = next === 0x78 || next === 0x58 ? "0123456789ABCDEFabcdef" : next === 0x62 || next === 0x42 ? "01" : "";
      if (accept) {
        let j = p + 2;
        while (j < this.s.length && (accept.includes(String.fromCharCode(this.s[j])) || this.s[j] === 0)) j += 1;
        if (j === p + 2) {
          this.assign(T_BAREWORD, p, 2);
          return p + 2;
        }
        this.assign(T_NUMBER, p, j - p);
        return j;
      }
    }
    while (p < this.s.length && isDigit(this.s[p])) p += 1;
    if (p < this.s.length && this.s[p] === 0x2e) {
      p += 1;
      while (p < this.s.length && isDigit(this.s[p])) p += 1;
      if (p - start === 1) {
        this.assignChar(T_DOT, start, 0x2e);
        return p;
      }
    }
    let haveE = false;
    let haveExp = false;
    if (p < this.s.length && (this.s[p] === 0x45 || this.s[p] === 0x65)) {
      haveE = true;
      p += 1;
      if (p < this.s.length && (this.s[p] === 0x2b || this.s[p] === 0x2d)) p += 1;
      while (p < this.s.length && isDigit(this.s[p])) {
        haveExp = true;
        p += 1;
      }
    }
    if (p < this.s.length && (this.s[p] === 0x64 || this.s[p] === 0x44 || this.s[p] === 0x66 || this.s[p] === 0x46)) {
      if (p + 1 === this.s.length || WHITE_SET[this.s[p + 1]] || this.s[p + 1] === 0x3b || this.s[p + 1] === 0x75 || this.s[p + 1] === 0x55) {
        p += 1;
      }
    }
    if (!(haveE && !haveExp)) {
      this.assign(T_NUMBER, start, p - start);
    }
    return p;
  }
}

function isUnaryOp(t: SqlToken): boolean {
  if (t.type !== T_OPERATOR) return false;
  if (t.val.length === 1) return "+-!~".includes(t.val);
  if (t.val === "!!") return true;
  return t.val.toUpperCase() === "NOT";
}

function isArithmeticOp(t: SqlToken): boolean {
  return t.type === T_OPERATOR && t.val.length === 1 && "*/-+%".includes(t.val);
}

function mergeWords(a: SqlToken, b: SqlToken): boolean {
  const okA =
    a.type === T_KEYWORD ||
    a.type === T_BAREWORD ||
    a.type === T_OPERATOR ||
    a.type === T_UNION ||
    a.type === T_FUNCTION ||
    a.type === T_EXPRESSION ||
    a.type === T_TSQL ||
    a.type === T_SQLTYPE;
  const okB = okA || b.type === T_LOGIC;
  if (!okA || !okB) return false;
  const combined = `${a.val} ${b.val}`;
  if (combined.length >= VAL_SIZE) return false;
  const ch = lookupKeyword(combined);
  if (ch === null) return false;
  a.type = ch;
  a.val = combined;
  return true;
}

const PSEUDO_FUNCS = new Set([
  "USER_ID",
  "USER_NAME",
  "DATABASE",
  "PASSWORD",
  "USER",
  "CURRENT_USER",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "LOCALTIME",
  "LOCALTIMESTAMP",
]);

function foldTokens(buf: Buffer, quote: QuoteMode, dialect: Dialect): { tokens: SqlToken[]; stats: TokenStats } {
  const tz = new SqlTokenizer(buf, quote, dialect);
  const v: SqlToken[] = Array.from({ length: 8 }, () => emptyToken());
  let lastComment = emptyToken();
  let pos = 0;
  let left = 0;
  let more = true;

  while (more) {
    more = tz.next();
    const t = tz.current;
    if (!(t.type === T_COMMENT || t.type === T_LPAREN || t.type === T_SQLTYPE || isUnaryOp(t))) {
      break;
    }
  }
  v[0] = cloneToken(tz.current);
  if (!more) return { tokens: [], stats: tz.stats };
  pos += 1;

  while (true) {
    if (pos >= MAX_TOKENS) {
      const restart =
        (v[0].type === T_NUMBER && (v[1].type === T_OPERATOR || v[1].type === T_COMMA) && v[2].type === T_LPAREN && v[3].type === T_NUMBER && v[4].type === T_RPAREN) ||
        (v[0].type === T_BAREWORD && v[1].type === T_OPERATOR && v[2].type === T_LPAREN && (v[3].type === T_BAREWORD || v[3].type === T_NUMBER) && v[4].type === T_RPAREN) ||
        (v[0].type === T_NUMBER && v[1].type === T_RPAREN && v[2].type === T_COMMA && v[3].type === T_LPAREN && v[4].type === T_NUMBER) ||
        (v[0].type === T_BAREWORD && v[1].type === T_RPAREN && v[2].type === T_OPERATOR && v[3].type === T_LPAREN && v[4].type === T_BAREWORD);
      if (restart) {
        if (pos > MAX_TOKENS) {
          v[1] = v[MAX_TOKENS];
          pos = 2;
        } else {
          pos = 1;
        }
        left = 0;
      }
    }

    if (!more || left >= MAX_TOKENS) {
      left = pos;
      break;
    }

    while (more && pos <= MAX_TOKENS && pos - left < 2) {
      more = tz.next();
      if (!more) break;
      if (tz.current.type === T_COMMENT) {
        lastComment = cloneToken(tz.current);
      } else {
        lastComment.type = T_NONE;
        v[pos] = cloneToken(tz.current);
        pos += 1;
      }
    }
    if (pos - left < 2) {
      left = pos;
      continue;
    }

    const a = v[left];
    const b = v[left + 1];

    if (a.type === T_STRING && b.type === T_STRING) {
      pos -= 1;
      tz.stats.folds += 1;
      continue;
    }
    if (a.type === T_SEMI && b.type === T_SEMI) {
      pos -= 1;
      tz.stats.folds += 1;
      continue;
    }
    if ((a.type === T_OPERATOR || a.type === T_LOGIC) && (isUnaryOp(b) || b.type === T_SQLTYPE)) {
      pos -= 1;
      tz.stats.folds += 1;
      left = 0;
      continue;
    }
    if (a.type === T_LPAREN && isUnaryOp(b)) {
      pos -= 1;
      tz.stats.folds += 1;
      if (left > 0) left -= 1;
      continue;
    }
    if (mergeWords(a, b)) {
      pos -= 1;
      tz.stats.folds += 1;
      if (left > 0) left -= 1;
      continue;
    }
    if (a.type === T_SEMI && b.type === T_FUNCTION && b.val.slice(0, 2).toUpperCase() === "IF") {
      b.type = T_TSQL;
      continue;
    }
    if ((a.type === T_BAREWORD || a.type === T_VARIABLE) && b.type === T_LPAREN && PSEUDO_FUNCS.has(a.val.toUpperCase())) {
      a.type = T_FUNCTION;
      continue;
    }
    if (a.type === T_KEYWORD && (a.val.toUpperCase() === "IN" || a.val.toUpperCase() === "NOT IN")) {
      a.type = b.type === T_LPAREN ? T_OPERATOR : T_BAREWORD;
      continue;
    }
    if (a.type === T_OPERATOR && (a.val.toUpperCase() === "LIKE" || a.val.toUpperCase() === "NOT LIKE")) {
      if (b.type === T_LPAREN) a.type = T_FUNCTION;
    } else if (
      a.type === T_SQLTYPE &&
      (b.type === T_BAREWORD || b.type === T_NUMBER || b.type === T_SQLTYPE || b.type === T_LPAREN || b.type === T_FUNCTION || b.type === T_VARIABLE || b.type === T_STRING)
    ) {
      v[left] = b;
      pos -= 1;
      tz.stats.folds += 1;
      left = 0;
      continue;
    } else if (a.type === T_COLLATE && b.type === T_BAREWORD && b.val.includes("_")) {
      b.type = T_SQLTYPE;
      left = 0;
    } else if (a.type === T_BACKSLASH) {
      if (isArithmeticOp(b)) a.type = T_NUMBER;
      else {
        v[left] = b;
        pos -= 1;
        tz.stats.folds += 1;
      }
      left = 0;
      continue;
    } else if (a.type === T_LPAREN && b.type === T_LPAREN) {
      pos -= 1;
      left = 0;
      tz.stats.folds += 1;
      continue;
    } else if (a.type === T_RPAREN && b.type === T_RPAREN) {
      pos -= 1;
      left = 0;
      tz.stats.folds += 1;
      continue;
    } else if (a.type === T_LBRACE && b.type === T_BAREWORD) {
      if (!b.val) {
        b.type = T_EVIL;
        return { tokens: v.slice(0, Math.min(left + 2, MAX_TOKENS)), stats: tz.stats };
      }
      left = 0;
      pos -= 2;
      tz.stats.folds += 2;
      continue;
    } else if (b.type === T_RBRACE) {
      pos -= 1;
      left = 0;
      tz.stats.folds += 1;
      continue;
    }

    while (more && pos <= MAX_TOKENS && pos - left < 3) {
      more = tz.next();
      if (!more) break;
      if (tz.current.type === T_COMMENT) {
        lastComment = cloneToken(tz.current);
      } else {
        lastComment.type = T_NONE;
        v[pos] = cloneToken(tz.current);
        pos += 1;
      }
    }
    if (pos - left < 3) {
      left = pos;
      continue;
    }

    const c = v[left + 2];
    let foldedThree = false;
    if (a.type === T_NUMBER && b.type === T_OPERATOR && c.type === T_NUMBER) {
      pos -= 2;
      left = 0;
      foldedThree = true;
    } else if (a.type === T_OPERATOR && b.type !== T_LPAREN && c.type === T_OPERATOR) {
      pos -= 2;
      left = 0;
      foldedThree = true;
    } else if (a.type === T_LOGIC && c.type === T_LOGIC) {
      pos -= 2;
      left = 0;
      foldedThree = true;
    } else if (a.type === T_VARIABLE && b.type === T_OPERATOR && (c.type === T_VARIABLE || c.type === T_NUMBER || c.type === T_BAREWORD)) {
      pos -= 2;
      left = 0;
      foldedThree = true;
    } else if ((a.type === T_BAREWORD || a.type === T_NUMBER) && b.type === T_OPERATOR && (c.type === T_NUMBER || c.type === T_BAREWORD)) {
      pos -= 2;
      left = 0;
      foldedThree = true;
    } else if ((a.type === T_BAREWORD || a.type === T_NUMBER || a.type === T_VARIABLE || a.type === T_STRING) && b.type === T_OPERATOR && b.val === "::" && c.type === T_SQLTYPE) {
      pos -= 2;
      left = 0;
      tz.stats.folds += 2;
      foldedThree = true;
    } else if ((a.type === T_BAREWORD || a.type === T_NUMBER || a.type === T_STRING || a.type === T_VARIABLE) && b.type === T_COMMA && (c.type === T_NUMBER || c.type === T_BAREWORD || c.type === T_STRING || c.type === T_VARIABLE)) {
      pos -= 2;
      left = 0;
      foldedThree = true;
    } else if ((a.type === T_EXPRESSION || a.type === T_GROUP || a.type === T_COMMA) && isUnaryOp(b) && c.type === T_LPAREN) {
      v[left + 1] = c;
      pos -= 1;
      left = 0;
      foldedThree = true;
    } else if ((a.type === T_KEYWORD || a.type === T_EXPRESSION || a.type === T_GROUP) && isUnaryOp(b) && (c.type === T_NUMBER || c.type === T_BAREWORD || c.type === T_VARIABLE || c.type === T_STRING || c.type === T_FUNCTION)) {
      v[left + 1] = c;
      pos -= 1;
      left = 0;
      foldedThree = true;
    } else if (a.type === T_COMMA && isUnaryOp(b) && (c.type === T_NUMBER || c.type === T_BAREWORD || c.type === T_VARIABLE || c.type === T_STRING)) {
      v[left + 1] = c;
      left = 0;
      pos -= 3;
      foldedThree = true;
    } else if (a.type === T_COMMA && isUnaryOp(b) && c.type === T_FUNCTION) {
      v[left + 1] = c;
      pos -= 1;
      left = 0;
      foldedThree = true;
    } else if (a.type === T_BAREWORD && b.type === T_DOT && c.type === T_BAREWORD) {
      pos -= 2;
      left = 0;
      foldedThree = true;
    } else if (a.type === T_EXPRESSION && b.type === T_DOT && c.type === T_BAREWORD) {
      v[left + 1] = c;
      pos -= 1;
      left = 0;
      foldedThree = true;
    } else if (a.type === T_FUNCTION && b.type === T_LPAREN && c.type !== T_RPAREN && a.val.toUpperCase() === "USER") {
      a.type = T_BAREWORD;
    }

    if (!foldedThree) left += 1;
  }

  if (left < MAX_TOKENS && lastComment.type === T_COMMENT) {
    v[left] = lastComment;
    left += 1;
  }
  return { tokens: v.slice(0, Math.min(left, MAX_TOKENS)), stats: tz.stats };
}

function buildFingerprint(buf: Buffer, quote: QuoteMode, dialect: Dialect): { fp: string; tokens: SqlToken[]; stats: TokenStats } {
  const { tokens, stats } = foldTokens(buf, quote, dialect);
  if (tokens.length > 2) {
    const last = tokens[tokens.length - 1];
    if (last.type === T_BAREWORD && last.strOpen === 0x60 && last.val.length === 0 && last.strClose === 0) {
      last.type = T_COMMENT;
    }
  }
  if (tokens.some((t) => t.type === T_EVIL)) {
    return { fp: "X", tokens: [tokens.find((t) => t.type === T_EVIL)!], stats };
  }
  return { fp: tokens.map((t) => String.fromCharCode(t.type)).join(""), tokens, stats };
}

function notWhitelist(inputBuf: Buffer, fp: string, tokens: SqlToken[], stats: TokenStats): boolean {
  if (!SQLI_FINGERPRINTS.has(fp)) return false;
  if (fp.length > 1 && tokens[fp.length - 1].type === T_COMMENT && inputBuf.includes("sp_password")) {
    return true;
  }
  if (fp.length === 2) {
    if (tokens[1].type === T_UNION) return stats.tokens !== 2;
    if (tokens[1].val.startsWith("#")) return false;
    if (tokens[0].type === T_BAREWORD && tokens[1].type === T_COMMENT && !tokens[1].val.startsWith("/")) {
      return false;
    }
    if (tokens[0].type === T_NUMBER && tokens[1].type === T_COMMENT) {
      if (tokens[1].val.startsWith("/")) return true;
      if (stats.tokens > 2) return true;
      const i = tokens[0].val.length;
      if (i >= inputBuf.length) return false;
      if (inputBuf[i] <= 32) return true;
      if (i + 1 < inputBuf.length) {
        if ((inputBuf[i] === 0x2f && inputBuf[i + 1] === 0x2a) || (inputBuf[i] === 0x2d && inputBuf[i + 1] === 0x2d)) {
          return true;
        }
      }
      return false;
    }
    if (tokens[1].val.length > 2 && tokens[1].val.startsWith("-")) return false;
  } else if (fp.length === 3) {
    if (fp === "sos" || fp === "s&s") {
      if (tokens[0].strOpen === 0 && tokens[2].strClose === 0 && tokens[0].strClose === tokens[2].strOpen) {
        return true;
      }
      return false;
    }
    if (fp === "s&n" || fp === "n&1" || fp === "1&1" || fp === "1&v" || fp === "1&s") {
      if (stats.tokens === 3) return false;
    } else if (tokens[1].type === T_KEYWORD) {
      if (tokens[1].val.length < 5 || !tokens[1].val.toUpperCase().startsWith("INTO")) return false;
    }
  }
  return true;
}

export type SqliContext = "none" | "as_is_ansi" | "as_is_mysql" | "single_ansi" | "single_mysql" | "double_mysql";

export function detectSqli(input: string | Buffer): { sqli: boolean; fingerprint: string; context: SqliContext } {
  const buf = typeof input === "string" ? Buffer.from(input, "latin1") : input;
  if (buf.length === 0) return { sqli: false, fingerprint: "", context: "none" };

  let f = buildFingerprint(buf, "none", "ansi");
  if (notWhitelist(buf, f.fp, f.tokens, f.stats)) return { sqli: true, fingerprint: f.fp, context: "as_is_ansi" };

  if (f.stats.commentDdx > 0 || f.stats.commentHash > 0) {
    f = buildFingerprint(buf, "none", "mysql");
    if (notWhitelist(buf, f.fp, f.tokens, f.stats)) return { sqli: true, fingerprint: f.fp, context: "as_is_mysql" };
  }

  if (buf.includes(0x27)) {
    f = buildFingerprint(buf, "single", "ansi");
    if (notWhitelist(buf, f.fp, f.tokens, f.stats)) return { sqli: true, fingerprint: f.fp, context: "single_ansi" };
    if (f.stats.commentDdx > 0 || f.stats.commentHash > 0) {
      f = buildFingerprint(buf, "single", "mysql");
      if (notWhitelist(buf, f.fp, f.tokens, f.stats)) return { sqli: true, fingerprint: f.fp, context: "single_mysql" };
    }
  }

  if (buf.includes(0x22)) {
    f = buildFingerprint(buf, "double", "mysql");
    if (notWhitelist(buf, f.fp, f.tokens, f.stats)) return { sqli: true, fingerprint: f.fp, context: "double_mysql" };
  }

  return { sqli: false, fingerprint: "", context: "none" };
}
