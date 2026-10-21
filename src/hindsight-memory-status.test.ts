import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { clearAllSessionTimers } from "./helpers.js";
import { createOrphanManager } from "./orphans.js";
import { defaultStore } from "./session.js";
import { parseHindsightMemoryRecallEvent } from "./hindsight-memory-status.js";
import { getDiscordContextKey } from "./parser.js";
import type { AgentPipelineEvent } from "./types.js";
import { deferred, flushPromises } from "../test-helpers.js";

const sessionKey = "agent:main:discord:channel:123456789012345678";
const contextKey = getDiscordContextKey(sessionKey)!;
const ctx = { sessionKey, runId: "run-1", channelId: "discord" };

function hindsightMemoryRecallEvent(
  data: Record<string, unknown> = {},
  envelope: Partial<AgentPipelineEvent> = {},
): AgentPipelineEvent {
  return {
    stream: "plugin:hindsight-memory",
    sessionKey,
    runId: "run-1",
    data: {
      kind: "hindsight-memory.recall",
      pluginId: "hindsight-memory",
      recallId: "recall-1",
      state: "started",
      ...data,
    },
    ...envelope,
  };
}

describe("Hindsight Memory recall status", () => {
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
    await handlers.onHindsightMemoryPipelineEvent(hindsightMemoryRecallEvent());
    expect(content()).toContain("🧠 hindsight-memory");
    expect(content()).not.toContain("🧠 hindsight-recall");
    expect(content()).toContain("recalling memories");
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        state: "completed",
        durationMs: 1240,
        resultCount: 3,
      }),
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

  it("renders hindsight-memory before skill-harness when hindsight-memory is first in history", async () => {
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        state: "completed",
        durationMs: 1570,
        resultCount: 8,
      }),
    );
    session().toolHistory.push({
      toolCallId: "skill-harness",
      toolName: "skill-harness",
      params: { result: "no relevant skills" },
      status: "completed",
      durationMs: 2920,
    });
    session().toolHistory.push({
      toolCallId: "call_bash",
      toolName: "bash",
      params: { command: "ls" },
      status: "completed",
    });
    await handlers.onAgentEnd({ success: true }, ctx);
    const rendered = session().lastRenderedContent?.replaceAll(
      /\u001b\[[0-9;]*m/g,
      "",
    );
    expect(rendered).toBeDefined();
    const hsPos = rendered!.indexOf("🧠 hindsight-memory");
    const shPos = rendered!.indexOf("💡 skill-harness");
    const bashPos = rendered!.indexOf("bash");
    expect(hsPos).toBeLessThan(shPos);
    expect(shPos).toBeLessThan(bashPos);
    expect(rendered).toContain("🧠 hindsight-memory ▾ ✔ [1.57s]");
    expect(rendered).toContain("    ⊹ 8 memories recalled");
    expect(rendered).toContain("💡 skill-harness ▾ ✔ [2.92s]");
    expect(rendered).toContain("    ⊹ no relevant skills");
  });

  it.each([
    [
      { state: "completed", resultCount: 0 },
      "no relevant memories",
      "completed",
    ],
    [{ state: "failed", reason: "timeout" }, "recall timed out", "error"],
    [{ state: "failed", reason: "error" }, "recall failed", "error"],
    [
      { state: "cancelled", reason: "service_stopped" },
      "recall cancelled",
      "error",
    ],
    [
      { state: "skipped", reason: "client_unavailable" },
      "recall skipped",
      "completed",
    ],
  ])(
    "renders the terminal outcome %j without requiring a start",
    async (data, label, status) => {
      await handlers.onHindsightMemoryPipelineEvent(
        hindsightMemoryRecallEvent({ ...data, durationMs: 120 }),
      );
      expect(content()).toContain(label);
      expect(session().toolHistory[0].status).toBe(status);
    },
  );

  it.each(["completed", "failed", "cancelled", "skipped"])(
    "does not regress %s on duplicate or late start events",
    async (state) => {
      const terminal = hindsightMemoryRecallEvent({
        state,
        resultCount: 2,
        durationMs: 120,
      });
      await handlers.onHindsightMemoryPipelineEvent(terminal);
      const before = structuredClone(session().toolHistory);
      await handlers.onHindsightMemoryPipelineEvent(
        hindsightMemoryRecallEvent(),
      );
      await handlers.onHindsightMemoryPipelineEvent(terminal);
      expect(session().toolHistory).toEqual(before);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps concurrent recall invocations separate and completion ordered", async () => {
    await Promise.all([
      handlers.onHindsightMemoryPipelineEvent(hindsightMemoryRecallEvent()),
      handlers.onHindsightMemoryPipelineEvent(
        hindsightMemoryRecallEvent({ recallId: "recall-2" }),
      ),
    ]);
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
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
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        state: "failed",
        reason: "timeout",
        durationMs: 10000,
      }),
    );
    expect(session().toolHistory.map((entry) => entry.status)).toEqual([
      "error",
      "completed",
    ]);
  });

  it("retains errors and shows only the latest observed progress or result", async () => {
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        state: "failed",
        reason: "timeout",
        durationMs: 1000,
      }),
    );
    expect(content()).toContain("    ⊹ recall timed out ✘");
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({ recallId: "retry" }),
    );
    expect(content()).toContain(
      "    ⊹ recall timed out ✘\n    ⊹ recalling memories",
    );
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        recallId: "retry",
        state: "completed",
        resultCount: 2,
        durationMs: 2000,
      }),
    );
    expect(content()).toContain(
      "    ⊹ recall timed out ✘\n    ⊹ 2 memories recalled",
    );
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        recallId: "third",
        state: "completed",
        resultCount: 4,
        durationMs: 3350,
      }),
    );
    expect(content()).toContain("🧠 hindsight-memory ▾ ♻︎ [3.35s]");
    expect(content()).toContain(
      "    ⊹ recall timed out ✘\n    ⊹ 4 memories recalled",
    );
    expect(content()).not.toContain("2 memories recalled");
    expect(content()?.match(/⊹/g)).toHaveLength(2);
  });

  it("shows one latest result in completion order even when an earlier recall finishes last", async () => {
    await handlers.onHindsightMemoryPipelineEvent(hindsightMemoryRecallEvent());
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({ recallId: "second" }),
    );
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        recallId: "second",
        state: "completed",
        resultCount: 2,
        durationMs: 2000,
      }),
    );
    expect(content()).toContain("    ⊹ 2 memories recalled");
    expect(content()?.match(/⊹/g)).toHaveLength(1);
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        state: "completed",
        resultCount: 4,
        durationMs: 3350,
      }),
    );
    expect(content()).toContain("✔ [3.35s]");
    expect(content()).toContain("    ⊹ 4 memories recalled");
    expect(content()).not.toContain("2 memories recalled");
    expect(content()?.match(/⊹/g)).toHaveLength(1);
  });

  it("never exposes arbitrary producer fields, query text, or error messages", async () => {
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
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
    expect(content()).toContain("recall failed");
    expect(content()).not.toMatch(/secret-|private bank/);
  });

  it("uses data.sessionKey when the host omits the envelope key", async () => {
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({ sessionKey }, { sessionKey: undefined }),
    );
    expect(content()).toContain("recalling memories");
  });

  it("ignores stale runs, internal sessions, and inconsistent routing", async () => {
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({}, { runId: "old-run" }),
    );
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent(
        {},
        { sessionKey: `${sessionKey}:subagent:child` },
      ),
    );
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({ sessionKey: "different-owner" }),
    );
    expect(session().toolHistory).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["reply", "agent_end"])(
    "ends unobserved recall on %s and ignores late completion",
    async (finalizer) => {
      await handlers.onHindsightMemoryPipelineEvent(
        hindsightMemoryRecallEvent(),
      );
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
      expect(content()).toContain("recall outcome unavailable");
      const before = structuredClone(session().toolHistory);
      const calls = fetchMock.mock.calls.length;
      await handlers.onHindsightMemoryPipelineEvent(
        hindsightMemoryRecallEvent({
          state: "completed",
          durationMs: 100,
          resultCount: 1,
        }),
      );
      expect(session().toolHistory).toEqual(before);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    },
  );

  it("preserves the successor generation while the old Discord request is in flight", async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const oldUpdate = handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent(),
    );
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
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({
        state: "completed",
        resultCount: 1,
        durationMs: 100,
      }),
    );
    expect(session().toolHistory).toEqual([]);
    await handlers.onHindsightMemoryPipelineEvent(
      hindsightMemoryRecallEvent({}, { runId: "run-2" }),
    );
    expect(session().toolHistory).toHaveLength(1);
    expect(session().toolHistory[0].toolCallId).toContain("run-2");
    await flushPromises();
  });

  it("fails open when Discord rejects a status update", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: "Forbidden" }, { status: 403 }),
    );
    await expect(
      handlers.onHindsightMemoryPipelineEvent(hindsightMemoryRecallEvent()),
    ).resolves.toBeUndefined();
    await expect(
      handlers.onHindsightMemoryPipelineEvent(
        hindsightMemoryRecallEvent({
          state: "completed",
          resultCount: 1,
          durationMs: 100,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(session().toolHistory[0].status).toBe("completed");
  });
});

describe("Hindsight Memory event validation", () => {
  it("uses hindsight-memory identifiers for the parsed activity", () => {
    expect(
      parseHindsightMemoryRecallEvent(hindsightMemoryRecallEvent()),
    ).toMatchObject({
      sessionKey,
      entry: {
        toolCallId: "hindsight-memory:run-1:recall-1",
        toolName: "hindsight-memory",
        status: "pending",
      },
    });
  });

  it("accepts recall events without optional producer metadata", () => {
    expect(
      parseHindsightMemoryRecallEvent(
        hindsightMemoryRecallEvent({ pluginId: undefined }),
      ),
    ).toBeDefined();
  });

  it.each([
    hindsightMemoryRecallEvent({}, { stream: "other", runId: "run-1" }),
    hindsightMemoryRecallEvent(
      {},
      { stream: "plugin:hindsight", runId: "run-1" },
    ),
    hindsightMemoryRecallEvent(
      {},
      { stream: "hindsight-openclaw.recall", runId: "run-1" },
    ),
    hindsightMemoryRecallEvent({}, { runId: "" }),
    hindsightMemoryRecallEvent({ pluginId: "other" }),
    hindsightMemoryRecallEvent({ pluginId: "hindsight" }),
    hindsightMemoryRecallEvent({ pluginId: "hindsight-openclaw" }),
    hindsightMemoryRecallEvent({ kind: "other" }),
    hindsightMemoryRecallEvent({ kind: "hindsight.recall" }),
    hindsightMemoryRecallEvent({ recallId: "" }),
    hindsightMemoryRecallEvent({ recallId: "x\n" }),
    hindsightMemoryRecallEvent({ state: "unknown" }),
    hindsightMemoryRecallEvent({
      state: "completed",
      durationMs: -1,
      resultCount: 0,
    }),
    hindsightMemoryRecallEvent({
      state: "completed",
      durationMs: Infinity,
      resultCount: 0,
    }),
    hindsightMemoryRecallEvent({
      state: "completed",
      durationMs: 1,
      resultCount: NaN,
    }),
    hindsightMemoryRecallEvent({
      state: "completed",
      durationMs: 1,
      resultCount: -1,
    }),
    hindsightMemoryRecallEvent({
      state: "completed",
      durationMs: 1,
      resultCount: 1.5,
    }),
    hindsightMemoryRecallEvent({ state: "completed", durationMs: 1 }),
    hindsightMemoryRecallEvent({}, { sessionKey: undefined }),
  ])("ignores malformed events %j", (event) => {
    expect(parseHindsightMemoryRecallEvent(event)).toBeUndefined();
  });
});
