import { afterEach, describe, expect, it, vi } from "vitest";
import { renderStatusContent } from "./render.js";
import { defaultStore, updateStatusMessage } from "./session.js";
import { createMockSessionEntry, createToolEntry } from "../test-helpers.js";
import type { ToolEntry } from "./types.js";

function entry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    toolCallId: "call_1",
    toolName: "bash",
    params: {},
    status: "completed",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("bounded status rendering", () => {
  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.unstubAllGlobals();
  });

  it("keeps the default hard bound, semantic status headers, marker, and fence", () => {
    const huge = Array.from(
      { length: 80 },
      (_, index) => `detail ${index}`,
    ).join("\n");
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:memory",
          toolName: "active-memory:memory_search",
          params: { result: huge },
          status: "error",
          error: huge,
        }),
        entry({
          toolCallId: "skill-harness:phase",
          toolName: "skill-harness:topic-triage",
          params: { result: huge },
        }),
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
          error: huge,
        }),
        entry({
          toolCallId: "normal",
          toolName: "terminal",
          params: { command: huge },
        }),
      ],
      true,
    );

    expect(result.length).toBeLessThanOrEqual(1700);
    expect(result).toContain("🧩 active-memory: ✘");
    expect(result).toContain("💡 skill-harness: ✔");
    expect(result).toContain("🤖 agent: ✘");
    expect(result).toContain("terminal: ✔");
    expect(result).toMatch(/\.\.\. \d+ more/);
    expect(result.startsWith("```yaml\n")).toBe(true);
    expect(result.endsWith("\n```")).toBe(true);
  });

  it("never exceeds the 1700-character hard bound when configured higher", () => {
    const result = renderStatusContent(
      [
        entry({
          toolName: "terminal",
          params: { command: "x".repeat(5_000) },
        }),
      ],
      true,
      4_000,
    );

    expect(result.length).toBeLessThanOrEqual(1_700);
    expect(result.endsWith("\n```")).toBe(true);
  });

  it("truncates an oversized old header before dropping newer status headers", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "old",
          toolName: `old_${"x".repeat(500)}`,
        }),
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
          error: "provider timeout",
        }),
        entry({ toolCallId: "new", toolName: "web_search" }),
      ],
      true,
      120,
    );

    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toContain("🤖 agent: ✘");
    expect(result).toContain("web_search: ✔");
  });

  it("does not split surrogate pairs when truncating status headers", () => {
    const malformedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const history = [
      entry({
        toolCallId: "emoji",
        toolName: `emoji_${"😀".repeat(100)}`,
      }),
      entry({ toolCallId: "new", toolName: "web_search" }),
    ];

    for (let maxLength = 100; maxLength <= 130; maxLength += 1) {
      expect(renderStatusContent(history, true, maxLength)).not.toMatch(
        malformedSurrogate,
      );
    }
  });

  it("honors a custom limit without mutating session history", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({
      toolHistory: [
        createToolEntry({
          toolCallId: "one",
          toolName: "terminal",
          params: { command: "a".repeat(500) },
          status: "completed",
        }),
        createToolEntry({
          toolCallId: "two",
          toolName: "web_search",
          params: { query: "b".repeat(500) },
          status: "completed",
        }),
      ],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, undefined, 120);

    expect(session.toolHistory).toHaveLength(2);
    expect(session.lastRenderedContent?.length).toBeLessThanOrEqual(120);
    expect(session.lastRenderedContent).toContain("terminal: ✔");
    expect(session.lastRenderedContent).toContain("web_search: ✔");
    expect(session.lastRenderedContent).toMatch(/\.\.\. \d+ more/);
    expect(session.lastRenderedContent?.endsWith("\n```")).toBe(true);
  });
});
