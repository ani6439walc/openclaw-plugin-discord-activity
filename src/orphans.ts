import type { OrphanEntry, OrphanToolManager } from "./types.js";
import { ORPHAN_TTL_SECONDS } from "./constants.js";

export function createOrphanManager(
  ttlMs: number = ORPHAN_TTL_SECONDS * 1000,
): OrphanToolManager {
  const entries = new Map<string, OrphanEntry>();

  function add(entry: OrphanEntry): void {
    const existing = entries.get(entry.toolCallId);
    entries.set(entry.toolCallId, {
      ...entry,
      createdAt: existing?.createdAt ?? entry.createdAt,
    });
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
