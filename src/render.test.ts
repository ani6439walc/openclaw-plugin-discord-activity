import { describe, it, expect } from "vitest";
import { renderStatusContent, isContentTooLong } from "./render.js";
import type { ToolEntry } from "./types.js";

function makeEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    toolCallId: "call_001",
    toolName: "bash",
    params: { command: "ls" },
    status: "pending",
    ...overrides,
  };
}

describe("renderStatusContent", () => {
  it("renders a single pending tool", () => {
    const result = renderStatusContent([makeEntry()], false);
    expect(result).toContain("bash");
    expect(result).toContain("←");
    expect(result).toContain("```yaml");
  });

  it("renders completed tool with checkmark when final", () => {
    const result = renderStatusContent(
      [makeEntry({ status: "completed" })],
      true,
    );
    expect(result).toContain("bash");
    expect(result).toContain("✔");
  });

  it("renders error tool with x mark", () => {
    const result = renderStatusContent([makeEntry({ status: "error" })], false);
    expect(result).toContain("✘");
  });

  it("renders orphan-completed with recycle mark", () => {
    const result = renderStatusContent(
      [makeEntry({ status: "orphan-completed" })],
      false,
    );
    expect(result).toContain("♻︎");
  });

  it("renders active-memory group with completed suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "am1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "am2",
        toolName: "active-memory:memory_read",
        params: { id: "123" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(result).toContain("🧠 active-memory: ♻︎");
    expect(result).toContain("memory_search");
    expect(result).toContain("memory_read");
  });

  it("renders active-memory group with pending suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "pending",
      },
    ];
    const result = renderStatusContent(entries, false);
    expect(result).toContain("🧠 active-memory: ←");
  });

  it("renders mixed normal and active-memory entries", () => {
    const entries: ToolEntry[] = [
      makeEntry({ toolName: "web_search", status: "completed" }),
      {
        toolCallId: "am1",
        toolName: "active-memory:search",
        params: {},
        status: "completed",
      },
      makeEntry({ toolName: "read", status: "pending" }),
    ];
    const result = renderStatusContent(entries, false);
    expect(result).toContain("web_search");
    expect(result).toContain("active-memory");
    expect(result).toContain("read");
  });
});

describe("isContentTooLong", () => {
  it("returns true when content exceeds max length", () => {
    expect(isContentTooLong("x".repeat(1701), 1)).toBe(true);
  });

  it("returns true when entry count exceeds max", () => {
    expect(isContentTooLong("short", 7)).toBe(true);
  });

  it("returns false when within limits", () => {
    expect(isContentTooLong("short", 1)).toBe(false);
  });
});
