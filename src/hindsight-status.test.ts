import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { clearAllSessionTimers } from "./helpers.js";
import { createOrphanManager } from "./orphans.js";
import { defaultStore } from "./session.js";
import { parseHindsightRecallEvent } from "./hindsight-status.js";
import { getDiscordContextKey } from "./parser.js";
import type { AgentPipelineEvent } from "./types.js";
import { deferred, flushPromises } from "../test-helpers.js";

const sessionKey = "agent:main:discord:channel:123456789012345678";
const contextKey = getDiscordContextKey(sessionKey)!;
const ctx = { sessionKey, runId: "run-1", channelId: "discord" };

function recallEvent(
  data: Record<string, unknown> = {},
  envelope: Partial<AgentPipelineEvent> = {},
): AgentPipelineEvent {
  return {
    stream: "hindsight-openclaw.recall",
    sessionKey,
    runId: "run-1",
    data: {
      kind: "hindsight.recall",
      recallId: "recall-1",
      state: "started",
      ...data,
    },
    ...envelope,
  };
}

describe("Hindsight recall status", () => {
  let handlers: ReturnType<typeof createHookHandlers>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: "status-1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    handlers = createHookHandlers({
      store: defaultStore,
      orphans: createOrphanManager(),
      getToken: () => "test-token",
      config: resolveConfig({}),
      isActiveMemoryEnabled: () => false,
      isSkillHarnessEnabled: () => false,
    });
    await handlers.onMessageReceived(
      {
        messageId: "message-1",
        metadata: { to: "channel:123456789012345678" },
      },
      ctx,
    );
  });

  afterEach(() => {
    for (const session of defaultStore.sessions.values())
      clearAllSessionTimers(session);
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function session() {
    return defaultStore.sessions.get(contextKey)!;
  }

  function content() {
    return session().lastRenderedContent?.replaceAll(/\u001b\[[0-9;]*m/g, "");
  }

  it("creates progress before tools, edits the same message, and cleans up at agent end", async () => {
    await handlers.onHindsightRecallEvent(recallEvent());
    expect(content()).toContain("🧠 hindsight-recall");
    expect(content()).toContain("Recalling memories");
    await handlers.onHindsightRecallEvent(
      recallEvent({ state: "completed", durationMs: 1240, resultCount: 3 }),
    );
    expect(content()).toContain("✔ [1.24s]");
    expect(content()).toContain("3 memories recalled");
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(1);
    await handlers.onAgentEnd({ success: true }, ctx);
    await vi.advanceTimersByTimeAsync(1500);
    expect(defaultStore.sessions.has(contextKey)).toBe(false);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
  });

  it.each([
    [
      { state: "completed", resultCount: 0 },
      "No relevant memories",
      "completed",
    ],
    [{ state: "failed", reason: "timeout" }, "Recall timed out", "error"],
    [{ state: "failed", reason: "error" }, "Recall failed", "error"],
    [
      { state: "cancelled", reason: "service_stopped" },
      "Recall cancelled",
      "error",
    ],
    [
      { state: "skipped", reason: "client_unavailable" },
      "Recall skipped",
      "completed",
    ],
  ])(
    "renders the terminal outcome %j without requiring a start",
    async (data, label, status) => {
      await handlers.onHindsightRecallEvent(
        recallEvent({ ...data, durationMs: 120 }),
      );
      expect(content()).toContain(label);
      expect(session().toolHistory[0].status).toBe(status);
    },
  );

  it.each(["completed", "failed", "cancelled", "skipped"])(
    "does not regress %s on duplicate or late start events",
    async (state) => {
      const terminal = recallEvent({ state, resultCount: 2, durationMs: 120 });
      await handlers.onHindsightRecallEvent(terminal);
      const before = structuredClone(session().toolHistory);
      await handlers.onHindsightRecallEvent(recallEvent());
      await handlers.onHindsightRecallEvent(terminal);
      expect(session().toolHistory).toEqual(before);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps concurrent recall invocations separate and completion ordered", async () => {
    await Promise.all([
      handlers.onHindsightRecallEvent(recallEvent()),
      handlers.onHindsightRecallEvent(recallEvent({ recallId: "recall-2" })),
    ]);
    await handlers.onHindsightRecallEvent(
      recallEvent({
        recallId: "recall-2",
        state: "completed",
        resultCount: 0,
        durationMs: 10,
      }),
    );
    expect(session().toolHistory.map((entry) => entry.status)).toEqual([
      "pending",
      "completed",
    ]);
    await handlers.onHindsightRecallEvent(
      recallEvent({ state: "failed", reason: "timeout", durationMs: 10000 }),
    );
    expect(session().toolHistory.map((entry) => entry.status)).toEqual([
      "error",
      "completed",
    ]);
  });

  it("never exposes arbitrary producer fields, query text, or error messages", async () => {
    await handlers.onHindsightRecallEvent(
      recallEvent({
        state: "failed",
        durationMs: 100,
        reason: "private bank name",
        query: "secret-query",
        memories: ["secret-memory"],
        error: "secret-error",
        bankId: "secret-bank",
        result: "secret-result",
      }),
    );
    expect(content()).toContain("Recall failed");
    expect(content()).not.toMatch(/secret-|private bank/);
  });

  it("uses data.sessionKey when the host omits the envelope key", async () => {
    await handlers.onHindsightRecallEvent(
      recallEvent({ sessionKey }, { sessionKey: undefined }),
    );
    expect(content()).toContain("Recalling memories");
  });

  it("ignores stale runs, internal sessions, and inconsistent routing", async () => {
    await handlers.onHindsightRecallEvent(
      recallEvent({}, { runId: "old-run" }),
    );
    await handlers.onHindsightRecallEvent(
      recallEvent({}, { sessionKey: `${sessionKey}:subagent:child` }),
    );
    await handlers.onHindsightRecallEvent(
      recallEvent({ sessionKey: "different-owner" }),
    );
    expect(session().toolHistory).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["reply", "agent_end"])(
    "ends unobserved recall on %s and ignores late completion",
    async (finalizer) => {
      await handlers.onHindsightRecallEvent(recallEvent());
      if (finalizer === "reply") {
        await handlers.onMessageSending(
          { to: "channel:123456789012345678", content: "Reply" },
          ctx,
        );
      } else {
        await handlers.onAgentEnd(
          { success: false, error: "Agent interrupted" },
          ctx,
        );
      }
      expect(content()).toContain("Recall outcome unavailable");
      const before = structuredClone(session().toolHistory);
      const calls = fetchMock.mock.calls.length;
      await handlers.onHindsightRecallEvent(
        recallEvent({ state: "completed", durationMs: 100, resultCount: 1 }),
      );
      expect(session().toolHistory).toEqual(before);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    },
  );

  it("preserves the successor generation while the old Discord request is in flight", async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const oldUpdate = handlers.onHindsightRecallEvent(recallEvent());
    await flushPromises();
    const previous = session();
    await handlers.onMessageReceived(
      {
        messageId: "message-2",
        metadata: { to: "channel:123456789012345678" },
      },
      { ...ctx, runId: "run-2" },
    );
    expect(session()).not.toBe(previous);
    response.resolve(Response.json({ id: "old-status" }));
    await oldUpdate;
    await handlers.onHindsightRecallEvent(
      recallEvent({ state: "completed", resultCount: 1, durationMs: 100 }),
    );
    expect(session().toolHistory).toEqual([]);
    await handlers.onHindsightRecallEvent(recallEvent({}, { runId: "run-2" }));
    expect(session().toolHistory).toHaveLength(1);
    expect(session().toolHistory[0].toolCallId).toContain("run-2");
    await flushPromises();
  });

  it("fails open when Discord rejects a status update", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: "Forbidden" }, { status: 403 }),
    );
    await expect(
      handlers.onHindsightRecallEvent(recallEvent()),
    ).resolves.toBeUndefined();
    await expect(
      handlers.onHindsightRecallEvent(
        recallEvent({ state: "completed", resultCount: 1, durationMs: 100 }),
      ),
    ).resolves.toBeUndefined();
    expect(session().toolHistory[0].status).toBe("completed");
  });
});

describe("Hindsight event validation", () => {
  it.each([
    recallEvent({}, { stream: "other", runId: "run-1" }),
    recallEvent({}, { runId: "" }),
    recallEvent({ pluginId: "other" }),
    recallEvent({ kind: "other" }),
    recallEvent({ recallId: "" }),
    recallEvent({ recallId: "x\n" }),
    recallEvent({ state: "unknown" }),
    recallEvent({ state: "completed", durationMs: -1, resultCount: 0 }),
    recallEvent({ state: "completed", durationMs: Infinity, resultCount: 0 }),
    recallEvent({ state: "completed", durationMs: 1, resultCount: NaN }),
    recallEvent({ state: "completed", durationMs: 1, resultCount: -1 }),
    recallEvent({ state: "completed", durationMs: 1, resultCount: 1.5 }),
    recallEvent({ state: "completed", durationMs: 1 }),
    recallEvent({}, { sessionKey: undefined }),
  ])("ignores malformed events %j", (event) => {
    expect(parseHindsightRecallEvent(event)).toBeUndefined();
  });
});
