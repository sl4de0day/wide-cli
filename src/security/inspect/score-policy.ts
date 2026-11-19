import {
  evasionWeight,
  extractHttpZones,
  mustRejectSignals,
  type EvasionSignals,
  type InspectedField,
  type ZoneName,
  type ZonePart,
} from "./evasion-decode.js";
import { inspectHttpHeadersSmuggling, inspectRawHttpRequest, inspectRawHttpResponse } from "./http-conformance.js";
import { detectSqli } from "./lexical-sqli.js";
import { detectXss } from "./lexical-xss.js";
import { AhoCorasick, compileSafePattern, matchSafePattern, type SafeProgram } from "./safe-pattern.js";

export type InspectCategory = "sql" | "xss" | "rfi" | "traversal" | "upload" | "evade";
export type InspectAction = "pass" | "log" | "block" | "drop" | "reject";

export interface InspectTarget {
  zone: ZoneName;
  part?: ZonePart;
  name?: string;
}

export interface CoreRuleDef {
  id: number;
  kind: "sqli" | "xss" | "literal" | "regex";
  pattern?: string;
  targets: InspectTarget[];
  scores: Partial<Record<InspectCategory, number>>;
  msg: string;
  level: number;
  negate?: boolean;
}

export interface DatedExceptionRule {
  ruleIds: number[];
  pathPrefix?: string;
  zone?: ZoneName;
  paramName?: string;
  adjustments: Partial<Record<InspectCategory, number>>;
  until?: string;
  note?: string;
}

export interface InspectPolicy {
  level: number;
  learning: boolean;
  today?: string;
  thresholds: Record<InspectCategory, { limit: number; action: InspectAction }>;
  exceptions: DatedExceptionRule[];
}

export interface InspectRuleHit {
  ruleId: number;
  msg: string;
  zone: ZoneName;
  part: ZonePart;
  name: string;
  count: number;
  appliedScores: Partial<Record<InspectCategory, number>>;
  sample: string;
}

export interface ExceptionDraft {
  ruleId: number;
  zone: ZoneName;
  part: ZonePart;
  fieldName: string;
  sample: string;
  topCategory: InspectCategory;
  suggestedAdjustment: number;
  until: string;
  snippet: string;
}

export interface HttpInspectionReport {
  action: InspectAction;
  trigger: InspectCategory | null;
  scores: Record<InspectCategory, number>;
  hits: InspectRuleHit[];
  signals: EvasionSignals;
  smugglingVectors: string[];
  suppressed: number;
  expiredExceptions: number;
  uninspected: string | null;
  drafts: ExceptionDraft[];
}

export const DEFAULT_INSPECT_POLICY: InspectPolicy = {
  level: 2,
  learning: false,
  thresholds: {
    sql: { limit: 8, action: "block" },
    xss: { limit: 8, action: "block" },
    rfi: { limit: 8, action: "block" },
    traversal: { limit: 5, action: "block" },
    upload: { limit: 5, action: "block" },
    evade: { limit: 4, action: "log" },
  },
  exceptions: [],
};

export const CORE_INSPECT_RULES: CoreRuleDef[] = [
  { id: 1020, kind: "sqli", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "header" }], scores: { sql: 8 }, msg: "sqli heuristic: structural SQL pattern", level: 2 },
  { id: 1000, kind: "regex", pattern: "select|union|update|delete|insert|drop|load_file|group_concat|dumpfile", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "header" }], scores: { sql: 4 }, msg: "sql keyword", level: 2 },
  { id: 1001, kind: "literal", pattern: "'", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "header" }], scores: { sql: 4, xss: 8 }, msg: "single quote", level: 2 },
  { id: 1002, kind: "literal", pattern: "\"", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "header", name: "cookie" }], scores: { sql: 8, xss: 8 }, msg: "double quote", level: 2 },
  { id: 1008, kind: "regex", pattern: "union[^a-z]{0,12}select", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "header" }], scores: { sql: 8 }, msg: "union-select pattern", level: 2 },
  { id: 1003, kind: "literal", pattern: "--", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { sql: 4 }, msg: "sql comment (--)", level: 2 },
  { id: 1004, kind: "literal", pattern: "/*", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { sql: 8 }, msg: "sql comment (/*)", level: 2 },
  { id: 1006, kind: "literal", pattern: "@@", targets: [{ zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { sql: 4 }, msg: "mysql system variable", level: 2 },
  { id: 1120, kind: "xss", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "json", part: "path" }], scores: { xss: 6 }, msg: "xss heuristic: structural HTML5 vector", level: 2 },
  { id: 1100, kind: "literal", pattern: "<script", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "json", part: "path" }], scores: { xss: 8 }, msg: "script tag", level: 2 },
  { id: 1101, kind: "literal", pattern: "javascript:", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { xss: 8 }, msg: "javascript: URI scheme", level: 2 },
  { id: 1102, kind: "regex", pattern: "on(error|load|click|mouseover|focus|submit)[ \\t]*=", targets: [{ zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { xss: 8 }, msg: "html event handler", level: 2 },
  { id: 1103, kind: "literal", pattern: "<iframe", targets: [{ zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { xss: 8 }, msg: "iframe tag", level: 2 },
  { id: 1104, kind: "regex", pattern: "eval\\(|alert\\(|prompt\\(|atob\\(|settimeout\\(", targets: [{ zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { xss: 4 }, msg: "javascript call pattern", level: 2 },
  { id: 1200, kind: "regex", pattern: "(http|https|ftp|sftp|php|data|file|glob|phar|zip|expect|gopher|input)://", targets: [{ zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "header", name: "cookie" }], scores: { rfi: 8 }, msg: "remote scheme", level: 2 },
  { id: 1300, kind: "literal", pattern: "../", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "file", part: "name" }], scores: { traversal: 4 }, msg: "path traversal (../)", level: 2 },
  { id: 1301, kind: "literal", pattern: "..\\", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }, { zone: "file", part: "name" }], scores: { traversal: 4 }, msg: "path traversal (..\\)", level: 2 },
  { id: 1302, kind: "regex", pattern: "/etc/passwd|/proc/self|boot\\.ini|win\\.ini", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { traversal: 8 }, msg: "sensitive system file path", level: 2 },
  { id: 1400, kind: "regex", pattern: "\\.(php|phar|phtml|asp|aspx|jsp|jspx|cgi|pl|sh|exe)$", targets: [{ zone: "file", part: "name" }], scores: { upload: 8 }, msg: "executable upload extension", level: 2 },
  { id: 1501, kind: "literal", pattern: "%00", targets: [{ zone: "url" }, { zone: "args", part: "value" }, { zone: "body", part: "value" }], scores: { evade: 4 }, msg: "encoded null byte", level: 2 },
];

const ACTION_RANK: Record<InspectAction, number> = {
  pass: 0,
  log: 1,
  block: 2,
  drop: 3,
  reject: 4,
};

function maxAction(a: InspectAction, b: InspectAction): InspectAction {
  return ACTION_RANK[b] > ACTION_RANK[a] ? b : a;
}

const COMPILED_CACHE = new Map<number, SafeProgram>();
for (const r of CORE_INSPECT_RULES) {
  if (r.kind === "regex" && r.pattern) {
    COMPILED_CACHE.set(r.id, compileSafePattern(r.pattern, "i"));
  }
}

const LITERAL_AUTOMATON = new AhoCorasick(
  CORE_INSPECT_RULES.filter((r) => r.kind === "literal" && r.pattern).map((r) => ({ ruleId: r.id, literal: r.pattern! })),
  true,
);

function fieldMatchesRule(rule: CoreRuleDef, field: InspectedField): boolean {
  for (const t of rule.targets) {
    if (t.zone !== field.zone) continue;
    if (t.part && t.part !== field.part) continue;
    if (t.name && t.name.toLowerCase() !== field.name.toLowerCase()) continue;
    return true;
  }
  return false;
}

export function generateExceptionDraft(hit: InspectRuleHit, today = new Date().toISOString().slice(0, 10)): ExceptionDraft {
  const cats = Object.entries(hit.appliedScores).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  const topCat = (cats[0]?.[0] as InspectCategory) || "sql";
  const topWeight = Math.max(1, cats[0]?.[1] || 4);
  const delta = -Math.max(1, Math.floor(topWeight / 2));
  const targetExpr = hit.name ? `${hit.zone}.value[name="${hit.name}"]` : hit.zone;
  return {
    ruleId: hit.ruleId,
    zone: hit.zone,
    part: hit.part,
    fieldName: hit.name,
    sample: hit.sample.slice(0, 64),
    topCategory: topCat,
    suggestedAdjustment: delta,
    until: today,
    snippet: `# except rule ${hit.ruleId} in ${targetExpr} adjust ${topCat} ${delta} until ${today}`,
  };
}

export function evaluateHttpInspection(
  input: {
    url: string;
    method?: string;
    headers?: Array<[string, string]> | Record<string, string>;
    body?: string;
    rawRequest?: string;
    rawResponse?: string;
  },
  customPolicy?: Partial<InspectPolicy>,
): HttpInspectionReport {
  const policy: InspectPolicy = {
    level: customPolicy?.level ?? DEFAULT_INSPECT_POLICY.level,
    learning: customPolicy?.learning ?? DEFAULT_INSPECT_POLICY.learning,
    today: customPolicy?.today ?? new Date().toISOString().slice(0, 10),
    thresholds: customPolicy?.thresholds ?? DEFAULT_INSPECT_POLICY.thresholds,
    exceptions: customPolicy?.exceptions ?? DEFAULT_INSPECT_POLICY.exceptions,
  };

  const smugglingVectors: string[] = [];
  if (input.rawRequest) {
    const reqConf = inspectRawHttpRequest(input.rawRequest);
    if (!reqConf.ok) smugglingVectors.push(...reqConf.smugglingVectors);
  }
  if (input.rawResponse) {
    const resConf = inspectRawHttpResponse(input.rawResponse, input.method || "GET");
    if (!resConf.ok) smugglingVectors.push(...resConf.poisoningVectors);
  }
  const hdrPairs: Array<[string, string]> = Array.isArray(input.headers)
    ? input.headers
    : Object.entries(input.headers || {});
  if (hdrPairs.length > 0) {
    smugglingVectors.push(...inspectHttpHeadersSmuggling(hdrPairs));
  }

  const walk = extractHttpZones({ url: input.url, headers: hdrPairs, body: input.body });
  const hitsMap = new Map<string, InspectRuleHit>();
  const urlPath = (() => {
    try {
      return new URL(input.url).pathname;
    } catch {
      return input.url.split("?")[0];
    }
  })();

  const addHit = (rule: CoreRuleDef, field: InspectedField) => {
    const key = `${rule.id}:${field.zone}:${field.part}:${field.name}`;
    const existing = hitsMap.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    hitsMap.set(key, {
      ruleId: rule.id,
      msg: rule.msg,
      zone: field.zone,
      part: field.part,
      name: field.name,
      count: 1,
      appliedScores: {},
      sample: field.rawValue.slice(0, 80),
    });
  };

  for (const field of walk.fields) {
    if (!field.value) continue;
    const literalHits = new Set(LITERAL_AUTOMATON.scan(field.value).map((h) => h.ruleId));

    for (const rule of CORE_INSPECT_RULES) {
      if (rule.level > policy.level) continue;
      if (!fieldMatchesRule(rule, field)) continue;

      let matched = false;
      if (rule.kind === "literal") {
        matched = literalHits.has(rule.id);
      } else if (rule.kind === "regex") {
        const prog = COMPILED_CACHE.get(rule.id);
        matched = prog ? matchSafePattern(prog, field.value) : false;
      } else if (rule.kind === "sqli") {
        matched = detectSqli(field.value).sqli;
      } else if (rule.kind === "xss") {
        matched = detectXss(field.value).xss;
      }

      if (matched !== Boolean(rule.negate)) {
        addHit(rule, field);
      }
    }
  }

  const scores: Record<InspectCategory, number> = {
    sql: 0,
    xss: 0,
    rfi: 0,
    traversal: 0,
    upload: 0,
    evade: evasionWeight(walk.signals),
  };
  let suppressed = 0;
  let expiredExceptions = 0;

  const hits = Array.from(hitsMap.values());
  for (const h of hits) {
    const rule = CORE_INSPECT_RULES.find((r) => r.id === h.ruleId);
    if (!rule) continue;
    for (const [catKey, delta] of Object.entries(rule.scores) as Array<[InspectCategory, number]>) {
      let val = delta * Math.min(h.count, 8);
      for (const exc of policy.exceptions) {
        if (!exc.ruleIds.includes(h.ruleId)) continue;
        if (exc.pathPrefix && !urlPath.toLowerCase().startsWith(exc.pathPrefix.toLowerCase())) continue;
        if (exc.zone && exc.zone !== h.zone) continue;
        if (exc.paramName && exc.paramName.toLowerCase() !== h.name.toLowerCase()) continue;
        if (exc.until && policy.today && exc.until < policy.today) {
          expiredExceptions += 1;
          continue;
        }
        const adj = exc.adjustments[catKey];
        if (adj !== undefined) {
          const nextVal = Math.max(0, val + adj);
          suppressed += val - nextVal;
          val = nextVal;
        }
      }
      h.appliedScores[catKey] = val;
      scores[catKey] += val;
    }
  }

  let action: InspectAction = "pass";
  let trigger: InspectCategory | null = null;
  if (mustRejectSignals(walk.signals) || smugglingVectors.length > 0) {
    action = maxAction(action, "reject");
    trigger = "evade";
  }
  for (const cat of Object.keys(policy.thresholds) as InspectCategory[]) {
    const t = policy.thresholds[cat];
    if (scores[cat] >= t.limit) {
      const nextAct = maxAction(action, t.action);
      if (nextAct !== action && trigger === null) trigger = cat;
      action = nextAct;
    }
  }
  if (policy.learning && action === "block") action = "log";

  const drafts = policy.learning ? hits.map((h) => generateExceptionDraft(h, policy.today)) : [];

  return {
    action,
    trigger,
    scores,
    hits,
    signals: walk.signals,
    smugglingVectors: Array.from(new Set(smugglingVectors)),
    suppressed,
    expiredExceptions,
    uninspected: walk.uninspected,
    drafts,
  };
}
