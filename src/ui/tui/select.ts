import { displayWidth, padEndAnsi, termWidth, truncateAnsi } from "../ansi.js";
import { glyphs, theme } from "../theme.js";
import { InlineDock, type DockHitRegion } from "./dock.js";
import { disableTerminalInputModes, enableTerminalInputModes, RawKeyParser } from "./keys.js";
import { fuzzyScore } from "./typeahead.js";

export interface SelectOption<T = string> {
  value: T;
  label: string;
  description?: string;
  badge?: string;
  badgeTone?: "accent" | "info" | "ok" | "warn" | "high" | "error" | "muted";
  disabled?: boolean;
}

export interface SelectOptions<T> {
  title: string;
  subtitle?: string;
  options: SelectOption<T>[];
  initialIndex?: number;
  searchable?: boolean;
  maxVisible?: number;
  allowDelete?: boolean;
  onDelete?: (item: SelectOption<T>) => boolean;
  extraHints?: string;
  signal?: AbortSignal;
}

export async function runInteractiveSelect<T>(opts: SelectOptions<T>): Promise<T | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || opts.options.length === 0) {
    return null;
  }

  return new Promise((resolveSelect) => {
    const dock = new InlineDock(process.stdout);
    let items = [...opts.options];
    let query = "";
    let selected = Math.max(0, Math.min(items.length - 1, opts.initialIndex ?? 0));
    let done = false;
    const maxVisible = opts.maxVisible ?? 10;

    const getFiltered = (): SelectOption<T>[] => {
      if (!query.trim()) return items;
      return items
        .map((it) => ({
          it,
          score: Math.max(
            fuzzyScore(query, it.label),
            it.description ? Math.floor(fuzzyScore(query, it.description) * 0.6) : 0,
            it.badge ? Math.floor(fuzzyScore(query, it.badge) * 0.5) : 0,
          ),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.it);
    };

    const render = () => {
      const filtered = getFiltered();
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
      const cols = Math.max(40, termWidth(80));
      const boxW = Math.min(cols - 2, 100);
      const innerW = Math.max(24, boxW - 4);
      const lines: string[] = [];
      const regions: DockHitRegion[] = [];

      const headerTitle = ` ${theme.fgBold(opts.title)} `;
      const fillRight = Math.max(2, boxW - 3 - displayWidth(headerTitle));
      lines.push(
        `  ${theme.accent(glyphs.topLeft + glyphs.rule)}${headerTitle}${theme.accent(glyphs.rule.repeat(fillRight) + glyphs.topRight)}`,
      );

      if (opts.subtitle) {
        lines.push(`  ${theme.accent(glyphs.pipe)} ${padEndAnsi(truncateAnsi(theme.muted(opts.subtitle), innerW), innerW)} ${theme.accent(glyphs.pipe)}`);
      }

      if (opts.searchable) {
        const filterDisplay = query
          ? `${theme.info("/")} ${theme.fgBright(query)}`
          : theme.faint("Type to filter...");
        lines.push(`  ${theme.accent(glyphs.pipe)} ${padEndAnsi(truncateAnsi(filterDisplay, innerW), innerW)} ${theme.accent(glyphs.pipe)}`);
        lines.push(`  ${theme.border(`${glyphs.tee}${glyphs.rule.repeat(boxW - 2)}┤`)}`);
      }

      if (filtered.length === 0) {
        lines.push(`  ${theme.accent(glyphs.pipe)} ${padEndAnsi(theme.faint("No matching items."), innerW)} ${theme.accent(glyphs.pipe)}`);
      } else {
        let start = 0;
        if (filtered.length > maxVisible) {
          start = Math.max(0, Math.min(filtered.length - maxVisible, selected - Math.floor(maxVisible / 2)));
        }
        const slice = filtered.slice(start, start + maxVisible);
        const labelW = Math.min(34, Math.max(14, ...slice.map((it) => it.label.length + 1)));

        for (let i = 0; i < slice.length; i++) {
          const idx = start + i;
          const item = slice[i];
          const active = idx === selected;
          const badge = item.badge ? ` ${theme.badge(item.badge, item.badgeTone || "muted")}` : "";
          const badgeW = displayWidth(badge);
          const descAvail = Math.max(6, innerW - labelW - badgeW - 5);
          const desc = item.description ? truncateAnsi(item.description, descAvail) : "";
          const rowIdx = lines.length;

          if (active) {
            const plainRow = `${glyphs.pointer} ${padEndAnsi(truncateAnsi(item.label, labelW), labelW)}  ${desc}`;
            const fitted = padEndAnsi(truncateAnsi(plainRow, innerW - badgeW), innerW - badgeW);
            lines.push(`  ${theme.accent(glyphs.pipe)} ${theme.selectedRow(fitted)}${badge} ${theme.accent(glyphs.pipe)}`);
          } else {
            const lbl = item.disabled ? theme.faint(padEndAnsi(truncateAnsi(item.label, labelW), labelW)) : theme.fg(padEndAnsi(truncateAnsi(item.label, labelW), labelW));
            const row = `  ${lbl}  ${theme.muted(desc)}`;
            const fitted = padEndAnsi(truncateAnsi(row, innerW - badgeW), innerW - badgeW);
            lines.push(`  ${theme.accent(glyphs.pipe)} ${fitted}${badge} ${theme.accent(glyphs.pipe)}`);
          }

          regions.push({
            id: "option",
            row: rowIdx,
            startCol: 2,
            endCol: 2 + boxW,
            data: idx,
          });
        }
      }

      lines.push(`  ${theme.accent(glyphs.bottomLeft + glyphs.rule.repeat(boxW - 2) + glyphs.bottomRight)}`);

      const countHint = filtered.length > maxVisible ? `${selected + 1}/${filtered.length} ${glyphs.middot} ` : "";
      const delHint = opts.allowDelete ? ` ${glyphs.middot} d delete` : "";
      const extra = opts.extraHints ? ` ${glyphs.middot} ${opts.extraHints}` : "";
      const hintRow = lines.length;
      const hintText = `${countHint}Up/Down/Scroll ${glyphs.middot} Enter/Click select${delHint}${extra} ${glyphs.middot} Esc/Right-click cancel`;
      lines.push(`  ${theme.faint(truncateAnsi(hintText, cols - 4))}`);
      regions.push({ id: "cancel", row: hintRow, startCol: Math.max(2, cols - 28), endCol: cols });

      dock.setHitRegions(regions);
      dock.render(lines, null);
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      opts.signal?.removeEventListener("abort", onAbort);
      process.stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      parser.dispose();
      dock.clear();
      disableTerminalInputModes();
    };

    const finish = (val: T | null) => {
      cleanup();
      resolveSelect(val);
    };

    const onAbort = () => finish(null);
    const onResize = () => {
      if (!done) render();
    };

    const parser = new RawKeyParser((ev) => {
      if (done) return;
      const filtered = getFiltered();

      if (ev.name === "cpr" && ev.cpr) {
        dock.handleCpr(ev.cpr.row, ev.cpr.col);
        return;
      }

      if (ev.name === "mouse" && ev.mouse) {
        const m = ev.mouse;
        if (m.action === "wheel-up" && filtered.length > 0) {
          selected = (selected - 1 + filtered.length) % filtered.length;
          render();
          return;
        }
        if (m.action === "wheel-down" && filtered.length > 0) {
          selected = (selected + 1) % filtered.length;
          render();
          return;
        }
        if (m.action === "press" && m.button === "right") {
          finish(null);
          return;
        }
        if (m.action === "press" && m.button === "left") {
          const hit = dock.hitTest(m.col, m.row);
          if (hit?.id === "option" && typeof hit.data === "number") {
            const chosen = filtered[hit.data];
            if (chosen && !chosen.disabled) {
              finish(chosen.value);
            }
          } else if (hit?.id === "cancel") {
            finish(null);
          }
          return;
        }
        if (m.action === "press" && m.button === "middle" && opts.allowDelete && opts.onDelete) {
          const hit = dock.hitTest(m.col, m.row);
          if (hit?.id === "option" && typeof hit.data === "number") {
            const target = filtered[hit.data];
            if (target && opts.onDelete(target)) {
              items = items.filter((it) => it !== target);
              if (items.length === 0) {
                finish(null);
                return;
              }
              selected = Math.min(selected, items.length - 1);
              render();
            }
          }
          return;
        }
        return;
      }

      if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) {
        if (query && ev.name === "escape") {
          query = "";
          selected = 0;
          render();
          return;
        }
        finish(null);
        return;
      }

      if (ev.name === "up" || (!opts.searchable && ev.name === "text" && ev.text === "k")) {
        if (filtered.length > 0) {
          selected = (selected - 1 + filtered.length) % filtered.length;
          render();
        }
        return;
      }

      if (ev.name === "down" || (!opts.searchable && ev.name === "text" && ev.text === "j")) {
        if (filtered.length > 0) {
          selected = (selected + 1) % filtered.length;
          render();
        }
        return;
      }

      if (ev.name === "pageup" && filtered.length > 0) {
        selected = Math.max(0, selected - maxVisible);
        render();
        return;
      }

      if (ev.name === "pagedown" && filtered.length > 0) {
        selected = Math.min(filtered.length - 1, selected + maxVisible);
        render();
        return;
      }

      if (ev.name === "return") {
        const chosen = filtered[selected];
        if (chosen && !chosen.disabled) {
          finish(chosen.value);
        }
        return;
      }

      if (opts.allowDelete && opts.onDelete && !query && ev.name === "text" && ev.text === "d") {
        const target = filtered[selected];
        if (target && opts.onDelete(target)) {
          items = items.filter((it) => it !== target);
          if (items.length === 0) {
            finish(null);
            return;
          }
          selected = Math.min(selected, items.length - 1);
          render();
        }
        return;
      }

      if (opts.searchable) {
        if (ev.name === "backspace") {
          query = query.slice(0, -1);
          selected = 0;
          render();
          return;
        }
        if (ev.name === "text" && ev.text) {
          query += ev.text;
          selected = 0;
          render();
          return;
        }
      } else if (ev.name === "text" && ev.text && /^[1-9]$/.test(ev.text)) {
        const numIdx = Number(ev.text) - 1;
        if (numIdx >= 0 && numIdx < filtered.length && !filtered[numIdx].disabled) {
          finish(filtered[numIdx].value);
        }
      }
    });

    const onData = (chunk: Buffer | string) => parser.feed(chunk);

    if (opts.signal?.aborted) {
      finish(null);
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    enableTerminalInputModes();
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    render();
  });
}
