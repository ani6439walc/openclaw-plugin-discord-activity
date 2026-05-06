import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOrphanToolManager } from "./orphans.js";

describe("createOrphanToolManager", () => {
  let orphans: ReturnType<typeof createOrphanToolManager>;

  beforeEach(() => {
    orphans = createOrphanToolManager(1000);
  });

  it("adds and retrieves orphan entries", () => {
    const entry = {
      toolCallId: "call_1",
      toolName: "mcp",
      params: {},
      createdAt: Date.now(),
    };
    orphans.add(entry);
    expect(orphans.get("call_1")).toEqual(entry);
  });

  it("returns undefined for missing entries", () => {
    expect(orphans.get("missing")).toBeUndefined();
  });

  it("removes entries", () => {
    orphans.add({
      toolCallId: "call_1",
      toolName: "mcp",
      params: {},
      createdAt: Date.now(),
    });
    expect(orphans.remove("call_1")).toBe(true);
    expect(orphans.get("call_1")).toBeUndefined();
  });

  it("prunes stale entries", () => {
    const now = Date.now();
    orphans.add({
      toolCallId: "fresh",
      toolName: "mcp",
      params: {},
      createdAt: now,
    });
    orphans.add({
      toolCallId: "stale",
      toolName: "mcp",
      params: {},
      createdAt: now - 2000,
    });
    orphans.pruneStale();
    expect(orphans.get("fresh")).toBeDefined();
    expect(orphans.get("stale")).toBeUndefined();
  });
});
