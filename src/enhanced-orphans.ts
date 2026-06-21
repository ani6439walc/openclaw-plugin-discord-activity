import type { OrphanEntry, MessageContext } from "./types.js";
import { ORPHAN_TTL_MS } from "./constants.js";
import { logger } from "../api.js";

export type EnhancedOrphanManager = {
  /**
   * Adds a new orphan entry to the collection
   */
  add(entry: OrphanEntry): void;

  /**
   * Retrieves an orphan entry by its tool call ID
   */
  get(toolCallId: string): OrphanEntry | undefined;

  /**
   * Removes an orphan entry by its tool call ID
   */
  remove(toolCallId: string): boolean;

  /**
   * Removes all orphan entries that have exceeded their TTL
   */
  pruneStale(): void;

  /**
   * Finds all orphan entries matching a specific message context
   */
  findMatching(context: MessageContext): OrphanEntry[];

  /**
   * Finds orphan entries by a custom predicate function
   */
  find(predicate: (entry: OrphanEntry) => boolean): OrphanEntry[];

  /**
   * Gets the total count of orphan entries
   */
  getCount(): number;

  /**
   * Clears all orphan entries
   */
  clear(): void;

  /**
   * Gets all orphan entries
   */
  getAll(): OrphanEntry[];
};

export function createEnhancedOrphanManager(ttlMs: number = ORPHAN_TTL_MS): EnhancedOrphanManager {
  const entries = new Map<string, OrphanEntry>();

  function add(entry: OrphanEntry): void {
    entries.set(entry.toolCallId, entry);
  }

  function get(toolCallId: string): OrphanEntry | undefined {
    return entries.get(toolCallId);
  }

  function remove(toolCallId: string): boolean {
    return entries.delete(toolCallId);
  }

  function pruneStale(): void {
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (now - entry.createdAt > ttlMs) {
        entries.delete(id);
      }
    }
  }

  function findMatching(context: MessageContext): OrphanEntry[] {
    // STUB: Context-based matching is not yet implemented
    // Returns empty array to prevent cross-context data leakage
    // TODO: Implement proper filtering based on channelId, accountId, etc.
    logger.warn(
      "EnhancedOrphanManager.findMatching() is not implemented. " +
      "This method currently returns an empty array to prevent data leakage. " +
      "Future versions should implement context-based filtering."
    );
    return [];
  }

  function find(predicate: (entry: OrphanEntry) => boolean): OrphanEntry[] {
    return Array.from(entries.values()).filter(predicate);
  }

  function getCount(): number {
    return entries.size;
  }

  function clear(): void {
    entries.clear();
  }

  function getAll(): OrphanEntry[] {
    return Array.from(entries.values());
  }

  return Object.freeze({
    add,
    get,
    remove,
    pruneStale,
    findMatching,
    find,
    getCount,
    clear,
    getAll,
  });
}