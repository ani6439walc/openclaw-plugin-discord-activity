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
