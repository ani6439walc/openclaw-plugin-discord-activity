import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookHandlers } from "./hooks.js";
import { resolveConfig } from "./config.js";
import { createOrphanManager } from "./orphans.js";
import { defaultStore as store } from "./session.js";

describe("logical run lifecycle", () => {
  const sessionKey = "agent:main:discord:channel:123";
  const contextKey = "discord:channel:123";
  const ctx = { sessionKey, runId: "logical-run" };
  const handlers = createHookHandlers({
    store,
    orphans: createOrphanManager(),
    getToken: () => "test-token",
    config: resolveConfig({}),
  });
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ id: "status-1" })),
  );

  beforeEach(() => {
    vi.useFakeTimers();
    store.sessions.clear();
    store.contexts.clear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const session of store.sessions.values()) {
      clearTimeout(session.clearTimer);
      clearTimeout(session.maxDisplayTimer);
    }
    store.sessions.clear();
    store.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function start() {
    await handlers.onMessageReceived(
      { messageId: "user-1", metadata: { to: "channel:123" } },
      { ...ctx, channelId: "discord" },
    );
    await handlers.onBeforeToolCall(
      { toolCallId: "tool-1", toolName: "exec", params: {} },
      { ...ctx, toolName: "exec" },
    );
    return store.sessions.get(contextKey)!;
  }

  function lifecycle(phase = "end", executionSettled: unknown = true) {
    return { ...ctx, stream: "lifecycle", data: { phase, executionSettled } };
  }

  it("keeps the same card after a successful attempt and an intermediate reply until tools and compaction continue", async () => {
    const session = await start();
    await handlers.onAgentEnd({ success: true }, ctx);
    await handlers.onMessageSending(
      { to: "channel:123", content: "Still working" },
      { ...ctx, channelId: "discord" },
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(store.sessions.get(contextKey)).toBe(session);
    expect(session.finalized).toBe(false);
    expect(session.statusMessageId).toBe("status-1");
    await handlers.onBeforeToolCall(
      { toolCallId: "tool-2", toolName: "read", params: {} },
      { ...ctx, toolName: "read" },
    );
    expect(session.toolHistory).toContainEqual(
      expect.objectContaining({ toolCallId: "tool-2", status: "pending" }),
    );
    await handlers.onBeforeCompaction({ messageCount: 20 }, ctx);
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.compactionActive).toBe(true);
    expect(store.sessions.get(contextKey)).toBe(session);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    await handlers.onAgentLifecycleEvent(lifecycle());
    await vi.advanceTimersByTimeAsync(1500);
    expect(store.sessions.has(contextKey)).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("keeps a bound live execution beyond idle and overflow grace deadlines", async () => {
    const session = await start();
    await vi.advanceTimersByTimeAsync(181000);
    expect(store.sessions.get(contextKey)).toBe(session);
    await handlers.onAgentEnd(
      { success: false, error: "Context overflow" },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(31000);
    expect(session.finalized).toBe(false);
    expect(session.statusMessageId).toBe("status-1");
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it.each([
    { phase: "finishing", executionSettled: true },
    { phase: "end", executionSettled: false },
    { phase: "error" },
    { phase: "end", executionSettled: "true" },
  ])("ignores unsettled lifecycle %j", async (data) => {
    const session = await start();
    await handlers.onAgentLifecycleEvent({ ...lifecycle(), data });
    expect(session.finalized).toBe(false);
    expect(session.clearTimer).toBeUndefined();
  });

  it.each(["end", "error"])(
    "settles %s once and ignores late tools and compaction",
    async (phase) => {
      const session = await start();
      const terminal = {
        ...lifecycle(phase),
        data: {
          ...lifecycle(phase).data,
          error: phase === "error" ? "provider timeout" : undefined,
        },
      };
      await handlers.onAgentLifecycleEvent(terminal);
      const calls = fetchMock.mock.calls.length;
      const cleanup = session.clearTimer;
      const terminalHistory = structuredClone(session.toolHistory);
      await handlers.onAgentLifecycleEvent(terminal);
      await handlers.onBeforeToolCall(
        { toolCallId: "late", toolName: "read", params: {} },
        { ...ctx, toolName: "read" },
      );
      await handlers.onAfterToolCall(
        {
          toolCallId: "tool-1",
          toolName: "exec",
          params: {},
          durationMs: 100,
        },
        { ...ctx, toolName: "exec" },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "late", toolName: "read", params: {} },
        { ...ctx, toolName: "read" },
      );
      await handlers.onBeforeCompaction({ messageCount: 20 }, ctx);
      expect(fetchMock.mock.calls).toHaveLength(calls);
      expect(session.clearTimer).toBe(cleanup);
      expect(session.finalized).toBe(true);
      expect(session.toolHistory).toEqual(terminalHistory);
      expect(
        session.toolHistory.some((entry) => entry.toolCallId === "late"),
      ).toBe(false);
      if (phase === "error")
        expect(session.lastRenderedContent).toContain("provider timeout");
      await vi.advanceTimersByTimeAsync(1500);
      await handlers.onAgentLifecycleEvent(terminal);
      expect(store.sessions.has(contextKey)).toBe(false);
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
      ).toHaveLength(1);
    },
  );

  it("ignores terminal events without exact current owner and run provenance", async () => {
    const session = await start();
    session.activeRunIds?.add("older-admitted");
    session.supersededRunIds = new Set(["superseded"]);
    for (const event of [
      { ...lifecycle(), sessionKey: undefined },
      { ...lifecycle(), runId: "" },
      { ...lifecycle(), runId: "older-admitted" },
      { ...lifecycle(), runId: "superseded" },
      { ...lifecycle(), sessionKey: "agent:other:discord:channel:123" },
      { ...lifecycle(), sessionKey: `${sessionKey}:subagent:child` },
      { ...lifecycle(), sessionKey: `${sessionKey}:active-memory:child` },
    ])
      await handlers.onAgentLifecycleEvent(event);
    expect(session.finalized).toBe(false);
    expect(session.clearTimer).toBeUndefined();
    expect(store.sessions.get(contextKey)).toBe(session);
  });

  it("keeps replacement generation safe from an old settled event", async () => {
    const old = await start();
    await handlers.onMessageReceived(
      { messageId: "next", metadata: { to: "channel:123" } },
      {
        channelId: "discord",
        sessionKey: "agent:other:discord:channel:123",
        runId: "new-run",
      },
    );
    const replacement = store.sessions.get(contextKey)!;
    expect(replacement).not.toBe(old);
    await handlers.onAgentLifecycleEvent(lifecycle());
    expect(replacement.finalized).toBe(false);
    expect(replacement.clearTimer).toBeUndefined();
  });

  it("settles behind an in-flight status update and tolerates duplicate notification", async () => {
    const session = await start();
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify({ id: "status-1" }));
    });
    const update = handlers.onBeforeToolCall(
      { toolCallId: "tool-2", toolName: "read", params: {} },
      { ...ctx, toolName: "read" },
    );
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    const terminal = handlers.onAgentLifecycleEvent(lifecycle());
    await handlers.onAgentLifecycleEvent(lifecycle());
    release!();
    await Promise.all([update, terminal]);
    expect(session.finalized).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(store.sessions.has(contextKey)).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("preserves a newly admitted run when an unbound idle DELETE is already in flight", async () => {
    const unbound = { sessionKey, channelId: "discord" };
    await handlers.onMessageReceived(
      { messageId: "unbound", metadata: { to: "channel:123" } },
      unbound,
    );
    await handlers.onBeforeToolCall(
      { toolCallId: "unbound-tool", toolName: "exec", params: {} },
      { sessionKey, toolName: "exec" },
    );
    const session = store.sessions.get(contextKey)!;
    await session.pendingOp;
    let releaseDelete!: () => void;
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      return new Response(null, { status: 204 });
    });
    await vi.advanceTimersByTimeAsync(181000);
    expect(releaseDelete).toBeDefined();
    await handlers.onBeforeAgentReply({ cleanedBody: "admitted" }, ctx);
    const deletion = session.pendingOp;
    releaseDelete();
    await deletion;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(store.sessions.get(contextKey)).toBe(session);
    expect(store.contexts.has(contextKey)).toBe(true);
    expect(session.runId).toBe(ctx.runId);
    expect(session.toolHistory).toContainEqual(
      expect.objectContaining({ toolCallId: "unbound-tool" }),
    );
    await handlers.onBeforeToolCall(
      { toolCallId: "new-tool", toolName: "read", params: {} },
      { ...ctx, toolName: "read" },
    );
    await session.pendingOp;
    expect(session.statusMessageId).toBe("status-1");
  });
});
