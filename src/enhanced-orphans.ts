import type { OrphanEntry, MessageContext, EnhancedOrphanManager } from "./types.js";
import { ORPHAN_TTL_MS } from "./constants.js";
import { logger } from "../api.js";

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