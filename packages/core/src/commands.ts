import type { Command, CommandStack, Id, ProjectDocument } from "@jeek/contracts";
import { nextId } from "./document.js";

export interface CommandStackOptions {
  /** 栈深上限 */
  limit?: number;
  /** 连续同类操作的合并窗口（毫秒） */
  mergeWindowMs?: number;
}

export function makeCommand(
  label: string,
  before: ProjectDocument,
  after: ProjectDocument,
  id?: Id,
  ui?: Command["ui"],
): Command {
  return {
    id: id ?? nextId("cmd"),
    label,
    timestamp: Date.now(),
    before,
    after,
    ui,
  };
}

/** 整包快照 + 短时合并 + 栈深限制。任何新模块接入撤销都不需要额外适配 */
export function createCommandStack(options: CommandStackOptions = {}): CommandStack {
  const limit = options.limit ?? 60;
  const mergeWindowMs = options.mergeWindowMs ?? 350;
  const undoStack: Command[] = [];
  const redoStack: Command[] = [];

  return {
    push(command: Command): void {
      const prev = undoStack[undoStack.length - 1];
      if (
        prev &&
        prev.label === command.label &&
        command.timestamp - prev.timestamp <= mergeWindowMs
      ) {
        undoStack[undoStack.length - 1] = {
          ...prev,
          after: command.after,
          ui: command.ui
            ? { before: prev.ui?.before ?? command.ui.before, after: command.ui.after }
            : prev.ui,
          timestamp: command.timestamp,
        };
      } else {
        undoStack.push(command);
        if (undoStack.length > limit) undoStack.shift();
      }
      redoStack.length = 0;
    },
    undo(): Command | null {
      const cmd = undoStack.pop();
      if (!cmd) return null;
      redoStack.push(cmd);
      return cmd;
    },
    redo(): Command | null {
      const cmd = redoStack.pop();
      if (!cmd) return null;
      undoStack.push(cmd);
      return cmd;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    clear(): void {
      undoStack.length = 0;
      redoStack.length = 0;
    },
    get size(): number {
      return undoStack.length;
    },
  };
}
