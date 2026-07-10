import { describe, it, expect, beforeEach } from "vitest";
import { createOrphanManager } from "./orphans.js";
import type { OrphanEntry } from "./types.js";

describe("OrphanManager", () => {
  let orphans: ReturnType<typeof createOrphanManager>;

  beforeEach(() => {
    orphans = createOrphanManager(1000); // 1 second TTL for testing
  });

  it("should add and retrieve an orphan entry", () => {
    const entry: OrphanEntry = {
      toolCallId: "call_1",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    orphans.add(entry);
    const retrieved = orphans.get("call_1");

    expect(retrieved).toEqual(entry);
  });

  it("should remove an orphan entry", () => {
    const entry: OrphanEntry = {
      toolCallId: "call_1",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    orphans.add(entry);
    const removed = orphans.remove("call_1");
    const retrieved = orphans.get("call_1");

    expect(removed).toBe(true);
    expect(retrieved).toBeUndefined();
  });

  it("should return false when removing a non-existent entry", () => {
    const removed = orphans.remove("nonexistent");

    expect(removed).toBe(false);
  });

  it("should prune stale entries", async () => {
    // Create an entry with a past timestamp to make it stale
    const staleEntry: OrphanEntry = {
      toolCallId: "stale_call",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now() - 2000, // 2 seconds ago, beyond our 1 second TTL
    };

    const freshEntry: OrphanEntry = {
      toolCallId: "fresh_call",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    orphans.add(staleEntry);
    orphans.add(freshEntry);

    // Prune stale entries
    orphans.pruneStale();

    const staleRetrieved = orphans.get("stale_call");
    const freshRetrieved = orphans.get("fresh_call");

    expect(staleRetrieved).toBeUndefined();
    expect(freshRetrieved).toEqual(freshEntry);
  });
});
