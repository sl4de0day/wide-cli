import { displayWidth, padEndAnsi, termWidth, truncateAnsi } from "../ansi.js";
import { glyphs, theme } from "../theme.js";
import { InlineDock, type DockHitRegion } from "./dock.js";
import { disableTerminalInputModes, enableTerminalInputModes, RawKeyParser } from "./keys.js";

export interface TabPaneItem {
  id: string;
  label: string;
  detail?: string;
  badge?: string;
}

export interface TabPane {
  id: string;
  title: string;
  items: TabPaneItem[];
  emptyText?: string;
}

export interface TabbedPanelAction {
  key: string;
  label: string;
  onTrigger: (tab: TabPane, item: TabPaneItem | undefined) => Promise<boolean> | boolean;
}

export interface TabbedPanelOptions {
  title: string;
  getTabs: () => TabPane[];
  actions?: TabbedPanelAction[];
  signal?: AbortSignal;
}

export async function runTabbedPanel(opts: TabbedPanelOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  return new Promise((resolvePanel) => {
    const dock = new InlineDock(process.stdout);
    let tabIdx = 0;
    let itemIdx = 0;
    let done = false;
    let busy = false;
    const maxVisible = 10;

    const triggerAction = (action: TabbedPanelAction, activeTab: TabPane) => {
      busy = true;
      dock.clear();
      disableTerminalInputModes();
      process.stdin.off("data", onData);
      Promise.resolve(action.onTrigger(activeTab, activeTab.items[itemIdx]))
        .then((shouldClose) => {
          busy = false;
          if (done) return;
          if (shouldClose) {
            finish();
            return;
          }
          enableTerminalInputModes();
          process.stdin.resume();
          process.stdin.on("data", onData);
          render();
        })
        .catch(() => {
          busy = false;
          if (!done) {
            enableTerminalInputModes();
            process.stdin.resume();
            process.stdin.on("data", onData);
            render();
          }
        });
    };

    const render = () => {
      const tabs = opts.getTabs();
      if (tabs.length === 0) return;
      tabIdx = Math.max(0, Math.min(tabs.length - 1, tabIdx));
      const activeTab = tabs[tabIdx];
      itemIdx = Math.max(0, Math.min(Math.max(0, activeTab.items.length - 1), itemIdx));

      const cols = Math.max(44, termWidth(80));
      const boxW = Math.min(cols - 2, 102);
      const innerW = Math.max(24, boxW - 4);
      const lines: string[] = [];
      const regions: DockHitRegion[] = [];

      const headerTitle = ` ${theme.fgBold(opts.title)} `;
      const fillRight = Math.max(2, boxW - 3 - displayWidth(headerTitle));
      lines.push(
        `  ${theme.accent(glyphs.topLeft + glyphs.rule)}${headerTitle}${theme.accent(glyphs.rule.repeat(fillRight) + glyphs.topRight)}`,
      );

      const tabRowIdx = lines.length;
      let tabCol = 4;
      const tabParts: string[] = [];
      for (let i = 0; i < tabs.length; i++) {
        const count = `${tabs[i].title} (${tabs[i].items.length})`;
        const rendered = i === tabIdx ? theme.badge(count, "accent") : theme.muted(` ${count} `);
        const w = displayWidth(rendered);
        regions.push({ id: "tab", row: tabRowIdx, startCol: tabCol, endCol: tabCol + w, data: i });
        tabParts.push(rendered);
        tabCol += w + 1;
      }
      const tabBar = tabParts.join(" ");
      lines.push(`  ${theme.accent(glyphs.pipe)} ${padEndAnsi(truncateAnsi(tabBar, innerW), innerW)} ${theme.accent(glyphs.pipe)}`);
      lines.push(`  ${theme.border(`${glyphs.tee}${glyphs.rule.repeat(boxW - 2)}┤`)}`);

      if (activeTab.items.length === 0) {
        lines.push(`  ${theme.accent(glyphs.pipe)} ${padEndAnsi(theme.faint(activeTab.emptyText || "No entries."), innerW)} ${theme.accent(glyphs.pipe)}`);
      } else {
        let start = 0;
        if (activeTab.items.length > maxVisible) {
          start = Math.max(0, Math.min(activeTab.items.length - maxVisible, itemIdx - Math.floor(maxVisible / 2)));
        }
        const slice = activeTab.items.slice(start, start + maxVisible);
        for (let i = 0; i < slice.length; i++) {
          const idx = start + i;
          const item = slice[i];
          const active = idx === itemIdx;
          const badge = item.badge ? ` ${theme.faint(`[${item.badge}]`)}` : "";
          const detail = item.detail ? `  ${theme.muted(item.detail)}` : "";
          const rowIdx = lines.length;
          if (active) {
            const raw = `${glyphs.pointer} ${item.label}${item.detail ? `  ${item.detail}` : ""}`;
            lines.push(`  ${theme.accent(glyphs.pipe)} ${theme.selectedRow(padEndAnsi(truncateAnsi(raw, innerW), innerW))} ${theme.accent(glyphs.pipe)}`);
          } else {
            const raw = `  ${theme.fg(item.label)}${detail}${badge}`;
            lines.push(`  ${theme.accent(glyphs.pipe)} ${padEndAnsi(truncateAnsi(raw, innerW), innerW)} ${theme.accent(glyphs.pipe)}`);
          }
          regions.push({ id: "item", row: rowIdx, startCol: 2, endCol: 2 + boxW, data: idx });
        }
      }

      lines.push(`  ${theme.accent(glyphs.bottomLeft + glyphs.rule.repeat(boxW - 2) + glyphs.bottomRight)}`);

      const footerRowIdx = lines.length;
      const sepText = ` ${glyphs.middot} `;
      const hintParts: Array<{ id?: string; text: string; data?: unknown }> = [
        { text: "Tab/Click tab" },
        { text: "Up/Down/Scroll" },
      ];
      for (const a of opts.actions || []) {
        hintParts.push({ id: "action", text: `[${a.key}] ${a.label}`, data: a });
      }
      hintParts.push({ id: "close", text: "Esc close" });

      let hCol = 2;
      for (let i = 0; i < hintParts.length; i++) {
        const part = hintParts[i];
        const w = displayWidth(part.text);
        if (part.id) {
          regions.push({ id: part.id, row: footerRowIdx, startCol: hCol, endCol: hCol + w, data: part.data });
        }
        hCol += w + displayWidth(sepText);
      }
      const hintsLine = hintParts.map((p) => p.text).join(sepText);
      lines.push(`  ${theme.faint(truncateAnsi(hintsLine, cols - 4))}`);

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

    const finish = () => {
      cleanup();
      resolvePanel();
    };

    const onAbort = () => finish();
    const onResize = () => {
      if (!done && !busy) render();
    };

    const parser = new RawKeyParser((ev) => {
      if (done || busy) return;
      const tabs = opts.getTabs();
      const activeTab = tabs[tabIdx];

      if (ev.name === "cpr" && ev.cpr) {
        dock.handleCpr(ev.cpr.row, ev.cpr.col);
        return;
      }

      if (ev.name === "mouse" && ev.mouse) {
        const m = ev.mouse;
        if (m.action === "wheel-up" && activeTab && activeTab.items.length > 0) {
          itemIdx = (itemIdx - 1 + activeTab.items.length) % activeTab.items.length;
          render();
          return;
        }
        if (m.action === "wheel-down" && activeTab && activeTab.items.length > 0) {
          itemIdx = (itemIdx + 1) % activeTab.items.length;
          render();
          return;
        }
        if (m.action === "press" && m.button === "right") {
          finish();
          return;
        }
        if (m.action === "press" && m.button === "left") {
          const hit = dock.hitTest(m.col, m.row);
          if (!hit) return;
          if (hit.id === "tab" && typeof hit.data === "number") {
            tabIdx = hit.data;
            itemIdx = 0;
            render();
            return;
          }
          if (hit.id === "item" && typeof hit.data === "number") {
            itemIdx = hit.data;
            render();
            return;
          }
          if (hit.id === "close") {
            finish();
            return;
          }
          if (hit.id === "action" && hit.data && activeTab) {
            triggerAction(hit.data as TabbedPanelAction, activeTab);
            return;
          }
        }
        return;
      }

      if (ev.name === "escape" || (ev.ctrl && ev.name === "c") || (ev.name === "text" && ev.text === "q")) {
        finish();
        return;
      }

      if (ev.name === "right" || (ev.name === "tab" && !ev.shift)) {
        tabIdx = (tabIdx + 1) % tabs.length;
        itemIdx = 0;
        render();
        return;
      }

      if (ev.name === "left" || (ev.name === "tab" && ev.shift)) {
        tabIdx = (tabIdx - 1 + tabs.length) % tabs.length;
        itemIdx = 0;
        render();
        return;
      }

      if (ev.name === "up" || (ev.name === "text" && ev.text === "k")) {
        if (activeTab && activeTab.items.length > 0) {
          itemIdx = (itemIdx - 1 + activeTab.items.length) % activeTab.items.length;
          render();
        }
        return;
      }

      if (ev.name === "down" || (ev.name === "text" && ev.text === "j")) {
        if (activeTab && activeTab.items.length > 0) {
          itemIdx = (itemIdx + 1) % activeTab.items.length;
          render();
        }
        return;
      }

      if (opts.actions && activeTab) {
        const keyStr = ev.name === "text" && ev.text ? ev.text.toLowerCase() : ev.name;
        const action = opts.actions.find((a) => a.key.toLowerCase() === keyStr);
        if (action) {
          triggerAction(action, activeTab);
        }
      }
    });

    const onData = (chunk: Buffer | string) => parser.feed(chunk);

    if (opts.signal?.aborted) {
      finish();
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
