import type { HttpInspectionReport } from "../security/inspect.js";
import { horizontalRule, padEndAnsi, termWidth, truncateAnsi } from "./ansi.js";
import { glyphs, theme } from "./theme.js";

export function formatCrawlReport(result: any): string {
  const cols = Math.min(termWidth(80) - 2, 100);
  const pages = Array.isArray(result?.pages) ? result.pages : [];
  const endpoints = Array.isArray(result?.endpoints) ? result.endpoints : [];
  const totalIssues = pages.reduce((acc: number, p: any) => acc + Number(p.securityIssues || 0), 0);
  const totalSecrets = pages.reduce((acc: number, p: any) => acc + Number(p.secretCount || 0), 0);
  const totalJwts = pages.reduce((acc: number, p: any) => acc + Number(p.jwtCount || 0), 0);
  const flaggedPages = pages.filter((p: any) => p.inspectAction && p.inspectAction !== "pass");

  const lines: string[] = [
    "",
    `  ${theme.fgBold("Wide Crawl Report")}  ${theme.faint(result?.engine || "spider")}`,
    `  ${horizontalRule(Math.max(36, cols))}`,
    `  ${theme.faint("Seed:")}       ${theme.info(String(result?.seed || ""))}`,
    `  ${theme.faint("Visited:")}    ${theme.fgBold(String(result?.visited ?? pages.length))} page(s) ${theme.faint(glyphs.middot)} ${theme.fgBold(String(endpoints.length))} unique endpoint(s)`,
    `  ${theme.faint("Audit:")}      ${totalIssues > 0 ? theme.warn(`${totalIssues} header issue(s)`) : theme.ok("0 header issues")} ${theme.faint(glyphs.middot)} ${totalSecrets > 0 ? theme.error(`${totalSecrets} secret(s)`) : theme.muted("0 secrets")} ${theme.faint(glyphs.middot)} ${theme.muted(`${totalJwts} JWT(s)`)}`,
  ];

  if (pages.length > 0) {
    lines.push("", `  ${theme.accentBold("Crawled Pages")}`);
    for (const p of pages.slice(0, 25)) {
      const code = Number(p.status || 0);
      const statusBadge =
        code >= 500
          ? theme.error(String(code))
          : code >= 400
            ? theme.warn(String(code))
            : code >= 200
              ? theme.ok(String(code))
              : theme.faint(String(code));
      const alerts: string[] = [];
      if (p.secretCount > 0) alerts.push(theme.error(`${p.secretCount} secret`));
      if (p.securityIssues > 0) alerts.push(theme.warn(`${p.securityIssues} hdr`));
      if (p.inspectAction && p.inspectAction !== "pass") alerts.push(theme.high(`inspect:${p.inspectAction}`));
      const meta = alerts.length > 0 ? `  ${alerts.join(" ")}` : "";
      lines.push(`    ${padEndAnsi(statusBadge, 5)} ${truncateAnsi(theme.fg(String(p.url || "")), Math.max(24, cols - 28))}${meta}`);
    }
    if (pages.length > 25) {
      lines.push(`    ${theme.faint(`${glyphs.ellipsis} and ${pages.length - 25} more page(s) (pass --json for full output)`)}`);
    }
  }

  if (flaggedPages.length > 0) {
    lines.push("", `  ${theme.highBold("Inspection Alerts")}`);
    for (const fp of flaggedPages.slice(0, 10)) {
      lines.push(`    ${theme.high(glyphs.warn)} ${theme.info(fp.url)} ${theme.faint(`(${fp.inspectAction}${fp.inspectTrigger ? `:${fp.inspectTrigger}` : ""})`)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function formatInspectReport(targetUrl: string, method: string, report: HttpInspectionReport): string {
  const cols = Math.min(termWidth(80) - 2, 100);
  const actionTone =
    report.action === "block" || report.action === "drop" || report.action === "reject"
      ? "error"
      : report.action === "log"
        ? "warn"
        : "ok";

  const scoreParts = Object.entries(report.scores || {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k}:${v}`);

  const lines: string[] = [
    "",
    `  ${theme.fgBold("Wide HTTP Inspection")}  ${theme.pill(report.action.toUpperCase(), actionTone)}`,
    `  ${horizontalRule(Math.max(36, cols))}`,
    `  ${theme.faint("Target:")}     ${theme.accentBold(method.toUpperCase())} ${theme.info(targetUrl)}`,
    `  ${theme.faint("Trigger:")}    ${report.trigger ? theme.highBold(report.trigger.toUpperCase()) : theme.ok("none")}`,
    `  ${theme.faint("Scores:")}     ${scoreParts.length > 0 ? theme.warn(scoreParts.join("  ")) : theme.ok("0 (clean)")}`,
  ];

  if (report.smugglingVectors.length > 0) {
    lines.push(`  ${theme.faint("Smuggling:")}  ${theme.errorBold(report.smugglingVectors.join(", "))}`);
  }

  const activeSignals = Object.entries(report.signals || {})
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
  if (activeSignals.length > 0) {
    lines.push(`  ${theme.faint("Evasion:")}    ${theme.warn(activeSignals.join(", "))}`);
  }

  if (report.hits.length > 0) {
    lines.push("", `  ${theme.accentBold(`Matched Rules (${report.hits.length})`)}`);
    for (const h of report.hits.slice(0, 20)) {
      const scoreDesc = Object.entries(h.appliedScores || {})
        .map(([k, v]) => `${k}+${v}`)
        .join(",");
      lines.push(
        `    ${theme.info(`#${h.ruleId}`)} ${theme.fgBold(h.msg)} ${theme.faint(`[${h.zone}.${h.part}${h.name ? `:${h.name}` : ""}]`)} ${theme.warn(scoreDesc)}`,
      );
      if (h.sample) {
        lines.push(`      ${theme.border(glyphs.elbow)} ${theme.muted(truncateAnsi(h.sample, Math.max(24, cols - 12)))}`);
      }
    }
  } else {
    lines.push("", `  ${theme.ok(glyphs.dot)} ${theme.muted("No injection, smuggling, or policy rule hits detected.")}`);
  }

  if (report.drafts.length > 0) {
    lines.push("", `  ${theme.accentBold(`Exception Drafts (${report.drafts.length})`)}`);
    for (const d of report.drafts.slice(0, 10)) {
      lines.push(`    ${theme.info(d.snippet)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
