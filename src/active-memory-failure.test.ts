import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { createOrphanManager } from "./orphans.js";
import { parseActiveMemoryToolEntries } from "./parser.js";
import { renderStatusContent } from "./render.js";
import { defaultStore } from "./session.js";
import type { ToolEntry } from "./types.js";

function activeMemoryEntry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    toolCallId: "active-memory:call_1",
    toolName: "active-memory:memory_search",
    params: { query: "hello" },
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

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("active-memory failure handling", () => {
  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.unstubAllGlobals();
  });

  it("parses recorded tool-result errors and duration when available", () => {
    const entries = parseActiveMemoryToolEntries({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "memory_search",
              arguments: { query: "hello" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "memory_search",
          content: [{ type: "text", text: "database unavailable" }],
          isError: true,
          details: { durationMs: 75 },
        },
      ],
    });

    expect(entries).toContainEqual(
      expect.objectContaining({
        toolCallId: "active-memory:call_1",
        status: "error",
        error: "database unavailable",
        durationMs: 75,
      }),
    );
  });

  it("renders each child error under its child", () => {
    const result = renderStatusContent(
      [
        activeMemoryEntry({
          toolCallId: "active-memory:call_1",
          status: "error",
          error: "database unavailable",
        }),
        activeMemoryEntry({
          toolCallId: "active-memory:call_2",
          toolName: "active-memory:memory_write",
          status: "error",
          error: "permission denied",
        }),
      ],
      true,
    );

    expect(result).toContain("memory_search: ✘");
    expect(result).toContain("error: database unavailable");
    expect(result).toContain("memory_write: ✘");
    expect(result).toContain("error: permission denied");
  });

  it("keeps a distinct parent error but deduplicates an identical one", () => {
    const distinct = renderStatusContent(
      [
        activeMemoryEntry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "error",
          error: "parent timeout",
        }),
        activeMemoryEntry({
          status: "error",
          error: "database unavailable",
        }),
      ],
      true,
    );
    expect(distinct).toContain("error: parent timeout");
    expect(distinct).toContain("error: database unavailable");

    const duplicate = renderStatusContent(
      [
        activeMemoryEntry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "error",
          error: "same failure",
        }),
        activeMemoryEntry({ status: "error", error: "same failure" }),
      ],
      true,
    );
    expect(countOccurrences(duplicate, "error: same failure")).toBe(1);
  });

  it("keeps a parent error when its duplicate child is outside the display limit", () => {
    const hiddenFailure = activeMemoryEntry({
      toolCallId: "active-memory:hidden",
      status: "error",
      error: "hidden failure",
    });
    const visibleChildren = Array.from({ length: 6 }, (_, index) =>
      activeMemoryEntry({
        toolCallId: `active-memory:visible_${index}`,
        toolName: `active-memory:visible_${index}`,
        status: "completed",
      }),
    );
    const result = renderStatusContent(
      [
        activeMemoryEntry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "error",
          error: "hidden failure",
        }),
        hiddenFailure,
        ...visibleChildren,
      ],
      true,
    );

    expect(result).not.toContain("memory_search: ✘");
    expect(result).toContain("error: hidden failure");
  });

  it("marks the group failed when children succeed but the parent fails", () => {
    const result = renderStatusContent(
      [
        activeMemoryEntry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "error",
          error: "parent timeout",
        }),
        activeMemoryEntry({ status: "completed" }),
      ],
      true,
    );

    expect(result).toContain("🧩 active-memory: ✘");
    expect(result).toContain("memory_search: ✔");
    expect(result).toContain("error: parent timeout");
  });

  it("shows failure marks without inventing missing details", () => {
    const result = renderStatusContent(
      [
        activeMemoryEntry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "error",
          error: undefined,
        }),
        activeMemoryEntry({ status: "error", error: undefined }),
      ],
      true,
    );

    expect(result).toContain("🧩 active-memory: ✘");
    expect(result).toContain("memory_search: ✘");
    expect(result).not.toContain("error:");
  });

  it("preserves live child terminal data while adding a distinct parent failure", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const handlers = createHookHandlers({
      store: defaultStore,
      orphans: createOrphanManager(),
      getToken: () => "token",
      config: resolveConfig({}),
      isActiveMemoryEnabled: () => false,
      isSkillHarnessEnabled: () => false,
    });
    const sourceSessionKey = "agent:main:discord:channel:123";
    const activeMemorySessionKey = `${sourceSessionKey}:active-memory:abc`;
    defaultStore.contexts.set("discord:channel:123", {
      actualChannelId: "123",
      sourceSessionKey,
    });
    const session = defaultStore.getOrCreateSession(
      "discord:channel:123",
      sourceSessionKey,
    );
    expect(session).toBeDefined();

    await handlers.onBeforeToolCall(
      {
        toolCallId: "call_1",
        toolName: "memory_search",
        params: { query: "hello" },
      },
      {
        sessionKey: activeMemorySessionKey,
        toolCallId: "call_1",
        toolName: "memory_search",
      },
    );
    await handlers.onAfterToolCall(
      {
        toolCallId: "call_1",
        toolName: "memory_search",
        params: { query: "hello" },
        error: "live database failure",
        durationMs: 42,
      },
      {
        sessionKey: activeMemorySessionKey,
        toolCallId: "call_1",
        toolName: "memory_search",
      },
    );
    await handlers.onAgentEnd(
      {
        success: false,
        error: "parent timeout",
        messages: [],
      },
      { sessionKey: activeMemorySessionKey },
    );

    expect(session?.toolHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "active-memory",
          status: "error",
          error: "parent timeout",
        }),
        expect.objectContaining({
          toolCallId: "active-memory:call_1",
          status: "error",
          error: "live database failure",
          durationMs: 42,
        }),
      ]),
    );
    expect(session?.lastRenderedContent).toContain("error: parent timeout");
    expect(session?.lastRenderedContent).toContain(
      "error: live database failure",
    );
  });
});
