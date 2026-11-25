import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FileChangeSnapshot } from "../tools/types.js";

export interface TurnCheckpoint {
  id: number;
  timestamp: string;
  promptPreview: string;
  messageCountBefore: number;
  changes: FileChangeSnapshot[];
}

export class TurnCheckpointStore {
  private turns: TurnCheckpoint[] = [];
  private activeTurn: TurnCheckpoint | null = null;
  private nextId = 1;

  public beginTurn(prompt: string, messageCountBefore: number): TurnCheckpoint {
    const single = prompt.replace(/\s+/g, " ").trim();
    const preview = single.length > 64 ? `${single.slice(0, 61)}...` : single;
    const cp: TurnCheckpoint = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      promptPreview: preview || "(empty prompt)",
      messageCountBefore,
      changes: [],
    };
    this.activeTurn = cp;
    return cp;
  }

  public recordFileChange(snapshot: FileChangeSnapshot): void {
    if (!this.activeTurn) return;
    this.activeTurn.changes.push(snapshot);
  }

  public commitTurn(): void {
    if (!this.activeTurn) return;
    this.turns.push(this.activeTurn);
    if (this.turns.length > 50) {
      this.turns.splice(0, this.turns.length - 50);
    }
    this.activeTurn = null;
  }

  public discardActiveTurn(): void {
    this.activeTurn = null;
  }

  public getCheckpoints(): TurnCheckpoint[] {
    return [...this.turns];
  }

  public clear(): void {
    this.turns = [];
    this.activeTurn = null;
  }

  public getAggregatedChanges(): FileChangeSnapshot[] {
    const byPath = new Map<string, FileChangeSnapshot>();
    for (const turn of this.turns) {
      for (const ch of turn.changes) {
        const existing = byPath.get(ch.filePath);
        if (!existing) {
          byPath.set(ch.filePath, { ...ch });
        } else {
          existing.afterContent = ch.afterContent;
          existing.added += ch.added;
          existing.removed += ch.removed;
          existing.tool = ch.tool;
        }
      }
    }
    return [...byPath.values()];
  }

  public revertFile(filePath: string): { restored: boolean; relPath: string } {
    const all = this.getAggregatedChanges();
    const target = all.find((c) => c.filePath === filePath || c.relPath === filePath);
    if (!target) return { restored: false, relPath: filePath };
    if (target.existedBefore) {
      const parent = dirname(target.filePath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(target.filePath, target.beforeContent, "utf8");
    } else if (existsSync(target.filePath)) {
      unlinkSync(target.filePath);
    }
    for (const turn of this.turns) {
      turn.changes = turn.changes.filter((c) => c.filePath !== target.filePath);
    }
    return { restored: true, relPath: target.relPath };
  }

  public rewindToTurn(
    turnId: number,
    restoreFiles: boolean,
  ): { ok: boolean; messageCountTarget: number; restoredFiles: string[] } {
    const idx = this.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return { ok: false, messageCountTarget: 1, restoredFiles: [] };

    const target = this.turns[idx];
    const turnsToUndo = this.turns.slice(idx);
    const restoredSet = new Set<string>();

    if (restoreFiles) {
      for (let t = turnsToUndo.length - 1; t >= 0; t--) {
        const changes = turnsToUndo[t].changes;
        for (let c = changes.length - 1; c >= 0; c--) {
          const snap = changes[c];
          try {
            if (snap.existedBefore) {
              const parent = dirname(snap.filePath);
              if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
              writeFileSync(snap.filePath, snap.beforeContent, "utf8");
            } else if (existsSync(snap.filePath)) {
              unlinkSync(snap.filePath);
            }
            restoredSet.add(snap.relPath);
          } catch {}
        }
      }
    }

    this.turns = this.turns.slice(0, idx);
    return {
      ok: true,
      messageCountTarget: target.messageCountBefore,
      restoredFiles: [...restoredSet],
    };
  }
}
