import { padEndAnsi, truncateAnsi } from "../ansi.js";
import { glyphs, theme } from "../theme.js";

export interface TypeaheadItem {
  insertText: string;
  label: string;
  description?: string;
  badge?: string;
  score?: number;
}

export function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 800 - Math.min(200, c.length - q.length);
  const idx = c.indexOf(q);
  if (idx >= 0) {
    const boundaryBonus = idx === 0 || "/_- .".includes(c[idx - 1]) ? 120 : 0;
    return 500 + boundaryBonus - idx * 2 - Math.min(100, c.length);
  }
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      consecutive++;
      const boundary = ci === 0 || "/_- .".includes(c[ci - 1]) ? 15 : 0;
      score += 10 + consecutive * 6 + boundary;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  if (qi < q.length) return 0;
  return Math.max(1, score - Math.floor(c.length / 4));
}

export interface SlashSuggestionSource {
  command: string;
  usage: string;
  description: string;
  category?: string;
}

export function filterSlashSuggestions(query: string, commands: readonly SlashSuggestionSource[], limit = 10): TypeaheadItem[] {
  const clean = query.startsWith("/") ? query.slice(1) : query;
  const scored: Array<TypeaheadItem & { score: number }> = [];
  for (const item of commands) {
    const cmdName = item.command.startsWith("/") ? item.command.slice(1) : item.command;
    const sCmd = fuzzyScore(clean, cmdName);
    const sDesc = clean ? Math.floor(fuzzyScore(clean, item.description) * 0.4) : 0;
    const score = Math.max(sCmd, sDesc);
    if (score > 0) {
      scored.push({
        insertText: item.command,
        label: item.usage,
        description: item.description,
        badge: item.category,
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit);
}

export function filterFileSuggestions(
  query: string,
  workspaceFiles: readonly string[],
  modifiedFiles?: ReadonlySet<string>,
  limit = 10,
): TypeaheadItem[] {
  const scored: Array<TypeaheadItem & { score: number }> = [];
  for (const rel of workspaceFiles) {
    const baseScore = fuzzyScore(query, rel);
    if (baseScore <= 0) continue;
    const isMod = modifiedFiles?.has(rel) ? 140 : 0;
    scored.push({
      insertText: `@${rel}`,
      label: rel,
      badge: isMod ? "modified" : undefined,
      score: baseScore + isMod,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit);
}

export function renderTypeaheadPopup(
  title: string,
  items: readonly TypeaheadItem[],
  selectedIdx: number,
  maxWidth: number,
  maxVisible = 7,
): string[] {
  if (items.length === 0) return [];
  const total = items.length;
  const clampedIdx = Math.max(0, Math.min(total - 1, selectedIdx));
  let start = 0;
  if (total > maxVisible) {
    start = Math.max(0, Math.min(total - maxVisible, clampedIdx - Math.floor(maxVisible / 2)));
  }
  const visible = items.slice(start, start + maxVisible);
  const w = Math.max(32, maxWidth);
  const labelW = Math.min(30, Math.max(14, ...visible.map((it) => it.label.length + 1)));

  const lines: string[] = [];
  const counter = total > maxVisible ? ` ${theme.faint(`(${clampedIdx + 1}/${total})`)}` : "";
  lines.push(`  ${theme.faint(title)}${counter} ${theme.faint(`${glyphs.middot} Tab complete ${glyphs.middot} Enter select ${glyphs.middot} Esc close`)}`);

  for (let i = 0; i < visible.length; i++) {
    const idx = start + i;
    const item = visible[i];
    const active = idx === clampedIdx;
    const pointer = active ? theme.accentBold(glyphs.pointer) : " ";
    const badgeText = item.badge ? ` ${theme.faint(`[${item.badge}]`)}` : "";
    const labelStr = padEndAnsi(truncateAnsi(item.label, labelW), labelW);
    const descAvail = Math.max(8, w - labelW - 10);
    const descStr = item.description ? truncateAnsi(item.description, descAvail) : "";

    if (active) {
      const rowContent = `${glyphs.pointer} ${padEndAnsi(truncateAnsi(item.label, labelW), labelW)}  ${descStr}`;
      lines.push(`  ${theme.selectedRow(padEndAnsi(truncateAnsi(rowContent, w - 4), Math.min(w - 4, 96)))}`);
    } else {
      lines.push(
        `  ${pointer} ${theme.info(labelStr)}  ${theme.muted(descStr)}${badgeText}`,
      );
    }
  }

  return lines;
}
