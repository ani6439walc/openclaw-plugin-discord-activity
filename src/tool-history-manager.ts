import type { ToolEntry, SubagentToolName } from "./types.js";
import type { PluginConfig } from "./config.js";

/**
 * ToolHistoryManager is responsible for all tool history operations.
 * It encapsulates the logic for managing ToolEntry arrays, including
 * filtering, updating, replacing entries, and handling subagent groups.
 */
export class ToolHistoryManager {
  constructor(private config: PluginConfig) {}

  /**
   * Adds a new tool entry to the history
   */
  addEntry(history: ToolEntry[], entry: ToolEntry): void {
    this.ensureDisplayId(entry);
    history.push(entry);
    this.trim(history);
  }

  /**
   * Adds multiple tool entries to the history
   */
  addEntries(history: ToolEntry[], entries: ToolEntry[]): void {
    entries.forEach((entry) => this.ensureDisplayId(entry));
    history.push(...entries);
    this.trim(history);
  }

  /**
   * Upserts entries: updates those existing in history, collects new ones.
   * Returns the array of new entries (not yet in history) with duplicates resolved.
   */
  upsertEntries(history: ToolEntry[], entries: ToolEntry[]): ToolEntry[] {
    const newEntries: ToolEntry[] = [];
    for (const entry of entries) {
      this.ensureDisplayId(entry);
      const existingInHistory = history.find(
        (t) => t.toolCallId === entry.toolCallId,
      );
      if (existingInHistory) {
        this.ensureDisplayId(existingInHistory);
        this.updateEntry(history, entry.toolCallId, {
          status: existingInHistory.status === "error" ? "error" : entry.status,
          params: entry.params,
          toolName: entry.toolName,
          error: existingInHistory.error ?? entry.error,
          durationMs: existingInHistory.durationMs ?? entry.durationMs,
        });
      } else {
        const existingInNew = newEntries.find(
          (t) => t.toolCallId === entry.toolCallId,
        );
        if (existingInNew) {
          const idx = newEntries.indexOf(existingInNew);
          newEntries[idx] = {
            ...newEntries[idx],
            status: existingInNew.status === "error" ? "error" : entry.status,
            params: entry.params,
            toolName: entry.toolName,
            error: existingInNew.error ?? entry.error,
            durationMs: existingInNew.durationMs ?? entry.durationMs,
          };
        } else {
          newEntries.push(entry);
        }
      }
    }
    return newEntries;
  }

  /**
   * Updates an existing tool entry by toolCallId
   */
  updateEntry(
    history: ToolEntry[],
    toolCallId: string,
    updates: Partial<ToolEntry>,
  ): boolean {
    const index = history.findIndex((t) => t.toolCallId === toolCallId);
    if (index !== -1) {
      const displayId = history[index].displayId ?? history[index].toolCallId;
      Object.assign(history[index], updates);
      history[index].displayId = displayId;
      return true;
    }
    return false;
  }

  /**
   * Trims the history to the maximum allowed length
   */
  trim(history: ToolEntry[]): void {
    while (history.length > this.config.maxToolHistoryLength) {
      history.shift();
    }
  }

  /**
   * Checks if an entry is a subagent tool entry (either base or child)
   */
  isSubagentEntry(entry: ToolEntry, prefix: SubagentToolName): boolean {
    return entry.toolName === prefix || entry.toolName.startsWith(`${prefix}:`);
  }

  /**
   * Checks if an entry is a subagent child entry (only child entries)
   */
  isSubagentChildEntry(entry: ToolEntry, prefix: SubagentToolName): boolean {
    return entry.toolName.startsWith(`${prefix}:`);
  }

  /**
   * Finds only the child entries of a subagent
   */
  findSubagentChildEntries(
    history: ToolEntry[],
    prefix: SubagentToolName,
  ): ToolEntry[] {
    return history.filter((entry) => this.isSubagentChildEntry(entry, prefix));
  }

  /**
   * Replaces a subagent group with new entries
   */
  replaceSubagentGroup(
    history: ToolEntry[],
    prefix: SubagentToolName,
    replacements: ToolEntry[],
  ): void {
    replacements.forEach((entry) => this.ensureDisplayId(entry));
    this.replaceGroupInPlace(
      history,
      (entry) => this.isSubagentEntry(entry, prefix),
      replacements,
    );
  }

  /**
   * Internal method to replace a group of entries matching a predicate
   */
  private replaceGroupInPlace(
    history: ToolEntry[],
    predicate: (t: ToolEntry) => boolean,
    replacements: ToolEntry[],
  ): void {
    const startIdx = history.findIndex(predicate);
    if (startIdx === -1) {
      history.push(...replacements);
      return;
    }
    const retained = history.filter((entry) => !predicate(entry));
    retained.splice(startIdx, 0, ...replacements);
    history.splice(0, history.length, ...retained);
  }

  private ensureDisplayId(entry: ToolEntry): void {
    entry.displayId ??= entry.toolCallId;
  }
}
