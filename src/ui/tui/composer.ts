import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessShellRisk } from "../../tools/risk.js";
import { displayWidth, padEndAnsi, termWidth, truncateAnsi } from "../ansi.js";
import { glyphs, theme } from "../theme.js";
import { InlineDock, type DockCursor, type DockHitRegion } from "./dock.js";
import { disableTerminalInputModes, enableTerminalInputModes, RawKeyParser, type KeyEvent } from "./keys.js";
import { renderStatusFooterWithRegions, type StatusBarState } from "./statusbar.js";
import {
  filterFileSuggestions,
  filterSlashSuggestions,
  renderTypeaheadPopup,
  type SlashSuggestionSource,
  type TypeaheadItem,
} from "./typeahead.js";

export type ComposerResult =
  | { type: "submit"; text: string }
  | { type: "command"; command: string }
  | { type: "rewind" }
  | { type: "exit" };

export interface ComposerCallbacks {
  getStatus: () => StatusBarState;
  getSlashCommands: () => readonly SlashSuggestionSource[];
  getWorkspaceFiles: (prefix: string) => string[];
  getModifiedFiles: () => ReadonlySet<string> | undefined;
  onCyclePermission: () => void;
  onCycleToolMode: () => void;
  onToggleVerbose: () => void;
  onRedrawScreen: () => void;
}

function needsMoreLines(text: string): boolean {
  if (text.endsWith("\\")) return true;
  const fences = text.match(/```/g);
  return Boolean(fences && fences.length % 2 === 1);
}

interface VisualRow {
  text: string;
  startIdx: number;
  endIdx: number;
  logicalLine: number;
}

function layoutBufferRows(text: string, innerWidth: number): VisualRow[] {
  const safeWidth = Math.max(12, innerWidth);
  const logicalLines = text.split("\n");
  const rows: VisualRow[] = [];
  let offset = 0;

  for (let li = 0; li < logicalLines.length; li++) {
    const line = logicalLines[li];
    if (line.length === 0) {
      rows.push({ text: "", startIdx: offset, endIdx: offset, logicalLine: li });
      offset += 1;
      continue;
    }
    let idx = 0;
    while (idx < line.length) {
      let end = idx;
      let w = 0;
      while (end < line.length) {
        const ch = line[end];
        const cw = displayWidth(ch);
        if (w + cw > safeWidth && end > idx) break;
        w += cw;
        end++;
      }
      rows.push({
        text: line.slice(idx, end),
        startIdx: offset + idx,
        endIdx: offset + end,
        logicalLine: li,
      });
      idx = end;
    }
    offset += line.length + 1;
  }

  return rows.length > 0 ? rows : [{ text: "", startIdx: 0, endIdx: 0, logicalLine: 0 }];
}

function locateCursor(rows: VisualRow[], cursorPos: number): { rowIdx: number; col: number } {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isLastOfLine = i === rows.length - 1 || rows[i + 1].logicalLine !== r.logicalLine;
    if (cursorPos >= r.startIdx && (cursorPos < r.endIdx || (isLastOfLine && cursorPos <= r.endIdx))) {
      const slice = r.text.slice(0, Math.max(0, cursorPos - r.startIdx));
      return { rowIdx: i, col: displayWidth(slice) };
    }
  }
  const last = rows[rows.length - 1];
  return { rowIdx: rows.length - 1, col: displayWidth(last.text) };
}

function charIndexAtVisualCol(text: string, targetCol: number): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const cw = displayWidth(text[i]);
    if (w + cw / 2 >= targetCol) return i;
    w += cw;
  }
  return text.length;
}

function moveWordLeft(text: string, pos: number): number {
  let i = Math.max(0, pos);
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

function moveWordRight(text: string, pos: number): number {
  let i = Math.min(text.length, pos);
  while (i < text.length && !/\s/.test(text[i])) i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function openExternalEditor(initialText: string): string | null {
  const editorEnv = (process.env.VISUAL || process.env.EDITOR || "").trim();
  const cmd = editorEnv || (process.platform === "win32" ? "notepad" : "nano");
  const tmpFile = join(tmpdir(), `wide-prompt-${Date.now()}.md`);
  try {
    writeFileSync(tmpFile, initialText, "utf8");
    const parts = cmd.split(/\s+/).filter(Boolean);
    const exe = parts[0];
    const args = [...parts.slice(1), tmpFile];
    const res =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)
        ? spawnSync("cmd.exe", ["/d", "/c", exe, ...args], { stdio: "inherit", shell: false })
        : spawnSync(exe, args, { stdio: "inherit", shell: false });
    if (res.error) return null;
    return readFileSync(tmpFile, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {}
  }
}

export class PromptComposer {
  private dock: InlineDock;
  private history: string[];
  private pasteSeq = 0;

  constructor(history: string[] = [], dock?: InlineDock) {
    this.dock = dock ?? new InlineDock(process.stdout);
    this.history = [...history];
  }

  public getDock(): InlineDock {
    return this.dock;
  }

  public pushHistory(entry: string): void {
    const clean = entry.trim();
    if (!clean) return;
    if (this.history[0] !== clean) {
      this.history = [clean, ...this.history.filter((h) => h !== clean)].slice(0, 500);
    }
  }

  public async readPrompt(callbacks: ComposerCallbacks): Promise<ComposerResult> {
    return new Promise((resolvePrompt) => {
      let buffer = "";
      let cursor = 0;
      let historyIdx = -1;
      let savedDraft = "";
      let popupItems: TypeaheadItem[] = [];
      let popupTitle = "";
      let popupSelected = 0;
      let popupDismissedFor = "";
      let activeTokenRange: { start: number; end: number; kind: "slash" | "file" } | null = null;
      let searchMode = false;
      let searchQuery = "";
      let searchMatchIdx = 0;
      let noticeText = "";
      let noticeTimer: NodeJS.Timeout | null = null;
      let lastCtrlC = 0;
      let lastEmptyEsc = 0;
      const pastedBlocks = new Map<string, string>();
      let finished = false;

      const setNotice = (msg: string, ttlMs = 2200) => {
        noticeText = msg;
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
          noticeText = "";
          if (!finished) render();
        }, ttlMs);
        noticeTimer.unref?.();
      };

      const expandPastes = (raw: string): string => {
        let out = raw;
        for (const [token, content] of pastedBlocks.entries()) {
          out = out.split(token).join(content);
        }
        return out;
      };

      const computePopup = () => {
        if (searchMode) {
          popupItems = [];
          activeTokenRange = null;
          return;
        }
        const before = buffer.slice(0, cursor);
        if (buffer.startsWith("/") && !buffer.includes("\n") && !before.includes(" ")) {
          const query = before;
          if (popupDismissedFor === query) {
            popupItems = [];
            activeTokenRange = null;
            return;
          }
          popupTitle = "Commands";
          popupItems = filterSlashSuggestions(query, callbacks.getSlashCommands(), 10);
          activeTokenRange = { start: 0, end: before.length, kind: "slash" };
          popupSelected = Math.min(popupSelected, Math.max(0, popupItems.length - 1));
          return;
        }

        const atMatch = /(^|\s)@([^\s]*)$/.exec(before);
        if (atMatch) {
          const partial = atMatch[2];
          const tokenStart = before.length - partial.length - 1;
          const dismissKey = `@${partial}`;
          if (popupDismissedFor === dismissKey) {
            popupItems = [];
            activeTokenRange = null;
            return;
          }
          const files = callbacks.getWorkspaceFiles(partial);
          popupTitle = "Workspace files";
          popupItems = filterFileSuggestions(partial, files, callbacks.getModifiedFiles(), 10);
          activeTokenRange = { start: tokenStart, end: cursor, kind: "file" };
          popupSelected = Math.min(popupSelected, Math.max(0, popupItems.length - 1));
          return;
        }

        popupItems = [];
        activeTokenRange = null;
        popupDismissedFor = "";
      };

      const findReverseMatches = (): string[] => {
        if (!searchQuery) return this.history.slice(0, 20);
        const q = searchQuery.toLowerCase();
        return this.history.filter((h) => h.toLowerCase().includes(q));
      };

      const render = () => {
        computePopup();
        const cols = Math.max(40, termWidth(80));
        const boxWidth = Math.max(36, Math.min(cols - 2, 116));
        const innerWidth = Math.max(18, boxWidth - 6);
        const status = callbacks.getStatus();
        const regions: DockHitRegion[] = [];

        const isShell = buffer.startsWith("!");
        const shellCmd = isShell ? buffer.slice(1).trim() : "";
        const shellRisk = isShell && shellCmd ? assessShellRisk(shellCmd) : null;
        const borderPaint = isShell
          ? shellRisk?.destructive
            ? (s: string) => theme.error(s)
            : (s: string) => theme.warn(s)
          : status.permissionProfile === "plan"
            ? (s: string) => theme.info(s)
            : status.permissionProfile === "auto"
              ? (s: string) => theme.high(s)
              : (s: string) => theme.accent(s);

        const lines: string[] = [];

        let headerTag = "";
        if (searchMode) {
          const matches = findReverseMatches();
          const matchPreview = matches[searchMatchIdx] || "(no match)";
          headerTag = ` ${theme.info("search")} ${theme.fgBright(searchQuery || glyphs.ellipsis)} ${theme.faint(`${glyphs.middot} ${truncateAnsi(matchPreview.replace(/\n/g, " "), Math.max(12, boxWidth - 36))}`)} `;
        } else if (isShell) {
          headerTag = shellRisk?.destructive
            ? ` ${theme.errorBold("$ shell")} ${theme.faint(glyphs.middot)} ${theme.error("destructive")} `
            : ` ${theme.warnBold("$ shell")} `;
        } else if (noticeText) {
          headerTag = ` ${theme.warn(noticeText)} `;
        }

        if (headerTag) {
          const tagW = displayWidth(headerTag);
          const rightFill = Math.max(1, boxWidth - 3 - tagW);
          lines.push(`  ${borderPaint(glyphs.topLeft + glyphs.rule)}${headerTag}${borderPaint(glyphs.rule.repeat(rightFill) + glyphs.topRight)}`);
        } else {
          lines.push(`  ${borderPaint(glyphs.topLeft + glyphs.rule.repeat(boxWidth - 2) + glyphs.topRight)}`);
        }

        const maxVisibleInputRows = 6;
        const visualRows = layoutBufferRows(buffer, innerWidth);
        const caret = locateCursor(visualRows, cursor);
        let rowOffset = 0;
        if (visualRows.length > maxVisibleInputRows) {
          rowOffset = Math.max(0, Math.min(visualRows.length - maxVisibleInputRows, caret.rowIdx - maxVisibleInputRows + 1));
        }
        const visibleRows = visualRows.slice(rowOffset, rowOffset + maxVisibleInputRows);
        const promptGlyph = isShell ? theme.warnBold("$") : theme.accentBold(glyphs.prompt);

        for (let i = 0; i < visibleRows.length; i++) {
          const r = visibleRows[i];
          const isFirst = rowOffset + i === 0;
          const prefix = isFirst ? `${promptGlyph} ` : `  `;
          let body = r.text;
          if (!buffer && isFirst) {
            body = theme.faint(
              status.permissionProfile === "plan"
                ? "Plan mode (read-only): describe what to analyze or design..."
                : "Ask Wide anything, type / for commands, @ for files, ! for shell...",
            );
          } else {
            body = theme.fgBright(r.text);
          }
          const fitted = padEndAnsi(truncateAnsi(body, innerWidth), innerWidth);
          const dockRowIdx = lines.length;
          lines.push(`  ${borderPaint(glyphs.pipe)} ${prefix}${fitted} ${borderPaint(glyphs.pipe)}`);
          regions.push({
            id: "input-row",
            row: dockRowIdx,
            startCol: 4,
            endCol: 6 + innerWidth + 1,
            data: r,
          });
        }

        lines.push(`  ${borderPaint(glyphs.bottomLeft + glyphs.rule.repeat(boxWidth - 2) + glyphs.bottomRight)}`);

        const footerState: StatusBarState = {
          ...status,
          shellMode: isShell,
          destructiveHint: shellRisk?.destructive ? shellRisk.reason : undefined,
        };
        const footerRowIdx = lines.length;
        const footer = renderStatusFooterWithRegions(footerState, cols - 1);
        lines.push(footer.line);
        for (const fr of footer.regions) {
          regions.push({
            id: `footer:${fr.id}`,
            row: footerRowIdx,
            startCol: fr.startCol,
            endCol: fr.endCol,
          });
        }

        if (popupItems.length > 0) {
          const maxVisible = 6;
          const total = popupItems.length;
          const clampedIdx = Math.max(0, Math.min(total - 1, popupSelected));
          const start =
            total > maxVisible
              ? Math.max(0, Math.min(total - maxVisible, clampedIdx - Math.floor(maxVisible / 2)))
              : 0;
          const popupLines = renderTypeaheadPopup(popupTitle, popupItems, popupSelected, cols - 2, maxVisible);
          const firstItemRow = lines.length + 1;
          lines.push(...popupLines);
          const visibleItemCount = Math.max(0, popupLines.length - 1);
          for (let i = 0; i < visibleItemCount; i++) {
            regions.push({
              id: "popup-item",
              row: firstItemRow + i,
              startCol: 2,
              endCol: cols - 2,
              data: start + i,
            });
          }
        }

        this.dock.setHitRegions(regions);
        const cursorDockRow = 1 + (caret.rowIdx - rowOffset);
        const cursorDockCol = 2 + 1 + 1 + 2 + caret.col;
        const dockCursor: DockCursor | null = searchMode ? null : { row: cursorDockRow, col: cursorDockCol };
        this.dock.render(lines, dockCursor);
      };

      const cleanup = () => {
        if (finished) return;
        finished = true;
        if (noticeTimer) clearTimeout(noticeTimer);
        process.stdin.off("data", onData);
        process.stdout.off("resize", onResize);
        parser.dispose();
        this.dock.clear();
        disableTerminalInputModes();
      };

      const finish = (result: ComposerResult) => {
        cleanup();
        resolvePrompt(result);
      };

      const applyPopupSelection = (submitIfSlash: boolean): boolean => {
        if (popupItems.length === 0 || !activeTokenRange) return false;
        const chosen = popupItems[popupSelected];
        if (!chosen) return false;
        const suffix = activeTokenRange.kind === "file" ? " " : submitIfSlash ? "" : " ";
        const inserted = `${chosen.insertText}${suffix}`;
        buffer = buffer.slice(0, activeTokenRange.start) + inserted + buffer.slice(activeTokenRange.end);
        cursor = activeTokenRange.start + inserted.length;
        popupItems = [];
        activeTokenRange = null;
        if (submitIfSlash && inserted.startsWith("/")) {
          const finalText = expandPastes(buffer).trim();
          this.pushHistory(finalText);
          finish({ type: "submit", text: finalText });
          return true;
        }
        render();
        return true;
      };

      const moveUp = () => {
        if (popupItems.length > 0) {
          popupSelected = (popupSelected - 1 + popupItems.length) % popupItems.length;
          render();
          return;
        }
        const lineStart = buffer.lastIndexOf("\n", cursor - 1);
        if (lineStart >= 0) {
          const colInLine = cursor - lineStart - 1;
          const prevLineStart = buffer.lastIndexOf("\n", lineStart - 1) + 1;
          const prevLineLen = lineStart - prevLineStart;
          cursor = prevLineStart + Math.min(colInLine, prevLineLen);
          render();
          return;
        }
        if (this.history.length > 0) {
          if (historyIdx === -1) savedDraft = buffer;
          if (historyIdx + 1 < this.history.length) {
            historyIdx += 1;
            buffer = this.history[historyIdx];
            cursor = buffer.length;
            render();
          }
        }
      };

      const moveDown = () => {
        if (popupItems.length > 0) {
          popupSelected = (popupSelected + 1) % popupItems.length;
          render();
          return;
        }
        const nextNl = buffer.indexOf("\n", cursor);
        if (nextNl >= 0) {
          const lineStart = buffer.lastIndexOf("\n", cursor - 1) + 1;
          const colInLine = cursor - lineStart;
          const afterNl = nextNl + 1;
          const endNext = buffer.indexOf("\n", afterNl);
          const nextLen = (endNext >= 0 ? endNext : buffer.length) - afterNl;
          cursor = afterNl + Math.min(colInLine, nextLen);
          render();
          return;
        }
        if (historyIdx >= 0) {
          historyIdx -= 1;
          buffer = historyIdx >= 0 ? this.history[historyIdx] : savedDraft;
          cursor = buffer.length;
          render();
        }
      };

      const onResize = () => {
        if (!finished) {
          this.dock.render([], null);
          render();
        }
      };

      const parser = new RawKeyParser((ev: KeyEvent) => {
        if (finished) return;

        if (ev.name === "cpr" && ev.cpr) {
          this.dock.handleCpr(ev.cpr.row, ev.cpr.col);
          return;
        }

        if (ev.name === "mouse" && ev.mouse) {
          const m = ev.mouse;
          if (m.action === "wheel-up") {
            moveUp();
            return;
          }
          if (m.action === "wheel-down") {
            moveDown();
            return;
          }
          if (m.action === "press" && m.button === "left") {
            const hit = this.dock.hitTest(m.col, m.row);
            if (!hit) return;
            if (hit.id === "input-row" && hit.data) {
              const vr = hit.data as VisualRow;
              const relCol = Math.max(0, m.col - 1 - 6);
              cursor = vr.startIdx + charIndexAtVisualCol(vr.text, relCol);
              render();
              return;
            }
            if (hit.id === "popup-item" && typeof hit.data === "number") {
              popupSelected = hit.data;
              applyPopupSelection(activeTokenRange?.kind === "slash");
              return;
            }
            if (hit.id === "footer:perm") {
              callbacks.onCyclePermission();
              render();
              return;
            }
            if (hit.id === "footer:mode") {
              callbacks.onCycleToolMode();
              render();
              return;
            }
            if (hit.id === "footer:verbose") {
              callbacks.onToggleVerbose();
              render();
              return;
            }
            if (hit.id === "footer:model") {
              const st = callbacks.getStatus();
              finish({ type: "command", command: st.providerReady ? "/model" : "/setup" });
              return;
            }
            if (hit.id === "footer:ctx") {
              finish({ type: "command", command: "/context" });
              return;
            }
            if (hit.id === "footer:slash-hint") {
              buffer = "/";
              cursor = 1;
              popupDismissedFor = "";
              render();
              return;
            }
            if (hit.id === "footer:file-hint") {
              const prefix = buffer && !/\s$/.test(buffer.slice(0, cursor)) ? " @" : "@";
              buffer = buffer.slice(0, cursor) + prefix + buffer.slice(cursor);
              cursor += prefix.length;
              popupDismissedFor = "";
              render();
              return;
            }
          }
          return;
        }

        if (searchMode) {
          const matches = findReverseMatches();
          if (ev.name === "escape" || (ev.ctrl && ev.name === "g")) {
            searchMode = false;
            searchQuery = "";
            render();
            return;
          }
          if (ev.ctrl && ev.name === "r") {
            if (matches.length > 0) {
              searchMatchIdx = (searchMatchIdx + 1) % matches.length;
            }
            render();
            return;
          }
          if (ev.name === "return" || ev.name === "tab" || ev.name === "right") {
            const picked = matches[searchMatchIdx];
            searchMode = false;
            searchQuery = "";
            if (picked) {
              buffer = picked;
              cursor = buffer.length;
            }
            if (ev.name === "return" && buffer.trim()) {
              const finalText = expandPastes(buffer).trim();
              this.pushHistory(finalText);
              finish({ type: "submit", text: finalText });
              return;
            }
            render();
            return;
          }
          if (ev.name === "backspace") {
            searchQuery = searchQuery.slice(0, -1);
            searchMatchIdx = 0;
            render();
            return;
          }
          if (ev.name === "text" && ev.text) {
            searchQuery += ev.text;
            searchMatchIdx = 0;
            render();
            return;
          }
          return;
        }

        if (ev.name === "paste" && ev.text !== undefined) {
          const raw = ev.text;
          const lineCount = raw.split("\n").length;
          if (lineCount >= 4 || raw.length >= 300) {
            this.pasteSeq += 1;
            const token = `[Pasted #${this.pasteSeq}: ${lineCount} line${lineCount === 1 ? "" : "s"}]`;
            pastedBlocks.set(token, raw);
            buffer = buffer.slice(0, cursor) + token + buffer.slice(cursor);
            cursor += token.length;
          } else {
            buffer = buffer.slice(0, cursor) + raw + buffer.slice(cursor);
            cursor += raw.length;
          }
          render();
          return;
        }

        if (ev.ctrl && ev.name === "c") {
          if (buffer.length > 0) {
            buffer = "";
            cursor = 0;
            historyIdx = -1;
            pastedBlocks.clear();
            lastCtrlC = Date.now();
            setNotice("Cleared input · Ctrl+C again to exit");
            render();
            return;
          }
          const now = Date.now();
          if (now - lastCtrlC < 2000) {
            finish({ type: "exit" });
            return;
          }
          lastCtrlC = now;
          setNotice("Press Ctrl+C again within 2s to exit");
          render();
          return;
        }

        if (ev.ctrl && ev.name === "d") {
          if (!buffer) {
            finish({ type: "exit" });
            return;
          }
          if (cursor < buffer.length) {
            buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
            render();
          }
          return;
        }

        if (ev.name === "tab" && ev.shift) {
          callbacks.onCyclePermission();
          render();
          return;
        }

        if (ev.ctrl && ev.name === "t") {
          callbacks.onCycleToolMode();
          render();
          return;
        }

        if (ev.ctrl && ev.name === "o") {
          callbacks.onToggleVerbose();
          setNotice("Toggled verbose tool output");
          render();
          return;
        }

        if (ev.ctrl && ev.name === "l") {
          this.dock.clear();
          callbacks.onRedrawScreen();
          render();
          return;
        }

        if (ev.ctrl && ev.name === "r") {
          searchMode = true;
          searchQuery = "";
          searchMatchIdx = 0;
          render();
          return;
        }

        if (ev.ctrl && ev.name === "g") {
          this.dock.clear();
          disableTerminalInputModes();
          const edited = openExternalEditor(expandPastes(buffer));
          enableTerminalInputModes();
          if (edited !== null) {
            pastedBlocks.clear();
            buffer = edited.replace(/\n+$/, "");
            cursor = buffer.length;
            setNotice("Loaded draft from external editor");
          }
          render();
          return;
        }

        if (ev.name === "escape") {
          if (popupItems.length > 0 && activeTokenRange) {
            popupDismissedFor = buffer.slice(activeTokenRange.start, activeTokenRange.end);
            popupItems = [];
            render();
            return;
          }
          if (buffer.length > 0) {
            buffer = "";
            cursor = 0;
            pastedBlocks.clear();
            render();
            return;
          }
          const now = Date.now();
          if (now - lastEmptyEsc < 650) {
            finish({ type: "rewind" });
            return;
          }
          lastEmptyEsc = now;
          setNotice("Press Esc again to rewind a turn", 1200);
          render();
          return;
        }

        if (ev.name === "tab" && !ev.shift) {
          if (popupItems.length > 0) {
            applyPopupSelection(false);
          }
          return;
        }

        if (ev.name === "return" && (ev.shift || ev.meta)) {
          buffer = buffer.slice(0, cursor) + "\n" + buffer.slice(cursor);
          cursor += 1;
          render();
          return;
        }

        if (ev.ctrl && ev.name === "j") {
          buffer = buffer.slice(0, cursor) + "\n" + buffer.slice(cursor);
          cursor += 1;
          render();
          return;
        }

        if (ev.name === "return") {
          if (popupItems.length > 0 && activeTokenRange) {
            const chosen = popupItems[popupSelected];
            if (activeTokenRange.kind === "file") {
              applyPopupSelection(false);
              return;
            }
            if (chosen && buffer.trim() !== chosen.insertText) {
              applyPopupSelection(true);
              return;
            }
          }
          if (needsMoreLines(buffer)) {
            if (buffer.endsWith("\\")) {
              buffer = buffer.slice(0, -1) + "\n";
              cursor = buffer.length;
            } else {
              buffer = buffer.slice(0, cursor) + "\n" + buffer.slice(cursor);
              cursor += 1;
            }
            render();
            return;
          }
          const finalText = expandPastes(buffer).trim();
          if (!finalText) {
            render();
            return;
          }
          this.pushHistory(finalText);
          finish({ type: "submit", text: finalText });
          return;
        }

        if (ev.name === "up") {
          moveUp();
          return;
        }

        if (ev.name === "down") {
          moveDown();
          return;
        }

        if (ev.name === "left") {
          cursor = ev.ctrl || ev.meta ? moveWordLeft(buffer, cursor) : Math.max(0, cursor - 1);
          render();
          return;
        }

        if (ev.name === "right") {
          cursor = ev.ctrl || ev.meta ? moveWordRight(buffer, cursor) : Math.min(buffer.length, cursor + 1);
          render();
          return;
        }

        if (ev.name === "home" || (ev.ctrl && ev.name === "a")) {
          const lineStart = buffer.lastIndexOf("\n", cursor - 1) + 1;
          cursor = lineStart;
          render();
          return;
        }

        if (ev.name === "end" || (ev.ctrl && ev.name === "e")) {
          const nextNl = buffer.indexOf("\n", cursor);
          cursor = nextNl >= 0 ? nextNl : buffer.length;
          render();
          return;
        }

        if (ev.name === "backspace") {
          if (cursor > 0) {
            if (ev.meta || ev.ctrl) {
              const target = moveWordLeft(buffer, cursor);
              buffer = buffer.slice(0, target) + buffer.slice(cursor);
              cursor = target;
            } else {
              buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
              cursor -= 1;
            }
            popupDismissedFor = "";
            render();
          }
          return;
        }

        if (ev.name === "delete") {
          if (cursor < buffer.length) {
            buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
            popupDismissedFor = "";
            render();
          }
          return;
        }

        if (ev.ctrl && ev.name === "w") {
          const target = moveWordLeft(buffer, cursor);
          buffer = buffer.slice(0, target) + buffer.slice(cursor);
          cursor = target;
          render();
          return;
        }

        if (ev.ctrl && ev.name === "u") {
          const lineStart = buffer.lastIndexOf("\n", cursor - 1) + 1;
          buffer = buffer.slice(0, lineStart) + buffer.slice(cursor);
          cursor = lineStart;
          render();
          return;
        }

        if (ev.ctrl && ev.name === "k") {
          const nextNl = buffer.indexOf("\n", cursor);
          const end = nextNl >= 0 ? nextNl : buffer.length;
          buffer = buffer.slice(0, cursor) + buffer.slice(end);
          render();
          return;
        }

        if (ev.name === "text" && ev.text) {
          buffer = buffer.slice(0, cursor) + ev.text + buffer.slice(cursor);
          cursor += ev.text.length;
          popupDismissedFor = "";
          render();
        }
      });

      const onData = (chunk: Buffer | string) => {
        parser.feed(chunk);
      };

      enableTerminalInputModes();
      process.stdin.resume();
      process.stdin.on("data", onData);
      process.stdout.on("resize", onResize);
      render();
    });
  }
}

export async function askInlineText(
  label: string,
  options: {
    placeholder?: string;
    masked?: boolean;
    initialValue?: string;
    signal?: AbortSignal;
  } = {},
): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }

  return new Promise((resolveInput) => {
    const dock = new InlineDock(process.stdout);
    let value = options.initialValue || "";
    let cursor = value.length;
    let done = false;

    const render = () => {
      const cols = Math.max(36, termWidth(80));
      const boxW = Math.min(cols - 2, 86);
      const innerW = Math.max(12, boxW - 6);
      const shown = options.masked ? glyphs.dot.repeat(value.length) : value;
      const body = shown ? theme.fgBright(shown) : theme.faint(options.placeholder || "Type value and press Enter (Esc to cancel)");
      const lines = [
        `  ${theme.accent(glyphs.topLeft + glyphs.rule)} ${theme.fgBold(label)} ${theme.accent(glyphs.rule.repeat(Math.max(2, boxW - 5 - displayWidth(label))) + glyphs.topRight)}`,
        `  ${theme.accent(glyphs.pipe)} ${theme.accentBold(glyphs.prompt)} ${padEndAnsi(truncateAnsi(body, innerW), innerW)} ${theme.accent(glyphs.pipe)}`,
        `  ${theme.accent(glyphs.bottomLeft + glyphs.rule.repeat(boxW - 2) + glyphs.bottomRight)}`,
        `  ${theme.faint(`Enter confirm ${glyphs.middot} Esc cancel`)}`,
      ];
      dock.setHitRegions([
        { id: "text-input", row: 1, startCol: 6, endCol: 6 + innerW },
      ]);
      const caretCol = 6 + Math.min(innerW, displayWidth(shown.slice(0, cursor)));
      dock.render(lines, { row: 1, col: caretCol });
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      options.signal?.removeEventListener("abort", onAbort);
      process.stdin.off("data", onData);
      parser.dispose();
      dock.clear();
      disableTerminalInputModes();
    };

    const finish = (val: string | null) => {
      cleanup();
      resolveInput(val);
    };

    const onAbort = () => finish(null);

    const parser = new RawKeyParser((ev) => {
      if (done) return;
      if (ev.name === "cpr" && ev.cpr) {
        dock.handleCpr(ev.cpr.row, ev.cpr.col);
        return;
      }
      if (ev.name === "mouse" && ev.mouse) {
        if (ev.mouse.action === "press" && ev.mouse.button === "right") {
          finish(null);
          return;
        }
        if (ev.mouse.action === "press" && ev.mouse.button === "left") {
          const hit = dock.hitTest(ev.mouse.col, ev.mouse.row);
          if (hit?.id === "text-input") {
            const relCol = Math.max(0, ev.mouse.col - 1 - 6);
            const shown = options.masked ? glyphs.dot.repeat(value.length) : value;
            cursor = charIndexAtVisualCol(shown, relCol);
            render();
          }
        }
        return;
      }
      if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) {
        finish(null);
        return;
      }
      if (ev.name === "return") {
        finish(value);
        return;
      }
      if (ev.name === "paste" && ev.text !== undefined) {
        const clean = ev.text.replace(/[\r\n]+/g, "");
        value = value.slice(0, cursor) + clean + value.slice(cursor);
        cursor += clean.length;
        render();
        return;
      }
      if (ev.name === "backspace") {
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor -= 1;
          render();
        }
        return;
      }
      if (ev.name === "left") {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (ev.name === "right") {
        cursor = Math.min(value.length, cursor + 1);
        render();
        return;
      }
      if (ev.name === "home" || (ev.ctrl && ev.name === "a")) {
        cursor = 0;
        render();
        return;
      }
      if (ev.name === "end" || (ev.ctrl && ev.name === "e")) {
        cursor = value.length;
        render();
        return;
      }
      if (ev.ctrl && ev.name === "u") {
        value = "";
        cursor = 0;
        render();
        return;
      }
      if (ev.name === "text" && ev.text) {
        value = value.slice(0, cursor) + ev.text + value.slice(cursor);
        cursor += ev.text.length;
        render();
      }
    });

    const onData = (chunk: Buffer | string) => parser.feed(chunk);

    if (options.signal?.aborted) {
      finish(null);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    enableTerminalInputModes();
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

export function attachTurnInterruptWatcher(
  controller: AbortController,
  callbacks: { onInterrupt?: () => void; onToggleVerbose?: () => void } = {},
): () => void {
  if (!process.stdin.isTTY) {
    return () => {};
  }
  let detached = false;
  const parser = new RawKeyParser((ev) => {
    if (detached) return;
    if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) {
      if (!controller.signal.aborted) {
        controller.abort();
        callbacks.onInterrupt?.();
      }
      return;
    }
    if (ev.ctrl && ev.name === "o") {
      callbacks.onToggleVerbose?.();
    }
  });

  const onData = (chunk: Buffer | string) => parser.feed(chunk);
  enableTerminalInputModes({ mouse: false });
  process.stdin.resume();
  process.stdin.on("data", onData);

  return () => {
    if (detached) return;
    detached = true;
    process.stdin.off("data", onData);
    parser.dispose();
    disableTerminalInputModes();
  };
}
