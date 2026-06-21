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
    history.push(entry);
    this.trim(history);
  }

  /**
   * Updates an existing tool entry by toolCallId
   */
  updateEntry(history: ToolEntry[], toolCallId: string, updates: Partial<ToolEntry>): boolean {
    const index = history.findIndex(t => t.toolCallId === toolCallId);
    if (index !== -1) {
      history[index] = { ...history[index], ...updates };
      return true;
    }
    return false;
  }

  /**
   * Finds a tool entry by toolCallId
   */
  findByToolCallId(history: ToolEntry[], toolCallId: string): ToolEntry | undefined {
    return history.find(t => t.toolCallId === toolCallId);
  }

  /**
   * Finds all entries matching a given predicate
   */
  find(history: ToolEntry[], predicate: (entry: ToolEntry) => boolean): ToolEntry[] {
    return history.filter(predicate);
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
    return (
      entry.toolName === prefix || entry.toolName.startsWith(`${prefix}:`)
    );
  }

  /**
   * Checks if an entry is a subagent child entry (only child entries)
   */
  isSubagentChildEntry(entry: ToolEntry, prefix: SubagentToolName): boolean {
    return entry.toolName.startsWith(`${prefix}:`);
  }

  /**
   * Finds all subagent entries for a given prefix
   */
  findSubagentEntries(history: ToolEntry[], prefix: SubagentToolName): ToolEntry[] {
    return history.filter(entry => this.isSubagentEntry(entry, prefix));
  }

  /**
   * Finds only the child entries of a subagent
   */
  findSubagentChildEntries(history: ToolEntry[], prefix: SubagentToolName): ToolEntry[] {
    return history.filter(entry => this.isSubagentChildEntry(entry, prefix));
  }

  /**
   * Replaces a subagent group with new entries
   */
  replaceSubagentGroup(history: ToolEntry[], prefix: SubagentToolName, replacements: ToolEntry[]): void {
    this.replaceGroupInPlace(history, (entry) => this.isSubagentEntry(entry, prefix), replacements);
  }

  /**
   * Internal method to replace a group of entries matching a predicate
   */
  private replaceGroupInPlace(
    history: ToolEntry[],
    predicate: (t: ToolEntry) => boolean,
    replacements: ToolEntry[]
  ): void {
    const startIdx = history.findIndex(predicate);
    if (startIdx === -1) {
      history.push(...replacements);
      return;
    }
    let endIdx = startIdx;
    while (endIdx < history.length && predicate(history[endIdx])) {
      endIdx++;
    }
    history.splice(startIdx, endIdx - startIdx, ...replacements);
  }

  /**
   * Removes all entries from history
   */
  clear(history: ToolEntry[]): void {
    history.length = 0;
  }

  /**
   * Gets the count of pending tool entries
   */
  getPendingCount(history: ToolEntry[]): number {
    return history.filter(entry => entry.status === 'pending').length;
  }

  /**
   * Gets the count of completed tool entries
   */
  getCompletedCount(history: ToolEntry[]): number {
    return history.filter(entry => entry.status === 'completed' || entry.status === 'orphan-completed').length;
  }

  /**
   * Gets the count of errored tool entries
   */
  getErrorCount(history: ToolEntry[]): number {
    return history.filter(entry => entry.status === 'error').length;
  }
}