import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultStore, updateStatusMessage } from "./session.js";
import {
  createMockSessionEntry,
  createToolEntry,
  deferred,
  flushPromises,
} from "../test-helpers.js";
import { renderStatusContent, renderStatusContentWithState } from "./render.js";
import { ToolHistoryManager } from "./tool-history-manager.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createBoundedHistory() {
  return [
    createToolEntry({
      toolCallId: "active-memory:result",
      toolName: "active-memory:result",
      params: { text: `memory-${"m".repeat(800)}` },
    }),
    createToolEntry({
      toolCallId: "skill-harness:result",
      toolName: "skill-harness:result",
      params: { text: `hint-${"h".repeat(800)}` },
    }),
    createToolEntry({
      toolCallId: "normal",
      toolName: "terminal",
      params: { command: `command-${"c".repeat(500)}` },
    }),
  ];
}

function getStatusPostBody(fetchMock: ReturnType<typeof vi.fn>): {
  readonly message_reference?: { readonly message_id: string };
} {
  const statusPost = fetchMock.mock.calls.find(([input, init]) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    return method === "POST" && /\/channels\/[^/]+\/messages$/.test(url);
  });
  if (!statusPost) {
    throw new Error("Expected a Discord status POST");
  }
  const body: { readonly message_reference?: { readonly message_id: string } } =
    JSON.parse(String(statusPost[1]?.body ?? "{}"));
  return body;
}

describe("updateStatusMessage", () => {
  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("characterizes the default status create reply behavior with and without a user message id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const sessionWithMessageId = createMockSessionEntry({
      ownerSessionKey: "discord:channel:123456",
      userMessageId: "user_message_1",
      toolHistory: [createToolEntry({ status: "pending" })],
    });
    defaultStore.sessions.set(
      sessionWithMessageId.contextKey,
      sessionWithMessageId,
    );

    await updateStatusMessage(sessionWithMessageId, () => "token");

    expect(getStatusPostBody(fetchMock).message_reference).toEqual({
      message_id: "user_message_1",
    });

    defaultStore.sessions.clear();
    fetchMock.mockClear();
    const sessionWithoutMessageId = createMockSessionEntry({
      contextKey: "discord:channel:654321",
      ownerSessionKey: "discord:channel:654321",
      userMessageId: undefined,
      toolHistory: [createToolEntry({ status: "pending" })],
    });
    defaultStore.sessions.set(
      sessionWithoutMessageId.contextKey,
      sessionWithoutMessageId,
    );

    await updateStatusMessage(sessionWithoutMessageId, () => "token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getStatusPostBody(fetchMock).message_reference).toBeUndefined();
  });

  it.each([
    ["all", "discord:channel:123456", true],
    ["all", "discord:group:123456", true],
    ["all", "agent:main:discord:direct:123456", true],
    ["direct", "discord:channel:123456", false],
    ["direct", "discord:group:123456", false],
    ["direct", "agent:main:discord:direct:123456", true],
  ] as const)(
    "creates a status POST with replyMode %s for %s",
    async (replyMode, ownerSessionKey, shouldReply) => {
      const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
      vi.stubGlobal("fetch", fetchMock);
      const session = createMockSessionEntry({
        channelId: "status_channel_123456",
        ownerSessionKey,
        userMessageId: "user_message_1",
        toolHistory: [createToolEntry({ status: "pending" })],
      });
      defaultStore.sessions.set(session.contextKey, session);

      await updateStatusMessage(
        session,
        () => "token",
        false,
        undefined,
        undefined,
        replyMode,
      );

      expect(getStatusPostBody(fetchMock).message_reference).toEqual(
        shouldReply ? { message_id: "user_message_1" } : undefined,
      );
    },
  );

  it.each(["all", "direct"] as const)(
    "creates a status POST without a reply reference when replyMode %s has no user message id",
    async (replyMode) => {
      const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
      vi.stubGlobal("fetch", fetchMock);
      const session = createMockSessionEntry({
        channelId: "status_channel_123456",
        ownerSessionKey: "agent:main:discord:direct:123456",
        userMessageId: undefined,
        toolHistory: [createToolEntry({ status: "pending" })],
      });
      defaultStore.sessions.set(session.contextKey, session);

      await updateStatusMessage(
        session,
        () => "token",
        false,
        undefined,
        undefined,
        replyMode,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getStatusPostBody(fetchMock).message_reference).toBeUndefined();
    },
  );

  it("does not create a non-final status message for a finalized session without a message id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      finalized: true,
      statusMessageId: undefined,
      toolHistory: [createToolEntry({ status: "pending" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", false, 60_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.statusMessageId).toBeUndefined();
  });

  it("creates a final status message for a finalized session when none exists yet", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/users/@me/channels") && method === "POST") {
        return jsonResponse({ id: "dm_channel_123" });
      }
      if (
        url.includes("/channels/dm_channel_123/messages") &&
        method === "POST"
      ) {
        return jsonResponse({ id: "status_1" });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      channelId: "123",
      ownerSessionKey: "agent:main:discord:direct:123",
      finalized: true,
      statusMessageId: undefined,
      toolHistory: [createToolEntry({ status: "completed" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.channelId).toBe("dm_channel_123");
    expect(session.statusMessageId).toBe("status_1");
  });

  it("still edits the existing status message for a finalized session", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/messages/status_1") && method === "PATCH") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      finalized: true,
      statusMessageId: "status_1",
      toolHistory: [createToolEntry({ status: "completed" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/messages/status_1");
    expect((init as RequestInit | undefined)?.method).toBe("PATCH");
  });

  it("skips editing when the rendered content is unchanged", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const toolHistory = [createToolEntry({ status: "completed" })];
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory,
      lastRenderedContent: renderStatusContent(toolHistory, true),
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores rendered content after a successful edit", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const toolHistory = [createToolEntry({ status: "completed" })];
    const expectedContent = renderStatusContent(toolHistory, true);
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory,
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.lastRenderedContent).toBe(expectedContent);
  });

  it("retries identical content after a failed edit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const toolHistory = [createToolEntry({ status: "completed" })];
    const expectedContent = renderStatusContent(toolHistory, true);
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory,
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.lastRenderedContent).toBe("old-content");

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.lastRenderedContent).toBe(expectedContent);
  });

  it("bounds rendered status content without trimming tool history", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory: [
        createToolEntry({
          toolCallId: "call_drop",
          params: { command: "x".repeat(180) },
        }),
        createToolEntry({
          toolCallId: "call_keep",
          params: { command: "ok" },
        }),
      ],
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000, 120);

    expect(session.toolHistory.map((entry) => entry.toolCallId)).toEqual([
      "call_drop",
      "call_keep",
    ]);
    expect(session.lastRenderedContent?.length).toBeLessThanOrEqual(120);
    expect(session.lastRenderedContent).not.toMatch(
      /\(\+\d+ (?:items?|lines?)\)/u,
    );
    expect(session.lastRenderedContent).toContain("▸");
    expect(session.lastRenderedContent?.endsWith("\n```")).toBe(true);
  });

  it("does not trim tool history just because total entries exceed the display entry limit", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const toolHistory = [
      ...Array.from({ length: 7 }, (_, index) =>
        createToolEntry({
          toolCallId: `active-memory:mem_${index}`,
          toolName: `active-memory:memory_search_${index}`,
          params: { query: `memory ${index}` },
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        createToolEntry({
          toolCallId: `normal_${index}`,
          toolName: `normal_tool_${index}`,
        }),
      ),
    ];
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory,
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(session.toolHistory).toHaveLength(14);
    expect(session.lastRenderedContent).not.toContain("memory_search_0");
    expect(session.lastRenderedContent).not.toContain("memory_search_6");
    expect(session.lastRenderedContent).not.toContain("🧩 active-memory");
    expect(session.lastRenderedContent).not.toContain("normal_tool_0");
    expect(session.lastRenderedContent).toContain("normal_tool_1");
  });

  it("commits candidate display state only after an applied edit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true })),
    );
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory: createBoundedHistory(),
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, undefined, 100);

    expect(session.confirmedDisplayState?.["group:active-memory"]).toBe(
      "removed",
    );
    expect(session.monotonicSafetyFloor).toBeUndefined();
  });

  it("keeps an applied ordinary-tool removal after dedupe rewrites its toolCallId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const toolHistory = [
      createToolEntry({
        toolCallId: "call_old",
        toolName: "old_tool",
        params: { detail: "a".repeat(70) },
      }),
      createToolEntry({
        toolCallId: "call_newer",
        toolName: "newer_tool",
        params: { detail: "b".repeat(70) },
      }),
    ];
    const retainedHeaderLength = renderStatusContentWithState(
      [toolHistory[1]],
      true,
      1_700,
      { "tool:call_newer": "collapsed" },
    ).content.length;
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory,
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(
      session,
      () => "token",
      true,
      undefined,
      retainedHeaderLength,
    );

    expect(session.confirmedDisplayState?.["tool:call_old"]).toBe("removed");
    const historyManager = new ToolHistoryManager();
    expect(
      historyManager.updateEntry(session.toolHistory, "call_old", {
        toolCallId: "call_rewritten",
        params: { detail: "short" },
      }),
    ).toBe(true);
    expect(session.toolHistory[0].displayId).toBe("call_old");

    await updateStatusMessage(session, () => "token", true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.lastRenderedContent).not.toContain("old_tool");
    expect(session.lastRenderedContent).toContain("newer_tool");
    expect(session.confirmedDisplayState?.["tool:call_old"]).toBe("removed");
  });

  it("does not advance display state after a rejected edit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Forbidden" }, 403)),
    );
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory: createBoundedHistory(),
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, undefined, 400);

    expect(session.confirmedDisplayState).toBeUndefined();
    expect(session.monotonicSafetyFloor).toBeUndefined();
    expect(session.lastRenderedContent).toBe("old-content");
  });

  it("raises only the safety floor after an uncertain edit and retries from that floor", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory: createBoundedHistory(),
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    const uncertainUpdate = updateStatusMessage(
      session,
      () => "token",
      true,
      undefined,
      100,
    );
    await vi.runAllTimersAsync();
    await uncertainUpdate;

    expect(session.confirmedDisplayState).toBeUndefined();
    expect(session.monotonicSafetyFloor?.["group:active-memory"]).toBe(
      "removed",
    );
    expect(session.lastRenderedContent).toBe("old-content");

    session.toolHistory = createBoundedHistory().slice(0, 2);
    await updateStatusMessage(session, () => "token", true);

    const retryBody = JSON.parse(
      String((fetchMock.mock.calls[3]?.[1] as RequestInit).body),
    ) as { content: string };
    expect(retryBody.content).not.toContain("active-memory");
    expect(session.confirmedDisplayState?.["group:active-memory"]).toBe(
      "removed",
    );
  });

  it("does not use the unchanged-content shortcut after an uncertain edit", async () => {
    vi.useFakeTimers();
    const historyA = [createToolEntry({ toolCallId: "frame_a" })];
    const historyB = [
      createToolEntry({
        toolCallId: "frame_b",
        params: { command: "different frame" },
      }),
    ];
    const contentA = renderStatusContent(historyA, true);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory: historyB,
      lastRenderedContent: contentA,
    });
    defaultStore.sessions.set(session.contextKey, session);

    const uncertainUpdate = updateStatusMessage(session, () => "token", true);
    await vi.runAllTimersAsync();
    await uncertainUpdate;
    expect(session.contentDeliveryUncertain).toBe(true);

    session.toolHistory = historyA;
    await updateStatusMessage(session, () => "token", true);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(session.contentDeliveryUncertain).toBe(false);
    expect(session.lastRenderedContent).toBe(contentA);
  });

  it("keeps a status message until its latest activity becomes idle", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      if (method === "POST" && url.includes("/messages")) {
        return jsonResponse({ id: "status_1" });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({
      toolHistory: [createToolEntry({ status: "pending" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", false, 100);
    await vi.advanceTimersByTimeAsync(90);

    session.toolHistory = [createToolEntry({ status: "completed" })];
    await updateStatusMessage(session, () => "token", false, 100);

    await vi.advanceTimersByTimeAsync(10);
    expect(
      fetchMock.mock.calls.some(
        ([_, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(90);
    expect(
      fetchMock.mock.calls.filter(
        ([_, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toHaveLength(1);
    expect(defaultStore.sessions.has(session.contextKey)).toBe(false);
  });

  it("reuses one create nonce after an uncertain POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: "status_1" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({
      toolHistory: createBoundedHistory(),
    });
    defaultStore.sessions.set(session.contextKey, session);

    const uncertainUpdate = updateStatusMessage(
      session,
      () => "token",
      true,
      undefined,
      100,
    );
    await vi.runAllTimersAsync();
    await uncertainUpdate;
    const uncertainNonce = session.statusCreateNonce;

    expect(uncertainNonce).toEqual(expect.any(String));
    expect(session.monotonicSafetyFloor?.["group:active-memory"]).toBe(
      "removed",
    );

    await updateStatusMessage(session, () => "", true, undefined, 100);
    expect(session.statusCreateNonce).toBe(uncertainNonce);

    session.toolHistory = createBoundedHistory().slice(0, 2);
    await updateStatusMessage(session, () => "token", true, undefined, 100);

    const postCalls = fetchMock.mock.calls.filter(
      ([_, init]) => (init as RequestInit).method === "POST",
    );
    const nonces = postCalls.map(
      ([_, init]) => JSON.parse(String((init as RequestInit).body)).nonce,
    );
    expect(nonces).toEqual(Array(4).fill(uncertainNonce));
    expect((fetchMock.mock.calls[4]?.[1] as RequestInit).method).toBe("PATCH");
    expect(session.statusMessageId).toBe("status_1");
    expect(session.statusCreateNonce).toBeUndefined();
    expect(session.confirmedDisplayState?.["group:active-memory"]).toBe(
      "removed",
    );
  });

  it("does not commit a deferred PATCH outcome into a replacement session", async () => {
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const stale = createMockSessionEntry({
      generation: 1,
      statusMessageId: "status_1",
      toolHistory: createBoundedHistory(),
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(stale.contextKey, stale);

    const update = updateStatusMessage(
      stale,
      () => "token",
      true,
      undefined,
      400,
    );
    await flushPromises();
    const replacement = createMockSessionEntry({ generation: 2 });
    defaultStore.sessions.set(stale.contextKey, replacement);
    response.resolve(jsonResponse({ ok: true }));
    await update;

    expect(stale.lastRenderedContent).toBe("old-content");
    expect(stale.confirmedDisplayState).toBeUndefined();
    expect(stale.monotonicSafetyFloor).toBeUndefined();
    expect(replacement.confirmedDisplayState).toBeUndefined();
  });

  it("does not commit a deferred POST outcome into a replacement session", async () => {
    const response = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const stale = createMockSessionEntry({
      generation: 1,
      toolHistory: createBoundedHistory(),
    });
    defaultStore.sessions.set(stale.contextKey, stale);

    const update = updateStatusMessage(
      stale,
      () => "token",
      true,
      undefined,
      400,
    );
    await flushPromises();
    const replacement = createMockSessionEntry({ generation: 2 });
    defaultStore.sessions.set(stale.contextKey, replacement);
    response.resolve(jsonResponse({ id: "status_stale" }));
    await update;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stale.statusMessageId).toBeUndefined();
    expect(stale.confirmedDisplayState).toBeUndefined();
    expect(stale.monotonicSafetyFloor).toBeUndefined();
    expect(replacement.statusMessageId).toBeUndefined();
  });
});
