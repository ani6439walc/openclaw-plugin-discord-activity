import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { createOrphanManager } from "./orphans.js";
import { defaultStore } from "./session.js";
import { clearAllSessionTimers } from "./helpers.js";

// Producer: skill-harness src/review/subagent.ts and src/subagent-runtime.ts.
// Host: OpenClaw agent-tools.before-tool-call, harness/hook-helpers, and
// harness/hook-context. Tool contexts carry run/session IDs, but no trigger.
function createReviewEvents(parentSessionKey: string) {
  const runId = "skill-harness-review-mgu00000-12345678";
  const sessionKey = `${parentSessionKey}:skill-harness-review:012345abcdef`;
  const toolCallId = "functions.read:0";
  const toolContext = {
    agentId: "main",
    sessionKey,
    sessionId: runId,
    runId,
    toolName: "read",
    toolCallId,
  };
  const before = {
    toolName: "read",
    toolCallId,
    runId,
    params: {
      path: "/tmp/skill-harness-review-experiences-test/experiences/private/body.md",
    },
  };
  return {
    toolContext,
    before,
    after: { ...before, durationMs: 25 },
  };
}

describe("Skill Harness background review isolation", () => {
  const store = defaultStore;
  const parentSessionKey = "agent:main:discord:channel:123";
  const contextKey = "discord:channel:123";

  afterEach(() => {
    for (const session of store.sessions.values())
      clearAllSessionTimers(session);
    store.sessions.clear();
    store.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup(state: "active" | "finalized" | "cleared") {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "status-1" }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const orphans = createOrphanManager();
    const handlers = createHookHandlers({
      store,
      orphans,
      getToken: () => "test-token",
      config: resolveConfig({}),
    });
    await handlers.onMessageReceived(
      { messageId: "parent-message", metadata: { to: "channel:123" } },
      {
        channelId: "discord",
        sessionKey: parentSessionKey,
        runId: "parent-run",
        trigger: "user",
      },
    );
    const parent = store.sessions.get(contextKey)!;
    if (state === "finalized") parent.finalized = true;
    if (state === "cleared") store.clearSessionState(contextKey, parent);
    const review = createReviewEvents(parentSessionKey);
    async function deliverReview() {
      // The builtin detached harness emits tool hooks, but no agent_end.
      // Manual review also bypasses before_agent_reply and channel ingestion.
      let event = handlers.onBeforeToolCall(review.before, review.toolContext);
      await vi.advanceTimersByTimeAsync(100);
      await event;
      event = handlers.onAfterToolCall(review.after, review.toolContext);
      await vi.advanceTimersByTimeAsync(100);
      await event;
    }
    return { handlers, orphans, parent, review, fetchMock, deliverReview };
  }

  it.each(["active", "finalized", "cleared"] as const)(
    "keeps review events isolated when the parent is %s",
    async (state) => {
      const { parent, orphans, review, fetchMock, deliverReview } =
        await setup(state);
      const snapshot = structuredClone(parent);
      const context = structuredClone(store.contexts.get(contextKey));
      await deliverReview();
      expect(store.sessions.get(contextKey)).toBe(
        state === "cleared" ? undefined : parent,
      );
      expect(parent).toEqual(snapshot);
      expect(store.contexts.get(contextKey)).toEqual(context);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(orphans.get(review.before.toolCallId)).toBeUndefined();
    },
  );

  it("does not reconcile a review orphan into a parent tool with the same provider call ID", async () => {
    const { handlers, parent, review, fetchMock, deliverReview } =
      await setup("active");
    await deliverReview();
    await handlers.onAfterToolCall(
      {
        toolName: "read",
        toolCallId: review.before.toolCallId,
        runId: "parent-run",
        params: { path: "README.md" },
        durationMs: 10,
      },
      {
        toolName: "read",
        toolCallId: review.before.toolCallId,
        runId: "parent-run",
        sessionKey: parentSessionKey,
      },
    );
    expect(parent.toolHistory).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    // A genuine parent before/after pair still renders normally with that ID.
    const parentTool = {
      toolName: "read",
      toolCallId: review.before.toolCallId,
      runId: "parent-run",
      params: { path: "README.md" },
    };
    const parentToolContext = {
      toolName: "read",
      runId: "parent-run",
      sessionKey: parentSessionKey,
    };
    await handlers.onBeforeToolCall(parentTool, parentToolContext);
    await handlers.onAfterToolCall(
      { ...parentTool, durationMs: 10 },
      parentToolContext,
    );
    expect(parent.toolHistory).toEqual([
      expect.objectContaining({
        toolCallId: parentTool.toolCallId,
        status: "completed",
        params: { path: "README.md" },
      }),
    ]);
    expect(fetchMock).toHaveBeenCalled();
  });
});
