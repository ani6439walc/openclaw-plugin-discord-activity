import type { OrphanEntry } from "./types.js";
import { ORPHAN_TTL_MS } from "./constants.js";

export function createOrphanToolManager(ttlMs: number = ORPHAN_TTL_MS) {
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

  return Object.freeze({
    add,
    get,
    remove,
    pruneStale,
  });
}
