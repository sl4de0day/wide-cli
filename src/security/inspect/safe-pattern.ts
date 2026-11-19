export type SafePatternErrorCode =
  | "EmptyPattern"
  | "PatternTooLong"
  | "UnbalancedParen"
  | "UnbalancedBracket"
  | "InvalidEscape"
  | "InvalidQuantifier"
  | "NothingToRepeat"
  | "ProgramTooLarge"
  | "BackreferenceUnsupported"
  | "LookaroundUnsupported"
  | "BacktrackControlUnsupported";

export interface CharClass {
  bits: Uint32Array;
}

type Inst =
  | { op: "class"; clsIdx: number }
  | { op: "split"; a: number; b: number }
  | { op: "jmp"; target: number }
  | { op: "assert_start" }
  | { op: "assert_end" }
  | { op: "match" };

export interface SafeProgram {
  pattern: string;
  caseInsensitive: boolean;
  insts: Inst[];
  classes: CharClass[];
  prefilterLiterals: string[];
  hasStartAnchor: boolean;
}

const MAX_PATTERN_BYTES = 4096;
const MAX_INSTS = 2048;

function makeEmptyClass(): CharClass {
  return { bits: new Uint32Array(8) };
}

function setBit(cls: CharClass, byte: number, caseInsensitive = false): void {
  const b = byte & 0xff;
  cls.bits[b >>> 5] |= 1 << (b & 31);
  if (caseInsensitive) {
    if (b >= 0x41 && b <= 0x5a) {
      const low = b | 0x20;
      cls.bits[low >>> 5] |= 1 << (low & 31);
    } else if (b >= 0x61 && b <= 0x7a) {
      const up = b & ~0x20;
      cls.bits[up >>> 5] |= 1 << (up & 31);
    }
  }
}

function hasBit(cls: CharClass, byte: number): boolean {
  const b = byte & 0xff;
  return (cls.bits[b >>> 5] & (1 << (b & 31))) !== 0;
}

function invertClass(cls: CharClass): void {
  for (let i = 0; i < 8; i += 1) cls.bits[i] = (~cls.bits[i]) >>> 0;
}

function addShorthand(cls: CharClass, esc: string): boolean {
  if (esc === "d" || esc === "D") {
    const neg = esc === "D";
    for (let c = 0; c < 256; c += 1) {
      const hit = c >= 0x30 && c <= 0x39;
      if (hit !== neg) setBit(cls, c);
    }
    return true;
  }
  if (esc === "w" || esc === "W") {
    const neg = esc === "W";
    for (let c = 0; c < 256; c += 1) {
      const hit = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
      if (hit !== neg) setBit(cls, c);
    }
    return true;
  }
  if (esc === "s" || esc === "S") {
    const neg = esc === "S";
    for (let c = 0; c < 256; c += 1) {
      const hit = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
      if (hit !== neg) setBit(cls, c);
    }
    return true;
  }
  return false;
}

function failPattern(code: SafePatternErrorCode, msg: string): never {
  const err = new Error(`${code}: ${msg}`) as Error & { code: SafePatternErrorCode };
  err.code = code;
  throw err;
}

function parseEscapeChar(pat: string, pos: number): { ch: number; nextPos: number; shorthand?: string } {
  if (pos >= pat.length) failPattern("InvalidEscape", "trailing backslash");
  const c = pat[pos];
  if (c >= "1" && c <= "9") {
    failPattern("BackreferenceUnsupported", `backreference \\${c} rejected to prevent exponential backtracking`);
  }
  if ("dDwWsS".includes(c)) return { ch: -1, nextPos: pos + 1, shorthand: c };
  if (c === "n") return { ch: 0x0a, nextPos: pos + 1 };
  if (c === "r") return { ch: 0x0d, nextPos: pos + 1 };
  if (c === "t") return { ch: 0x09, nextPos: pos + 1 };
  if (c === "0") return { ch: 0, nextPos: pos + 1 };
  if (c === "x" && pos + 2 < pat.length && /^[0-9a-fA-F]{2}$/.test(pat.slice(pos + 1, pos + 3))) {
    return { ch: Number.parseInt(pat.slice(pos + 1, pos + 3), 16), nextPos: pos + 3 };
  }
  return { ch: c.charCodeAt(0) & 0xff, nextPos: pos + 1 };
}

class RegexCompiler {
  pos = 0;
  readonly insts: Inst[] = [];
  readonly classes: CharClass[] = [];

  constructor(
    readonly src: string,
    readonly caseInsensitive: boolean,
  ) {}

  private addClass(cls: CharClass): number {
    const idx = this.classes.length;
    this.classes.push(cls);
    return idx;
  }

  private emit(inst: Inst): number {
    if (this.insts.length >= MAX_INSTS) failPattern("ProgramTooLarge", "compiled pattern exceeds instruction limit");
    const idx = this.insts.length;
    this.insts.push(inst);
    return idx;
  }

  private cloneSlice(slice: Inst[], offset: number): Inst[] {
    return slice.map((inst) => {
      if (inst.op === "split") return { op: "split", a: inst.a + offset, b: inst.b + offset };
      if (inst.op === "jmp") return { op: "jmp", target: inst.target + offset };
      return { ...inst };
    });
  }

  parseAlternation(): void {
    const branchStarts: number[] = [];
    const jmpsToEnd: number[] = [];

    while (true) {
      const splitIdx = this.emit({ op: "split", a: 0, b: 0 });
      branchStarts.push(splitIdx);
      const bodyStart = this.insts.length;
      this.parseConcat();
      if (this.pos < this.src.length && this.src[this.pos] === "|") {
        this.pos += 1;
        const jmpIdx = this.emit({ op: "jmp", target: 0 });
        jmpsToEnd.push(jmpIdx);
        const sp = this.insts[splitIdx];
        if (sp.op === "split") {
          sp.a = bodyStart;
          sp.b = this.insts.length;
        }
        continue;
      }
      if (branchStarts.length === 1) {
        const body = this.insts.slice(bodyStart);
        this.insts.length = splitIdx;
        const shifted = this.cloneSlice(body, -1);
        for (const inst of shifted) this.emit(inst);
        break;
      }
      const sp = this.insts[splitIdx];
      if (sp.op === "split") {
        this.insts[splitIdx] = { op: "jmp", target: bodyStart };
      }
      const end = this.insts.length;
      for (const j of jmpsToEnd) {
        const jmpInst = this.insts[j];
        if (jmpInst.op === "jmp") jmpInst.target = end;
      }
      break;
    }
  }

  parseConcat(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === ")" || ch === "|") break;
      this.parseQuantifiedAtom();
    }
  }

  parseQuantifiedAtom(): void {
    const atomStart = this.insts.length;
    this.parseAtom();
    const atomEnd = this.insts.length;
    if (atomEnd === atomStart) {
      if (this.pos < this.src.length && "*+?{".includes(this.src[this.pos])) {
        failPattern("NothingToRepeat", `quantifier at ${this.pos} has no atom`);
      }
      return;
    }

    if (this.pos >= this.src.length) return;
    const q = this.src[this.pos];
    let min = 1;
    let max: number | null = 1;
    if (q === "*") {
      min = 0;
      max = null;
      this.pos += 1;
    } else if (q === "+") {
      min = 1;
      max = null;
      this.pos += 1;
    } else if (q === "?") {
      min = 0;
      max = 1;
      this.pos += 1;
    } else if (q === "{") {
      const close = this.src.indexOf("}", this.pos + 1);
      if (close < 0) failPattern("InvalidQuantifier", "unclosed {m,n} quantifier");
      const inner = this.src.slice(this.pos + 1, close);
      if (!inner) failPattern("InvalidQuantifier", "empty {} quantifier");
      const comma = inner.indexOf(",");
      if (comma < 0) {
        if (!/^\d+$/.test(inner)) failPattern("InvalidQuantifier", `invalid count ${inner}`);
        min = Number(inner);
        max = min;
      } else {
        const lo = inner.slice(0, comma);
        const hi = inner.slice(comma + 1);
        if (!/^\d+$/.test(lo) || (hi && !/^\d+$/.test(hi))) {
          failPattern("InvalidQuantifier", `invalid range ${inner}`);
        }
        min = Number(lo);
        max = hi ? Number(hi) : null;
        if (max !== null && max < min) failPattern("InvalidQuantifier", `max < min in ${inner}`);
      }
      if (min > 256 || (max !== null && max > 256)) failPattern("InvalidQuantifier", "quantifier bound too large");
      this.pos = close + 1;
    } else {
      return;
    }

    if (this.pos < this.src.length) {
      if (this.src[this.pos] === "+") failPattern("BacktrackControlUnsupported", "possessive quantifiers are unsupported");
      if (this.src[this.pos] === "?") this.pos += 1;
    }

    const atom = this.cloneSlice(this.insts.slice(atomStart), -atomStart);
    this.insts.length = atomStart;

    for (let i = 0; i < min; i += 1) {
      const base = this.insts.length;
      for (const inst of this.cloneSlice(atom, base)) this.emit(inst);
    }

    if (max !== null) {
      const splits: number[] = [];
      for (let i = min; i < max; i += 1) {
        const sp = this.emit({ op: "split", a: 0, b: 0 });
        const bodyBase = this.insts.length;
        for (const inst of this.cloneSlice(atom, bodyBase)) this.emit(inst);
        const spInst = this.insts[sp];
        if (spInst.op === "split") spInst.a = bodyBase;
        splits.push(sp);
      }
      const end = this.insts.length;
      for (const sp of splits) {
        const spInst = this.insts[sp];
        if (spInst.op === "split") spInst.b = end;
      }
    } else {
      const sp = this.emit({ op: "split", a: 0, b: 0 });
      const bodyBase = this.insts.length;
      for (const inst of this.cloneSlice(atom, bodyBase)) this.emit(inst);
      this.emit({ op: "jmp", target: sp });
      const spInst = this.insts[sp];
      if (spInst.op === "split") {
        spInst.a = bodyBase;
        spInst.b = this.insts.length;
      }
    }
  }

  parseAtom(): void {
    const ch = this.src[this.pos];
    if (ch === "^") {
      this.pos += 1;
      this.emit({ op: "assert_start" });
      return;
    }
    if (ch === "$") {
      this.pos += 1;
      this.emit({ op: "assert_end" });
      return;
    }
    if (ch === ".") {
      this.pos += 1;
      const cls = makeEmptyClass();
      for (let c = 0; c < 256; c += 1) {
        if (c !== 0x0a) setBit(cls, c);
      }
      this.emit({ op: "class", clsIdx: this.addClass(cls) });
      return;
    }
    if (ch === "[") {
      this.parseBracketClass();
      return;
    }
    if (ch === "(") {
      this.pos += 1;
      if (this.pos < this.src.length && this.src[this.pos] === "?") {
        const tail = this.src.slice(this.pos + 1);
        if (tail.startsWith("=") || tail.startsWith("!") || tail.startsWith("<=") || tail.startsWith("<!")) {
          failPattern("LookaroundUnsupported", "lookaround assertions are unsupported");
        }
        if (tail.startsWith(":")) {
          this.pos += 2;
        } else if (tail.startsWith(">")) {
          failPattern("BacktrackControlUnsupported", "atomic groups are unsupported");
        } else {
          failPattern("LookaroundUnsupported", "unsupported special group");
        }
      }
      this.parseAlternation();
      if (this.pos >= this.src.length || this.src[this.pos] !== ")") {
        failPattern("UnbalancedParen", "missing closing )");
      }
      this.pos += 1;
      return;
    }
    if (ch === "\\") {
      const esc = parseEscapeChar(this.src, this.pos + 1);
      this.pos = esc.nextPos;
      const cls = makeEmptyClass();
      if (esc.shorthand) addShorthand(cls, esc.shorthand);
      else setBit(cls, esc.ch, this.caseInsensitive);
      this.emit({ op: "class", clsIdx: this.addClass(cls) });
      return;
    }
    if ("*+?{|)".includes(ch)) return;
    this.pos += 1;
    const cls = makeEmptyClass();
    setBit(cls, ch.charCodeAt(0) & 0xff, this.caseInsensitive);
    this.emit({ op: "class", clsIdx: this.addClass(cls) });
  }

  parseBracketClass(): void {
    this.pos += 1;
    let negated = false;
    if (this.pos < this.src.length && this.src[this.pos] === "^") {
      negated = true;
      this.pos += 1;
    }
    const cls = makeEmptyClass();
    let first = true;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === "]" && !first) {
        this.pos += 1;
        if (negated) invertClass(cls);
        this.emit({ op: "class", clsIdx: this.addClass(cls) });
        return;
      }
      first = false;
      let code: number;
      if (c === "\\") {
        const esc = parseEscapeChar(this.src, this.pos + 1);
        this.pos = esc.nextPos;
        if (esc.shorthand) {
          addShorthand(cls, esc.shorthand);
          continue;
        }
        code = esc.ch;
      } else {
        code = c.charCodeAt(0) & 0xff;
        this.pos += 1;
      }
      if (this.pos + 1 < this.src.length && this.src[this.pos] === "-" && this.src[this.pos + 1] !== "]") {
        this.pos += 1;
        const endChar = this.src[this.pos];
        let endCode: number;
        if (endChar === "\\") {
          const esc2 = parseEscapeChar(this.src, this.pos + 1);
          if (esc2.shorthand) failPattern("InvalidEscape", "cannot use shorthand in range");
          this.pos = esc2.nextPos;
          endCode = esc2.ch;
        } else {
          endCode = endChar.charCodeAt(0) & 0xff;
          this.pos += 1;
        }
        if (endCode < code) failPattern("UnbalancedBracket", "reversed range in [...]");
        for (let k = code; k <= endCode; k += 1) setBit(cls, k, this.caseInsensitive);
      } else {
        setBit(cls, code, this.caseInsensitive);
      }
    }
    failPattern("UnbalancedBracket", "missing closing ]");
  }
}

function extractSimpleLiterals(pattern: string, caseInsensitive: boolean): string[] {
  const parts = pattern.replace(/^\(\?[ims]+\)/i, "").split("|");
  if (parts.length > 1) {
    const lits = parts.map((p) => p.replace(/[^A-Za-z0-9_./:-]/g, "")).filter((l) => l.length >= 3);
    return lits.length === parts.length ? lits.map((l) => (caseInsensitive ? l.toLowerCase() : l)) : [];
  }
  const runs = pattern.match(/[A-Za-z0-9_./:-]{3,}/g) || [];
  let best = "";
  for (const r of runs) {
    const idx = pattern.indexOf(r);
    const nextChar = pattern[idx + r.length];
    if (nextChar === "*" || nextChar === "?" || nextChar === "{") continue;
    if (r.length > best.length) best = r;
  }
  if (!best) return [];
  return [caseInsensitive ? best.toLowerCase() : best];
}

export function compileSafePattern(pattern: string, flags = ""): SafeProgram {
  if (!pattern) failPattern("EmptyPattern", "pattern cannot be empty");
  if (pattern.length > MAX_PATTERN_BYTES) failPattern("PatternTooLong", "pattern exceeds length limit");
  let cleanPat = pattern;
  let ci = flags.includes("i");
  if (cleanPat.startsWith("(?i)")) {
    ci = true;
    cleanPat = cleanPat.slice(4);
  }
  if (/\\[1-9]/.test(cleanPat)) failPattern("BackreferenceUnsupported", "backreferences are unsupported");
  if (/\(\?(?:[=!<]|>)/.test(cleanPat)) {
    failPattern("LookaroundUnsupported", "lookarounds and atomic groups are unsupported");
  }
  const compiler = new RegexCompiler(cleanPat, ci);
  compiler.parseAlternation();
  if (compiler.pos !== cleanPat.length) failPattern("UnbalancedParen", "unexpected trailing )");
  compiler.insts.push({ op: "match" });
  return {
    pattern,
    caseInsensitive: ci,
    insts: compiler.insts,
    classes: compiler.classes,
    prefilterLiterals: extractSimpleLiterals(cleanPat, ci),
    hasStartAnchor: cleanPat.startsWith("^"),
  };
}

export function isSafePattern(pattern: string): { safe: boolean; reason?: string } {
  try {
    compileSafePattern(pattern);
    return { safe: true };
  } catch (err) {
    return { safe: false, reason: String((err as Error)?.message || err) };
  }
}

export function matchSafePattern(prog: SafeProgram, input: string): boolean {
  if (prog.prefilterLiterals.length > 0) {
    const hay = prog.caseInsensitive ? input.toLowerCase() : input;
    let any = false;
    for (const lit of prog.prefilterLiterals) {
      if (hay.includes(lit)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }

  const insts = prog.insts;
  const n = insts.length;
  let clist: number[] = [];
  let nlist: number[] = [];
  const mark = new Int32Array(n).fill(-1);
  let gen = 0;

  const addState = (target: number[], idx: number, pos: number, len: number): void => {
    const stack = [idx];
    while (stack.length > 0) {
      const pc = stack.pop()!;
      if (mark[pc] === gen) continue;
      mark[pc] = gen;
      const inst = insts[pc];
      if (inst.op === "split") {
        stack.push(inst.b, inst.a);
      } else if (inst.op === "jmp") {
        stack.push(inst.target);
      } else if (inst.op === "assert_start") {
        if (pos === 0 || input.charCodeAt(pos - 1) === 0x0a) stack.push(pc + 1);
      } else if (inst.op === "assert_end") {
        if (pos === len || input.charCodeAt(pos) === 0x0a) stack.push(pc + 1);
      } else {
        target.push(pc);
      }
    }
  };

  const startMax = prog.hasStartAnchor ? 1 : input.length + 1;
  for (let startPos = 0; startPos < startMax; startPos += 1) {
    if (prog.hasStartAnchor && startPos > 0) break;
    clist.length = 0;
    gen += 1;
    addState(clist, 0, startPos, input.length);
    for (const pc of clist) {
      if (insts[pc].op === "match") return true;
    }
    for (let pos = startPos; pos < input.length && clist.length > 0; pos += 1) {
      const byte = input.charCodeAt(pos) & 0xff;
      nlist.length = 0;
      gen += 1;
      for (const pc of clist) {
        const inst = insts[pc];
        if (inst.op === "class" && hasBit(prog.classes[inst.clsIdx], byte)) {
          addState(nlist, pc + 1, pos + 1, input.length);
        }
      }
      for (const pc of nlist) {
        if (insts[pc].op === "match") return true;
      }
      const tmp = clist;
      clist = nlist;
      nlist = tmp;
    }
  }
  return false;
}

interface AcNode {
  next: Map<number, number>;
  fail: number;
  out: Array<{ ruleId: number; len: number }>;
}

export function hasNestedQuantifiers(pattern: string): boolean {
  const groupHasRepeat = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern);
  return groupHasRepeat || /\\[1-9]/.test(pattern);
}

export function testUserRegexSafe(
  pattern: string,
  flags: string,
  sample: string,
): { ok: true; engine: "nfa" | "guarded"; matches: Array<{ line: number; text: string }> } | { ok: false; error: string } {
  if (!pattern) return { ok: false, error: "No pattern." };
  if (hasNestedQuantifiers(pattern)) {
    return { ok: false, error: "Unsafe / ReDoS-prone regex pattern rejected (nested quantifiers or backreference)." };
  }
  const safeFlags = typeof flags === "string" ? flags.replace(/[^gimsuy]/g, "") : "";
  const lines = String(sample || "").split("\n");
  try {
    const prog = compileSafePattern(pattern, safeFlags);
    const matches: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (matchSafePattern(prog, lines[i])) {
        matches.push({ line: i + 1, text: lines[i].slice(0, 200) });
        if (matches.length >= 100) break;
      }
    }
    return { ok: true, engine: "nfa", matches };
  } catch (err) {
    const code = (err as { code?: SafePatternErrorCode })?.code;
    if (code === "BackreferenceUnsupported" || code === "BacktrackControlUnsupported" || code === "PatternTooLong") {
      return { ok: false, error: String((err as Error)?.message || err) };
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, safeFlags);
    } catch (reErr) {
      return { ok: false, error: String((reErr as Error)?.message || reErr) };
    }
    const matches: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      if (re.test(lines[i])) matches.push({ line: i + 1, text: lines[i].slice(0, 200) });
      if (matches.length >= 100) break;
    }
    return { ok: true, engine: "guarded", matches };
  }
}

export class AhoCorasick {
  private readonly nodes: AcNode[] = [{ next: new Map(), fail: 0, out: [] }];
  private readonly caseInsensitive: boolean;

  constructor(patterns: Array<{ ruleId: number; literal: string }>, caseInsensitive = true) {
    this.caseInsensitive = caseInsensitive;
    for (const p of patterns) {
      const lit = caseInsensitive ? p.literal.toLowerCase() : p.literal;
      if (!lit) continue;
      let cur = 0;
      for (let i = 0; i < lit.length; i += 1) {
        const c = lit.charCodeAt(i) & 0xff;
        let nx = this.nodes[cur].next.get(c);
        if (nx === undefined) {
          nx = this.nodes.length;
          this.nodes.push({ next: new Map(), fail: 0, out: [] });
          this.nodes[cur].next.set(c, nx);
        }
        cur = nx;
      }
      this.nodes[cur].out.push({ ruleId: p.ruleId, len: lit.length });
    }
    const queue: number[] = [];
    for (const [, child] of this.nodes[0].next) queue.push(child);
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const [ch, v] of this.nodes[u].next) {
        let f = this.nodes[u].fail;
        while (f !== 0 && !this.nodes[f].next.has(ch)) f = this.nodes[f].fail;
        const fNext = this.nodes[f].next.get(ch) ?? 0;
        this.nodes[v].fail = fNext;
        if (this.nodes[fNext].out.length > 0) {
          this.nodes[v].out.push(...this.nodes[fNext].out);
        }
        queue.push(v);
      }
    }
  }

  scan(input: string): Array<{ ruleId: number; end: number; len: number }> {
    const src = this.caseInsensitive ? input.toLowerCase() : input;
    const hits: Array<{ ruleId: number; end: number; len: number }> = [];
    let state = 0;
    for (let i = 0; i < src.length; i += 1) {
      const c = src.charCodeAt(i) & 0xff;
      while (state !== 0 && !this.nodes[state].next.has(c)) state = this.nodes[state].fail;
      state = this.nodes[state].next.get(c) ?? 0;
      const out = this.nodes[state].out;
      for (let k = 0; k < out.length; k += 1) {
        hits.push({ ruleId: out[k].ruleId, end: i + 1, len: out[k].len });
      }
    }
    return hits;
  }
}
