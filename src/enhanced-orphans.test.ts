import { describe, it, expect, beforeEach } from "vitest";
import { createEnhancedOrphanManager } from "./enhanced-orphans.js";
import type { OrphanEntry } from "./types.js";

describe("EnhancedOrphanManager", () => {
  let orphans: ReturnType<typeof createEnhancedOrphanManager>;

  beforeEach(() => {
    orphans = createEnhancedOrphanManager(1000); // 1 second TTL for testing
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

  it("should return empty array from findMatching (stub implementation)", () => {
    const entry1: OrphanEntry = {
      toolCallId: "call_1",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    const entry2: OrphanEntry = {
      toolCallId: "call_2",
      toolName: "bash",
      params: { command: "ls" },
      createdAt: Date.now(),
    };

    orphans.add(entry1);
    orphans.add(entry2);

    // findMatching is a stub that returns empty array to prevent cross-context data leakage
    const context = {
      channelId: "test_channel",
      sessionKey: "test_session",
    } as any;

    const matching = orphans.findMatching(context);

    expect(matching).toHaveLength(0);
  });

  it("should find entries by predicate", () => {
    const entry1: OrphanEntry = {
      toolCallId: "call_1",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    const entry2: OrphanEntry = {
      toolCallId: "call_2",
      toolName: "bash",
      params: { command: "ls" },
      createdAt: Date.now(),
    };

    orphans.add(entry1);
    orphans.add(entry2);

    // Find entries with toolName containing 'web'
    const webEntries = orphans.find(entry => entry.toolName.includes('web'));

    expect(webEntries).toHaveLength(1);
    expect(webEntries[0]).toEqual(entry1);
  });

  it("should return the count of entries", () => {
    const entry1: OrphanEntry = {
      toolCallId: "call_1",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    const entry2: OrphanEntry = {
      toolCallId: "call_2",
      toolName: "bash",
      params: { command: "ls" },
      createdAt: Date.now(),
    };

    expect(orphans.getCount()).toBe(0);

    orphans.add(entry1);
    expect(orphans.getCount()).toBe(1);

    orphans.add(entry2);
    expect(orphans.getCount()).toBe(2);
  });

  it("should clear all entries", () => {
    const entry: OrphanEntry = {
      toolCallId: "call_1",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    orphans.add(entry);
    expect(orphans.getCount()).toBe(1);

    orphans.clear();
    expect(orphans.getCount()).toBe(0);
    expect(orphans.getAll()).toHaveLength(0);
  });

  it("should get all entries", () => {
    const entry1: OrphanEntry = {
      toolCallId: "call_1",
      toolName: "web_search",
      params: { query: "test" },
      createdAt: Date.now(),
    };

    const entry2: OrphanEntry = {
      toolCallId: "call_2",
      toolName: "bash",
      params: { command: "ls" },
      createdAt: Date.now(),
    };

    orphans.add(entry1);
    orphans.add(entry2);

    const allEntries = orphans.getAll();

    expect(allEntries).toHaveLength(2);
    expect(allEntries).toContainEqual(entry1);
    expect(allEntries).toContainEqual(entry2);
  });
});