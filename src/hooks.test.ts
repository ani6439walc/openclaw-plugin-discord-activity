import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { createHookHandlers } from "./hooks.js";
import { createOrphanManager } from "./orphans.js";
import { resolveConfig } from "./config.js";
import { flushPromises, settleRun } from "../test-helpers.js";
import { defaultStore } from "./session.js";
import type { HookDeps } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function createDiscordFetchMock() {
  let statusCounter = 0;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/users/@me/channels") && method === "POST") {
      return jsonResponse({ id: "dm_channel_123" });
    }

    if (
      url.includes("/channels/") &&
      url.endsWith("/messages") &&
      method === "POST"
    ) {
      statusCounter += 1;
      return jsonResponse({ id: `status_${statusCounter}` });
    }

    if (
      url.includes("/channels/") &&
      url.includes("/messages/") &&
      method === "PATCH"
    ) {
      return jsonResponse({ ok: true });
    }

    if (
      url.includes("/channels/") &&
      url.includes("/messages/") &&
      method === "DELETE"
    ) {
      return emptyResponse();
    }

    return jsonResponse({ ok: true });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function countCalls(
  fetchMock: ReturnType<typeof vi.fn>,
  method: string,
  pattern: RegExp,
): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = String(input);
    const actualMethod = (init as RequestInit | undefined)?.method ?? "GET";
    return actualMethod === method && pattern.test(url);
  }).length;
}

function countChannelMessagePosts(fetchMock: ReturnType<typeof vi.fn>): number {
  return countCalls(fetchMock, "POST", /\/channels\/[^/]+\/messages$/);
}

type StatusPostBody = {
  readonly content?: string;
  readonly message_reference?: { readonly message_id: string };
};

function getStatusPostBodies(
  fetchMock: ReturnType<typeof vi.fn>,
): readonly StatusPostBody[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      return method === "POST" && /\/channels\/[^/]+\/messages$/.test(url);
    })
    .map(
      ([, init]) =>
        JSON.parse(
          String((init as RequestInit | undefined)?.body ?? "{}"),
        ) as StatusPostBody,
    );
}

function stripAnsi(content: string): string {
  return content.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

describe("createHookHandlers", () => {
  let store: typeof defaultStore;
  let orphans: ReturnType<typeof createOrphanManager>;
  let getToken: Mock<HookDeps["getToken"]>;
  let config: ReturnType<typeof resolveConfig>;
  let handlers: ReturnType<typeof createHookHandlers>;

  beforeEach(() => {
    createDiscordFetchMock();
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    store = defaultStore;
    orphans = createOrphanManager();
    getToken = vi.fn<HookDeps["getToken"]>().mockReturnValue("test-token");
    config = resolveConfig({});
    handlers = createHookHandlers({
      store,
      orphans,
      getToken,
      config,
    });
  });

  afterEach(async () => {
    await flushPromises();
    await Promise.allSettled(
      [...defaultStore.sessions.values()].map((session) => session.pendingOp),
    );
    for (const session of defaultStore.sessions.values()) {
      clearTimeout(session.clearTimer);
      clearTimeout(session.maxDisplayTimer);
    }
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("legacy internal-session isolation", () => {
    it.each([
      "message_received",
      "before_tool_call",
      "after_tool_call",
      "before_agent_reply",
      "message_sending",
      "agent_end",
      "before_compaction",
      "after_compaction",
    ] as const)(
      "ignores legacy child %s and keeps the parent usable",
      async (hook) => {
        vi.useFakeTimers();
        const fetchMock = createDiscordFetchMock();
        const contextKey = "discord:channel:123";
        const sessionKey = `agent:main:${contextKey}`;
        const parentContext = {
          channelId: "discord",
          sessionKey,
          runId: "parent-run",
        };
        await handlers.onMessageReceived(
          { messageId: "parent-message", metadata: { to: "channel:123" } },
          parentContext,
        );
        await handlers.onBeforeToolCall(
          {
            toolCallId: "parent-tool",
            toolName: "bash",
            params: { command: "pwd" },
          },
          { ...parentContext, toolName: "bash" },
        );
        await flushPromises();
        const parent = store.sessions.get(contextKey)!;
        const contextBefore = structuredClone(store.contexts.get(contextKey));
        const historyBefore = structuredClone(parent.toolHistory);
        const generationBefore = parent.generation;
        const contentBefore = parent.lastRenderedContent;
        const timerBefore = parent.maxDisplayTimer;
        fetchMock.mockClear();
        const childContext = {
          channelId: "discord",
          sessionKey: `${sessionKey}:active-memory:child`,
          runId: "child-run",
        };
        const childTool = {
          toolCallId: "child-tool",
          toolName: "memory_search",
          params: { query: "ignored" },
        };
        const events = {
          message_received: () =>
            handlers.onMessageReceived(
              { messageId: "child-message", metadata: { to: "channel:123" } },
              childContext,
            ),
          before_tool_call: () =>
            handlers.onBeforeToolCall(childTool, {
              ...childContext,
              toolName: childTool.toolName,
            }),
          after_tool_call: () =>
            handlers.onAfterToolCall(childTool, {
              ...childContext,
              toolName: childTool.toolName,
            }),
          before_agent_reply: () =>
            handlers.onBeforeAgentReply(
              { cleanedBody: "internal" },
              childContext,
            ),
          message_sending: () =>
            handlers.onMessageSending(
              { to: "channel:123", content: "internal" },
              childContext,
            ),
          agent_end: () =>
            settleRun(
              handlers,
              { success: false, error: "child failure" },
              childContext,
            ),
          before_compaction: () =>
            handlers.onBeforeCompaction({ messageCount: 10 }, childContext),
          after_compaction: () =>
            handlers.onAfterCompaction(
              { messageCount: 2, compactedCount: 8 },
              childContext,
            ),
        };
        const childEvent = events[hook]();
        await vi.advanceTimersByTimeAsync(100);
        await childEvent;
        await flushPromises();
        expect(store.sessions.get(contextKey)).toBe(parent);
        expect(store.contexts.get(contextKey)).toEqual(contextBefore);
        expect(parent.ownerSessionKey).toBe(sessionKey);
        expect(parent.runId).toBe("parent-run");
        expect(parent.generation).toBe(generationBefore);
        expect(parent.toolHistory).toEqual(historyBefore);
        expect(parent.lastRenderedContent).toBe(contentBefore);
        expect(parent.finalized).not.toBe(true);
        expect(parent.clearTimer).toBeUndefined();
        expect(parent.maxDisplayTimer).toBe(timerBefore);
        expect(orphans.get("child-tool")).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();

        await handlers.onAfterToolCall(
          {
            toolCallId: "parent-tool",
            toolName: "bash",
            params: { command: "pwd" },
            durationMs: 12,
          },
          { ...parentContext, toolName: "bash" },
        );
        expect(parent.toolHistory[0]).toMatchObject({
          toolCallId: "parent-tool",
          status: "completed",
          durationMs: 12,
        });
        expect(fetchMock).toHaveBeenCalled();
      },
    );
  });

  describe("onMessageReceived", () => {
    it("ignores non-discord contexts", async () => {
      await handlers.onMessageReceived(
        { metadata: {} },
        { channelId: "telegram" },
      );
      expect(store.contexts.size).toBe(0);
    });

    it("sets context for discord channel", async () => {
      await handlers.onMessageReceived(
        { messageId: "msg_1", metadata: { to: "channel:123456789012345678" } },
        { channelId: "discord", sessionKey: "discord:channel:123:thread:x" },
      );
      expect(store.contexts.size).toBe(1);
    });

    it("starts replacement generations with fresh display state", async () => {
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "msg_old", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      const oldSession = store.sessions.get("discord:direct:123");
      if (!oldSession) throw new Error("expected initial session");
      oldSession.statusCreateNonce = "stale_nonce";
      oldSession.confirmedDisplayState = {
        skillHarness: "collapsed",
      };
      oldSession.monotonicSafetyFloor = {
        skillHarness: "removed",
      };

      await handlers.onMessageReceived(
        { messageId: "msg_new", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId: "run_new" },
      );

      const replacement = store.sessions.get("discord:direct:123");
      expect(replacement).not.toBe(oldSession);
      expect(replacement?.generation).toBe(2);
      expect(replacement?.statusCreateNonce).toBeUndefined();
      expect(replacement?.confirmedDisplayState).toBeUndefined();
      expect(replacement?.monotonicSafetyFloor).toBeUndefined();
    });

    it("does not show skill-harness before pipeline events arrive and renders pending when started", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual([]);
      expect(countChannelMessagePosts(fetchMock)).toBe(0);

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      });

      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "skill-harness",
          toolName: "skill-harness",
          status: "pending",
        }),
      ]);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "💡 skill-harness ▾ ←",
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("renders skill-harness pipeline events for non-main agents (e.g. restricted in lobby) in an event-driven manner", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "msg_lobby_1", metadata: { to: "channel:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:restricted:discord:channel:123",
          accountId: "default",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory).toEqual([]);
      expect(countChannelMessagePosts(fetchMock)).toBe(0);

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-lobby-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:restricted:discord:channel:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      });

      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "skill-harness",
          toolName: "skill-harness",
          status: "pending",
        }),
      ]);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "💡 skill-harness ▾ ←",
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("maintains stable order between tool calls and skill-harness events", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {} },
        { sessionKey: "agent:main:discord:direct:123", toolName: "bash" },
      );
      await flushPromises();

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory.map((t) => t.toolCallId)).toEqual(["call_1"]);

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      });

      expect(session?.toolHistory.map((t) => t.toolCallId)).toEqual([
        "call_1",
        "skill-harness",
      ]);
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("bash");
      expect(plainContent).toContain("💡 skill-harness ▾ ←");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("characterizes the default hook flow with a channel reply reference", async () => {
      const fetchMock = createDiscordFetchMock();
      config = resolveConfig({});
      handlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config,
      });
      const sessionKey = "agent:main:discord:channel:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "channel:123" } },
        { channelId: "discord", sessionKey, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {} },
        { sessionKey, toolName: "bash", toolCallId: "call_1" },
      );
      await flushPromises();

      const postBodies = getStatusPostBodies(fetchMock);
      expect(postBodies).toHaveLength(1);
      expect(postBodies[0]?.message_reference).toEqual({
        message_id: "user_msg_1",
      });
    });
    it("returns before a rejected Discord status update settles", async () => {
      vi.useFakeTimers();
      let rejectUpdate: (error: Error) => void = () => {};
      const update = new Promise<Response>((_resolve, reject) => {
        rejectUpdate = reject;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(() => update),
      );
      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await expect(
        handlers.onBeforeToolCall(
          { toolCallId: "call_1", toolName: "bash", params: {} },
          {
            sessionKey: "agent:main:discord:direct:123",
            toolName: "bash",
            toolCallId: "call_1",
          },
        ),
      ).resolves.toBeUndefined();

      rejectUpdate(new Error("discord unavailable"));
      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();
      expect(
        store.sessions.get("discord:direct:123")?.toolHistory,
      ).toContainEqual(
        expect.objectContaining({ toolCallId: "call_1", status: "pending" }),
      );
    });

    it("does not stay pending while the Discord status update hangs", async () => {
      let releaseFetch!: (response: Response) => void;
      const heldFetch = new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(() => heldFetch),
      );
      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      let settled = false;
      const pending = handlers
        .onBeforeToolCall(
          { toolCallId: "call_1", toolName: "bash", params: {} },
          {
            sessionKey: "agent:main:discord:direct:123",
            toolName: "bash",
            toolCallId: "call_1",
          },
        )
        .then(() => {
          settled = true;
        });

      await flushPromises();
      expect(settled).toBe(true);
      await pending;
      releaseFetch(jsonResponse({ id: "status_1" }));
      await store.sessions.get("discord:direct:123")?.pendingOp;
    });

    it("handles steer message while session is active without retiring card or resetting tool history", async () => {
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_turn1",
        },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "call_1",
          toolName: "bash",
          params: { command: "sleep 10" },
          runId: "run_turn1",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "call_1",
          runId: "run_turn1",
        },
      );
      await flushPromises();

      const activeSession = store.sessions.get("discord:direct:123");
      expect(activeSession).toBeDefined();
      expect(activeSession?.statusMessageId).toBe("status_1");
      expect(activeSession?.toolHistory).toHaveLength(1);
      const postCountBeforeSteer = countChannelMessagePosts(fetchMock);

      await handlers.onMessageReceived(
        {
          messageId: "user_msg_2",
          content: "我想改用另一個檔案來測試...",
          metadata: { to: "user:123" },
        },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_turn2",
        },
      );

      expect(store.sessions.get("discord:direct:123")).toBe(activeSession);
      expect(activeSession?.generation).toBe(1);
      expect(countCalls(fetchMock, "DELETE", /messages/)).toBe(0);
      expect(countChannelMessagePosts(fetchMock)).toBe(postCountBeforeSteer);

      expect(activeSession?.toolHistory).toHaveLength(2);
      const steerEntry = activeSession?.toolHistory[1];
      expect(steerEntry?.toolName).toBe("steer");
      expect(steerEntry?.params).toEqual({
        steer: "我想改用另一個檔案來測試...",
      });
      expect(steerEntry?.status).toBe("completed");

      expect(activeSession?.activeRunIds?.has("run_turn1")).toBe(true);
      expect(activeSession?.activeRunIds?.has("run_turn2")).toBe(true);

      await handlers.onAfterToolCall(
        {
          toolCallId: "call_1",
          toolName: "bash",
          params: {},
          durationMs: 1000,
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "call_1",
          runId: "run_turn1",
        },
      );
      expect(activeSession?.toolHistory[0].status).toBe("completed");

      await handlers.onBeforeToolCall(
        {
          toolCallId: "call_2",
          toolName: "read",
          params: { path: "test.txt" },
          runId: "run_turn2",
        },
        {
          sessionKey,
          toolName: "read",
          toolCallId: "call_2",
          runId: "run_turn2",
        },
      );
      expect(activeSession?.toolHistory).toHaveLength(3);
      expect(activeSession?.toolHistory[2].toolName).toBe("read");

      // Verify onBeforeAgentReply deduplicates matching steer text
      await handlers.onBeforeAgentReply(
        { cleanedBody: "我想改用另一個檔案來測試..." },
        { sessionKey, runId: "run_turn2" },
      );
      // Tool history length remains 3 (no duplicate steer line added)
      expect(activeSession?.toolHistory).toHaveLength(3);

      // Verify older admitted run (run_turn1) does not finalize or cleanup shared session
      await handlers.onMessageSending(
        { to: "user:123", content: "part 1" },
        { channelId: "discord", sessionKey, runId: "run_turn1" },
      );
      expect(activeSession?.finalized).toBe(false);

      await settleRun(
        handlers,
        { success: true },
        { channelId: "discord", sessionKey, runId: "run_turn1" },
      );
      expect(activeSession?.finalized).toBe(false);

      // Current run (run_turn2) finalizes session on completion
      await handlers.onMessageSending(
        { to: "user:123", content: "part 2" },
        { channelId: "discord", sessionKey, runId: "run_turn2" },
      );
      await settleRun(
        handlers,
        { success: true },
        { channelId: "discord", sessionKey, runId: "run_turn2" },
      );
      expect(activeSession?.finalized).toBe(true);
    });

    it("keeps editing and deleting the DM status card after a steer message", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_dm";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, accountId: "default", runId },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await flushPromises();

      const activeSession = store.sessions.get("discord:direct:123");
      expect(activeSession?.statusMessageId).toBe("status_1");
      expect(activeSession?.channelId).toBe("dm_channel_123");

      // A steer in a DM arrives addressed to the user, not the DM channel.
      await handlers.onMessageReceived(
        {
          messageId: "user_msg_2",
          content: "also dispatch gate",
          metadata: { to: "user:123" },
        },
        { channelId: "discord", sessionKey, accountId: "default", runId },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_2", toolName: "read", params: {}, runId },
        { sessionKey, runId, toolName: "read", toolCallId: "call_2" },
      );
      await flushPromises();

      expect(activeSession?.channelId).toBe("dm_channel_123");
      expect(activeSession?.toolHistory.map((entry) => entry.toolName)).toEqual(
        ["bash", "steer", "read"],
      );

      await settleRun(handlers, { success: true }, { sessionKey, runId });
      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();

      expect(countCalls(fetchMock, "PATCH", /\/channels\/123\//)).toBe(0);
      expect(countCalls(fetchMock, "DELETE", /\/channels\/123\//)).toBe(0);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBeGreaterThan(0);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("keeps the DM channel when a steer arrives while the status card POST is in flight", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_dm_race";
      let releasePost: (() => void) | undefined;
      let postStarted = false;
      const fetchMock = vi.fn(
        async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url.includes("/users/@me/channels") && method === "POST") {
            return jsonResponse({ id: "dm_channel_123" });
          }
          if (url.endsWith("/messages") && method === "POST") {
            postStarted = true;
            await new Promise<void>((resolve) => {
              releasePost = resolve;
            });
            return jsonResponse({ id: "status_1" });
          }
          if (method === "DELETE") return emptyResponse();
          return jsonResponse({ ok: true });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, accountId: "default", runId },
      );
      const firstTool = handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      for (let i = 0; i < 20 && !postStarted; i++) await flushPromises();
      expect(postStarted).toBe(true);

      // The steer lands while the create POST to the DM channel is still pending.
      // Its status refresh queues behind the pending create, so do not await it yet.
      const steer = handlers.onMessageReceived(
        {
          messageId: "user_msg_2",
          content: "also dispatch gate",
          metadata: { to: "user:123" },
        },
        { channelId: "discord", sessionKey, accountId: "default", runId },
      );
      releasePost!();
      await Promise.all([firstTool, steer]);
      await flushPromises();

      const activeSession = store.sessions.get("discord:direct:123");
      expect(activeSession?.statusMessageId).toBe("status_1");
      expect(activeSession?.channelId).toBe("dm_channel_123");

      await handlers.onBeforeToolCall(
        { toolCallId: "call_2", toolName: "read", params: {}, runId },
        { sessionKey, runId, toolName: "read", toolCallId: "call_2" },
      );
      await settleRun(handlers, { success: true }, { sessionKey, runId });
      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();

      expect(countCalls(fetchMock, "PATCH", /\/channels\/123\//)).toBe(0);
      expect(countCalls(fetchMock, "DELETE", /\/channels\/123\//)).toBe(0);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBeGreaterThan(0);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("preserves active card on media-only inbound messages (image attachment steer) during an ongoing run", async () => {
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId: "run_1" },
        { sessionKey, toolName: "bash", toolCallId: "call_1", runId: "run_1" },
      );
      await flushPromises();

      const activeSession = store.sessions.get("discord:direct:123");
      expect(activeSession?.statusMessageId).toBe("status_1");
      const postCountBefore = countChannelMessagePosts(fetchMock);

      // Inbound event with media attachments but no body text (e.g. image upload)
      await handlers.onMessageReceived(
        {
          messageId: "user_msg_2",
          metadata: {
            to: "user:123",
            attachments: [{ id: "att_1", url: "https://discord.gg/image.png" }],
          },
        },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_2",
        },
      );

      // Card is preserved without being deleted or replaced
      expect(store.sessions.get("discord:direct:123")).toBe(activeSession);
      expect(activeSession?.generation).toBe(1);
      expect(countCalls(fetchMock, "DELETE", /messages/)).toBe(0);
      expect(countChannelMessagePosts(fetchMock)).toBe(postCountBefore);
      expect(activeSession?.activeRunIds?.has("run_2")).toBe(true);

      // Steer tool entry was pushed with [image]
      expect(activeSession?.toolHistory).toHaveLength(2);
      expect(activeSession?.toolHistory[1]).toMatchObject({
        toolName: "steer",
        params: { steer: "[image]" },
      });

      // Verify onBeforeAgentReply adopts run_2 and does not duplicate steer row even if reply text differs
      await handlers.onBeforeAgentReply(
        { cleanedBody: "看看這張" },
        { sessionKey, runId: "run_2" },
      );
      expect(activeSession?.runId).toBe("run_2");
      expect(activeSession?.toolHistory).toHaveLength(2);
      expect(activeSession?.toolHistory[1].params?.steer).toBe("[image]");
    });

    it("preserves active card on body-less inbound messages for already-admitted run", async () => {
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId: "run_1" },
        { sessionKey, toolName: "bash", toolCallId: "call_1", runId: "run_1" },
      );
      await flushPromises();

      const activeSession = store.sessions.get("discord:direct:123");
      expect(activeSession?.statusMessageId).toBe("status_1");

      // Follow-up body-less event for the SAME admitted run
      await handlers.onMessageReceived(
        { messageId: "user_msg_2", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_1",
        },
      );

      // Card is preserved without replacing generation
      expect(store.sessions.get("discord:direct:123")).toBe(activeSession);
      expect(activeSession?.generation).toBe(1);
      expect(activeSession?.toolHistory).toHaveLength(1);
    });

    it("replaces generation on body-less inbound event with new unadmitted runId", async () => {
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId: "run_1" },
        { sessionKey, toolName: "bash", toolCallId: "call_1", runId: "run_1" },
      );
      await flushPromises();

      const activeSession = store.sessions.get("discord:direct:123");
      expect(activeSession?.generation).toBe(1);

      // Body-less event with new unadmitted runId replaces generation
      await handlers.onMessageReceived(
        { messageId: "user_msg_2", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_2",
        },
      );

      const replacement = store.sessions.get("discord:direct:123");
      expect(replacement).not.toBe(activeSession);
      expect(replacement?.generation).toBe(2);
      expect(replacement?.runId).toBe("run_2");
    });

    it("replaces generation on owner switch even when inbound message carries text", async () => {
      const sessionKey = "agent:main:discord:direct:123";
      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_1",
        },
      );

      const firstSession = store.sessions.get("discord:direct:123");
      expect(firstSession?.generation).toBe(1);

      // Message from different owner arrives with text
      const otherOwnerSessionKey = "agent:other:discord:direct:123";
      await handlers.onMessageReceived(
        {
          messageId: "user_msg_2",
          content: "new owner text",
          metadata: { to: "user:123" },
        },
        {
          channelId: "discord",
          sessionKey: otherOwnerSessionKey,
          accountId: "default",
          runId: "run_2",
        },
      );

      const replacement = store.sessions.get("discord:direct:123");
      expect(replacement).not.toBe(firstSession);
      expect(replacement?.generation).toBe(2);
      expect(replacement?.ownerSessionKey).toBe(otherOwnerSessionKey);
    });

    it.each([
      {
        replyMode: "all",
        sessionKey: "agent:main:discord:channel:123",
        expectedReference: { message_id: "user_msg_1" },
      },
      {
        replyMode: "direct",
        sessionKey: "agent:main:discord:direct:123",
        expectedReference: { message_id: "user_msg_1" },
      },
      {
        replyMode: "direct",
        sessionKey: "agent:main:discord:channel:123",
        expectedReference: undefined,
      },
      {
        replyMode: "direct",
        sessionKey: "agent:main:discord:group:123",
        expectedReference: undefined,
      },
    ] as const)(
      "uses resolveConfig replyMode in the handler status POST for $sessionKey",
      async ({ replyMode, sessionKey, expectedReference }) => {
        const fetchMock = createDiscordFetchMock();
        config = resolveConfig({ replyMode });
        handlers = createHookHandlers({
          store,
          orphans,
          getToken,
          config,
        });

        await handlers.onMessageReceived(
          { messageId: "user_msg_1", metadata: { to: "channel:123" } },
          { channelId: "discord", sessionKey, accountId: "default" },
        );
        await handlers.onBeforeToolCall(
          { toolCallId: "call_1", toolName: "bash", params: {} },
          { sessionKey, toolName: "bash", toolCallId: "call_1" },
        );
        await handlers.onAfterToolCall(
          {
            toolCallId: "call_1",
            toolName: "bash",
            params: {},
            durationMs: 10,
          },
          { sessionKey, toolName: "bash", toolCallId: "call_1" },
        );

        const postBodies = getStatusPostBodies(fetchMock);
        expect(postBodies).toHaveLength(1);
        expect(postBodies[0]?.message_reference).toEqual(expectedReference);
      },
    );
  });

  describe("stale-run isolation", () => {
    async function createReplacementForNewRun() {
      createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_old", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_old",
        },
      );
      await handlers.onMessageReceived(
        { messageId: "user_new", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_new",
        },
      );

      const replacement = store.sessions.get("discord:direct:123");
      expect(replacement?.runId).toBe("run_new");
      expect(replacement?.supersededRunIds).toContain("run_old");
      return { replacement, sessionKey };
    }

    it("rejects a late before_tool_call from a superseded run", async () => {
      const { replacement, sessionKey } = await createReplacementForNewRun();

      await handlers.onBeforeToolCall(
        {
          toolCallId: "late_call",
          toolName: "bash",
          params: { command: "old" },
          runId: "run_old",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "late_call",
          runId: "run_old",
        },
      );

      expect(replacement?.toolHistory).toEqual([]);
    });

    it("rejects inconsistent event and context run ids", async () => {
      const { replacement, sessionKey } = await createReplacementForNewRun();

      await handlers.onBeforeToolCall(
        {
          toolCallId: "inconsistent_call",
          toolName: "bash",
          params: { command: "old context" },
          runId: "run_new",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "inconsistent_call",
          runId: "run_old",
        },
      );

      expect(replacement?.toolHistory).toEqual([]);
    });

    it("rejects a late after_tool_call from a superseded run", async () => {
      const { replacement, sessionKey } = await createReplacementForNewRun();
      await handlers.onBeforeToolCall(
        {
          toolCallId: "shared_call",
          toolName: "bash",
          params: { command: "new" },
          runId: "run_new",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "shared_call",
          runId: "run_new",
        },
      );

      await handlers.onAfterToolCall(
        {
          toolCallId: "shared_call",
          toolName: "bash",
          params: { command: "old" },
          durationMs: 99,
          runId: "run_old",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "shared_call",
          runId: "run_old",
        },
      );

      expect(replacement?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "shared_call",
          status: "pending",
          params: { command: "new" },
        }),
      ]);
    });

    it("rejects a late skill-harness pipeline event from a superseded run", async () => {
      const { replacement, sessionKey } = await createReplacementForNewRun();

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run_old",
        stream: "plugin:skill-harness",
        sessionKey,
        data: {
          kind: "skill-harness.pipeline",
          phase: "intent-classification",
          state: "completed",
          intent: "old-intent",
        },
      });

      expect(replacement?.toolHistory).toEqual([]);
    });
  });

  describe("queued successor admission", () => {
    it("binds an admitted run to the unbound inbound generation in place", async () => {
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, accountId: "default" },
      );

      const inboundSession = store.sessions.get("discord:direct:123");
      const postCountBeforeAdmission = countChannelMessagePosts(fetchMock);
      const result = await handlers.onBeforeAgentReply(
        { cleanedBody: "first admitted run" },
        { sessionKey, runId: "run_new" },
      );

      expect(result).toEqual({ handled: false });
      expect(store.sessions.get("discord:direct:123")).toBe(inboundSession);
      expect(inboundSession?.generation).toBe(1);
      expect(inboundSession?.runId).toBe("run_new");
      expect(countChannelMessagePosts(fetchMock)).toBe(
        postCountBeforeAdmission,
      );
    });

    it("starts a queued successor generation from before_agent_reply before skill-harness activity", async () => {
      const fetchMock = createDiscordFetchMock();
      config = resolveConfig({ replyMode: "direct" });
      handlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config,
      });
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_old",
        },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "old_call",
          toolName: "bash",
          params: { command: "pwd" },
          runId: "run_old",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "old_call",
          runId: "run_old",
        },
      );
      const oldSession = store.sessions.get("discord:direct:123");
      expect(oldSession?.toolHistory).toContainEqual(
        expect.objectContaining({ toolCallId: "old_call", status: "pending" }),
      );

      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      await settleRun(
        handlers,
        { success: true },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      expect(oldSession?.finalized).toBe(true);

      await handlers.onBeforeAgentReply(
        { cleanedBody: "queued followup" },
        { sessionKey, runId: "run_new" },
      );

      const queuedSession = store.sessions.get("discord:direct:123");
      expect(queuedSession).not.toBe(oldSession);
      expect(queuedSession?.generation).toBe(2);
      expect(queuedSession?.runId).toBe("run_new");
      expect(queuedSession?.supersededRunIds).toContain("run_old");
      expect(queuedSession?.finalized).toBeFalsy();
      expect(queuedSession?.toolHistory).toEqual([]);
      expect(getStatusPostBodies(fetchMock)).toEqual([
        expect.objectContaining({
          message_reference: { message_id: "user_msg_1" },
        }),
      ]);

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run_new",
        stream: "plugin:skill-harness",
        sessionKey,
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "completed",
          result: ["queued-followup"],
        },
      });

      expect(queuedSession?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: "skill-harness",
          status: "completed",
          params: { result: "1 skill selected: queued-followup" },
        }),
      );
      expect(stripAnsi(queuedSession?.lastRenderedContent ?? "")).toContain(
        "1 skill selected: queued-followup",
      );
    });

    it("guards queued successor takeover and fences late run events", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_old",
        },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "old_call",
          toolName: "bash",
          params: { command: "pwd" },
          runId: "run_old",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "old_call",
          runId: "run_old",
        },
      );
      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      await settleRun(
        handlers,
        { success: true },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      await handlers.onBeforeAgentReply(
        { cleanedBody: "queued followup" },
        { sessionKey, runId: "run_new" },
      );

      const queuedSession = store.sessions.get("discord:direct:123");
      expect(queuedSession?.generation).toBe(2);
      const postCountAfterAdmission = countChannelMessagePosts(fetchMock);
      const historyAfterAdmission = [...(queuedSession?.toolHistory ?? [])];

      await handlers.onBeforeAgentReply(
        { cleanedBody: "duplicate queued followup" },
        { sessionKey, runId: "run_new" },
      );
      expect(store.sessions.get("discord:direct:123")).toBe(queuedSession);
      expect(queuedSession?.generation).toBe(2);
      expect(queuedSession?.toolHistory).toEqual(historyAfterAdmission);
      expect(countChannelMessagePosts(fetchMock)).toBe(postCountAfterAdmission);

      await handlers.onBeforeAgentReply(
        { cleanedBody: "active run takeover" },
        { sessionKey, runId: "run_hijack" },
      );
      expect(store.sessions.get("discord:direct:123")).toBe(queuedSession);
      expect(queuedSession?.runId).toBe("run_new");
      expect(queuedSession?.generation).toBe(2);
      expect(queuedSession?.toolHistory).toEqual(historyAfterAdmission);
      expect(countChannelMessagePosts(fetchMock)).toBe(postCountAfterAdmission);

      const mismatchedTakeover = handlers.onBeforeAgentReply(
        { cleanedBody: "wrong owner" },
        { sessionKey: "agent:other:discord:direct:123", runId: "run_hijack" },
      );
      await vi.advanceTimersByTimeAsync(500);
      await mismatchedTakeover;
      await handlers.onBeforeAgentReply(
        { cleanedBody: "old run" },
        { sessionKey, runId: "run_old" },
      );
      await handlers.onBeforeAgentReply(
        { cleanedBody: "child run" },
        { sessionKey: `${sessionKey}:subagent:child`, runId: "run_child" },
      );
      expect(store.sessions.get("discord:direct:123")).toBe(queuedSession);
      expect(queuedSession?.runId).toBe("run_new");
      expect(queuedSession?.generation).toBe(2);
      expect(queuedSession?.toolHistory).toEqual(historyAfterAdmission);
      expect(countChannelMessagePosts(fetchMock)).toBe(postCountAfterAdmission);

      const patchCountBeforeLateEvents = countCalls(
        fetchMock,
        "PATCH",
        /\/channels\/dm_channel_123\/messages\/status_2$/,
      );
      await handlers.onSkillHarnessPipelineEvent({
        runId: "run_old",
        stream: "plugin:skill-harness",
        sessionKey,
        data: {
          kind: "skill-harness.pipeline",
          phase: "intent-classification",
          state: "completed",
          intent: "late-old-run",
        },
      });
      await handlers.onBeforeToolCall(
        {
          toolCallId: "late_old_call",
          toolName: "bash",
          params: { command: "old" },
          runId: "run_old",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "late_old_call",
          runId: "run_old",
        },
      );
      await settleRun(
        handlers,
        { messages: [], success: true },
        { sessionKey, runId: "run_old" },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromises();

      expect(store.sessions.get("discord:direct:123")).toBe(queuedSession);
      expect(queuedSession?.finalized).toBeFalsy();
      expect(queuedSession?.clearTimer).toBeUndefined();
      expect(queuedSession?.toolHistory).toEqual(historyAfterAdmission);
      expect(countChannelMessagePosts(fetchMock)).toBe(postCountAfterAdmission);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_2$/,
        ),
      ).toBe(patchCountBeforeLateEvents);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_2$/,
        ),
      ).toBe(0);
    });

    it("fails open when queued status initialization cannot resolve a token", async () => {
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_old",
        },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "old_call",
          toolName: "bash",
          params: { command: "pwd" },
          runId: "run_old",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "old_call",
          runId: "run_old",
        },
      );
      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      await settleRun(
        handlers,
        { success: true },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );

      getToken.mockImplementation(() => {
        throw new Error("token resolution failed");
      });
      const result = await handlers.onBeforeAgentReply(
        { cleanedBody: "queued followup" },
        { sessionKey, runId: "run_new" },
      );

      const queuedSession = store.sessions.get("discord:direct:123");
      expect(result).toEqual({ handled: false });
      expect(queuedSession?.generation).toBe(2);
      expect(queuedSession?.runId).toBe("run_new");
      expect(queuedSession?.finalized).toBe(false);
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });
  });

  describe("onBeforeToolCall", () => {
    it("adds orphan when no session", async () => {
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "mcp", params: {} },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "mcp",
          toolCallId: "call_1",
        },
      );
      expect(orphans.get("call_1")).toBeDefined();
    });

    it("adds tool to session when available", async () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: { command: "ls" } },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );
      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory.length).toBe(1);
      expect(session?.toolHistory[0].toolName).toBe("bash");
    });

    it("pins progress_card content above the live tool status and replaces prior cards", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        accountId: "default",
      });

      await handlers.onBeforeToolCall(
        {
          toolCallId: "progress_1",
          toolName: "progress_card",
          params: { markdown: "First note" },
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "progress_card",
          toolCallId: "progress_1",
        },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "bash_1",
          toolName: "bash",
          params: { command: "pnpm test" },
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "bash_1",
        },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "progress_2",
          toolName: "openclawprogress_card",
          params: {
            markdown: "Verification is running.",
            plan: [
              { step: "Implement renderer", status: "completed" },
              { step: "Verify live output", status: "in_progress" },
            ],
          },
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "openclawprogress_card",
          toolCallId: "progress_2",
        },
      );
      await flushPromises();

      const content = stripAnsi(
        store.sessions.get("discord:channel:123")?.lastRenderedContent ?? "",
      );
      expect(content).toContain("📋 progress · 1/2");
      expect(content).toContain("Verification is running.");
      expect(content).toContain("✓ Implement renderer");
      expect(content).toContain("→ Verify live output");
      expect(content).not.toContain("First note");
      expect(content.indexOf("📋 progress")).toBeLessThan(
        content.indexOf("bash"),
      );
    });

    it("trims tool history using configured maxToolHistoryLength", async () => {
      getToken.mockReturnValue("");
      config = resolveConfig({ maxToolHistoryLength: 2 });
      handlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config,
      });
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });

      for (const toolCallId of ["call_1", "call_2", "call_3"]) {
        await handlers.onBeforeToolCall(
          { toolCallId, toolName: "bash", params: {} },
          {
            sessionKey: "discord:channel:123:thread:x",
            toolName: "bash",
            toolCallId,
          },
        );
      }

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory.map((t) => t.toolCallId)).toEqual([
        "call_2",
        "call_3",
      ]);
    });

    it("dedupes repeated Codex/OpenClaw tool events with the same tool call id", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        accountId: "default",
      });
      const params = {
        corpus: "all",
        maxResults: 5,
        query: "高鐵 座位 偏好 靠窗",
      };

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "openclawmemory_search", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "openclawmemory_search",
          toolCallId: "call_1",
        },
      );
      await handlers.onAfterToolCall(
        {
          toolCallId: "call_1",
          toolName: "openclawmemory_search",
          params,
          durationMs: 2259,
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "openclawmemory_search",
          toolCallId: "call_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "memory_search", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "memory_search",
          toolCallId: "call_1",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "call_1",
          toolName: "memory_search",
          status: "completed",
          durationMs: 2259,
        }),
      ]);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "memory_search ▾ ✔",
      );
      expect(session?.lastRenderedContent).not.toContain(
        "openclawmemory_search",
      );
    });

    it("renders Codex/OpenClaw prefixed tool names with the canonical display name immediately", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        accountId: "default",
      });

      await handlers.onBeforeToolCall(
        {
          toolCallId: "call_1",
          toolName: "openclawskill_view",
          params: { name: "openclaw" },
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "openclawskill_view",
          toolCallId: "call_1",
        },
      );
      await flushPromises();

      const session = store.sessions.get("discord:channel:123");
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "skill_view ▾ ←",
      );
      expect(session?.lastRenderedContent).not.toContain("openclawskill_view");
    });

    it("dedupes Codex/OpenClaw tool events with different ids but matching canonical tool and params", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        accountId: "default",
      });
      const params = {
        corpus: "all",
        maxResults: 5,
        query: "高鐵 座位 偏好 靠窗",
      };

      await handlers.onBeforeToolCall(
        {
          toolCallId: "native_call_1",
          toolName: "openclawmemory_search",
          params,
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "openclawmemory_search",
          toolCallId: "native_call_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "dynamic_call_1", toolName: "memory_search", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "memory_search",
          toolCallId: "dynamic_call_1",
        },
      );
      await handlers.onAfterToolCall(
        {
          toolCallId: "dynamic_call_1",
          toolName: "memory_search",
          params,
          durationMs: 2259,
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "memory_search",
          toolCallId: "dynamic_call_1",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "dynamic_call_1",
          toolName: "memory_search",
          status: "completed",
          durationMs: 2259,
        }),
      ]);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "memory_search ▾ ✔",
      );
      expect(session?.lastRenderedContent).not.toContain(
        "openclawmemory_search",
      );
    });

    it("keeps duplicate non-OpenClaw tool events with matching params as separate entries", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        accountId: "default",
      });
      const params = { command: "pwd" };

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_2", toolName: "bash", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "call_2",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "call_1",
          toolName: "bash",
          status: "pending",
        }),
        expect.objectContaining({
          toolCallId: "call_2",
          toolName: "bash",
          status: "pending",
        }),
      ]);
    });
  });

  describe("onAfterToolCall", () => {
    it.each(["decision_evaluate", "openclawdecision_evaluate"])(
      "retains the result of %s without collecting ordinary tool output",
      async (toolName) => {
        createDiscordFetchMock();
        store.contexts.set("discord:channel:123", { actualChannelId: "123" });
        const params = {
          state: { message: "Hello" },
          questions: { reply: { type: "boolean", instructions: "Reply?" } },
        };
        const ctx = { sessionKey: "discord:channel:123:thread:x", toolName };
        const result = {
          details: {
            status: "ok",
            result: {
              model: "test-model",
              answers: { reply: { type: "boolean", probabilityTrue: 0.82 } },
            },
          },
        };
        await handlers.onBeforeToolCall(
          { toolCallId: "decision-1", toolName, params },
          ctx,
        );
        const completion = {
          toolCallId: "decision-1",
          toolName,
          params,
          result,
          durationMs: 952,
        };
        await handlers.onAfterToolCall(completion, ctx);
        const history = store.sessions.get("discord:channel:123")!.toolHistory;
        expect(history[0]).toHaveProperty("result", result);
        const rendered =
          store.sessions.get("discord:channel:123")!.lastRenderedContent ?? "";
        expect(stripAnsi(rendered)).toContain("⚖️");
        expect(stripAnsi(rendered)).toContain("Reply?");
        expect(stripAnsi(rendered)).toContain("82.0%");
        expect(stripAnsi(rendered)).toContain("18.0%");
        expect(rendered).not.toContain('"message":"Hello"');

        // Duplicate completion and late start events must not erase the result.
        await handlers.onAfterToolCall(
          { toolCallId: "decision-1", toolName, params },
          ctx,
        );
        await handlers.onBeforeToolCall(
          { toolCallId: "decision-1", toolName, params },
          ctx,
        );
        expect(history).toHaveLength(1);
        expect(history[0]).toHaveProperty("result", result);
        expect(history[0].status).toBe("completed");

        const ordinaryCtx = { ...ctx, toolName: "exec" };
        await handlers.onBeforeToolCall(
          { toolCallId: "ordinary-1", toolName: "exec", params: {} },
          ordinaryCtx,
        );
        const ordinaryCompletion = {
          toolCallId: "ordinary-1",
          toolName: "exec",
          params: {},
          result: { text: "unrelated output" },
        };
        await handlers.onAfterToolCall(ordinaryCompletion, ordinaryCtx);
        expect(history[1]).not.toHaveProperty("result");
      },
    );

    it("retains decision results when reconciling an orphan and clears them on a tool error", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const toolName = "decision_evaluate";
      const params = { state: null, questions: { reply: { type: "boolean" } } };
      const ctx = { sessionKey: "discord:channel:123:thread:x", toolName };
      orphans.add({
        toolCallId: "decision-1",
        toolName,
        params,
        createdAt: Date.now(),
      });
      const result = { status: "unavailable", reason: "deadline" };
      const completion = { toolCallId: "decision-1", toolName, params, result };
      await handlers.onAfterToolCall(completion, ctx);
      const entry = store.sessions.get("discord:channel:123")!.toolHistory[0];
      expect(entry.status).toBe("orphan-completed");
      expect(entry).toHaveProperty("result", result);
      await handlers.onAfterToolCall(
        {
          toolCallId: "decision-1",
          toolName,
          params,
          error: "transport failed",
        },
        ctx,
      );
      expect(entry.status).toBe("error");
      expect(entry).toHaveProperty("result", undefined);
    });

    it("reconciles orphan tool entry", async () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      orphans.add({
        toolCallId: "call_1",
        toolName: "mcp",
        params: {},
        createdAt: Date.now(),
      });
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "mcp", params: {}, durationMs: 100 },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "mcp",
          toolCallId: "call_1",
        },
      );
      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory[0].status).toBe("orphan-completed");
    });

    it("marks tool as completed", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {} },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, durationMs: 100 },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );
      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory[0].status).toBe("completed");
    });

    it("preserves completed tool duration when a duplicate completion omits duration", async () => {
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const params = { command: "openclaw skills list" };

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "exec", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_1",
        },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "exec", params, durationMs: 538 },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_1",
        },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "exec", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_2", toolName: "exec", params: { command: "pwd" } },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_2",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory[0]).toEqual(
        expect.objectContaining({
          toolCallId: "call_1",
          status: "completed",
          durationMs: 538,
        }),
      );
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🚀 exec ▾ ✔ [538ms]",
      );
    });

    it("falls back to elapsed time when a completion omits duration and preserves it across duplicates", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      createDiscordFetchMock();
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const params = { command: "command -v codex" };

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "exec", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_1",
        },
      );

      vi.setSystemTime(2500);
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "exec", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_1",
        },
      );

      vi.setSystemTime(5000);
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "exec", params },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_1",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_2", toolName: "exec", params: { command: "pwd" } },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_2",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory[0]).toEqual(
        expect.objectContaining({
          toolCallId: "call_1",
          status: "completed",
          startedAtMs: 1000,
          durationMs: 1500,
        }),
      );
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🚀 exec ▾ ✔ [1.5s]",
      );
    });

    it("falls back to the first orphan observation after duplicate before calls", async () => {
      const nowSpy = vi.spyOn(Date, "now");
      createDiscordFetchMock();
      const firstParams = { command: "command -v mise" };
      const latestParams = { command: "command -v codex" };

      nowSpy.mockReturnValue(2000);
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "exec", params: firstParams },
        { toolName: "exec", toolCallId: "call_1" },
      );
      nowSpy.mockReturnValue(2100);
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "exec", params: latestParams },
        { toolName: "exec", toolCallId: "call_1" },
      );

      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      nowSpy.mockReturnValue(2250);
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "exec", params: latestParams },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "exec",
          toolCallId: "call_1",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory[0]).toEqual(
        expect.objectContaining({
          toolCallId: "call_1",
          status: "orphan-completed",
          startedAtMs: 2000,
          durationMs: 250,
          params: latestParams,
        }),
      );
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🚀 exec ▾ ♻︎ [250ms]",
      );
    });

    it("stores and renders normal tool error details", async () => {
      const fetchMock = createDiscordFetchMock();
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        accountId: "default",
      });

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: { command: "ls" } },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );

      await handlers.onAfterToolCall(
        {
          toolCallId: "call_1",
          toolName: "bash",
          params: { command: "ls" },
          error: "permission denied",
          durationMs: 100,
        },
        {
          sessionKey: "discord:channel:123:thread:x",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );

      const session = store.sessions.get("discord:channel:123");
      expect(session?.toolHistory[0]).toEqual(
        expect.objectContaining({
          status: "error",
          error: "permission denied",
        }),
      );
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("bash ▾ ✘ [100ms]");
      expect(plainContent).toContain("permission denied");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });
  });

  describe("onAgentEnd", () => {
    it("skips subagent sessions", async () => {
      const consoleSpy = vi
        .spyOn(console, "trace")
        .mockImplementation(() => {});
      await settleRun(
        handlers,
        { messages: [] },
        { sessionKey: "discord:channel:123:subagent:abc" },
      );
      consoleSpy.mockRestore();
    });

    it("preserves a pending pipeline status during compaction before any tool runs", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_pipeline_compact";
      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId },
      );
      await handlers.onSkillHarnessPipelineEvent({
        runId,
        sessionKey,
        stream: "plugin:skill-harness",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      });
      await handlers.onBeforeCompaction(
        { messageCount: 42 },
        { sessionKey, runId },
      );
      const session = store.sessions.get("discord:direct:123");
      expect(session?.compactionActive).toBe(true);
      expect(session?.maxDisplayTimer).toBeUndefined();
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🗜️ compaction ▾ ←",
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      await handlers.onAfterCompaction(
        { messageCount: 10, compactedCount: 32 },
        { sessionKey, runId },
      );
      expect(session?.compactionActive).toBe(false);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🗜️ compaction ▾ ✔",
      );
    });

    it("preserves an active status across an attempt-level agent_end and compaction", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_compact";
      config = resolveConfig({ maxDisplaySeconds: 2 });
      handlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config,
      });

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          runId,
          accountId: "default",
        },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );

      const attemptEnd = handlers.onAgentEnd(
        { success: false, error: "Context overflow" },
        { sessionKey, runId },
      );
      await handlers.onBeforeCompaction(
        { messageCount: 42 },
        { sessionKey, runId },
      );
      await attemptEnd;

      expect(
        stripAnsi(
          store.sessions.get("discord:direct:123")?.lastRenderedContent ?? "",
        ),
      ).toContain("🗜️ compaction ▾ ←");

      await vi.advanceTimersByTimeAsync(2500);
      await flushPromises();

      const activeSession = store.sessions.get("discord:direct:123");
      expect(activeSession?.finalized).toBe(false);
      expect(
        activeSession?.toolHistory.some(
          (entry) => entry.toolCallId === "agent",
        ),
      ).toBe(false);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(0);

      await handlers.onAfterCompaction(
        { messageCount: 8, compactedCount: 34 },
        { sessionKey, runId },
      );
      expect(
        stripAnsi(
          store.sessions.get("discord:direct:123")?.lastRenderedContent ?? "",
        ),
      ).toContain("🗜️ compaction ▾ ✔ [2.5s]");
      await settleRun(handlers, { success: true }, { sessionKey, runId });
      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();

      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
    });

    it("allows terminal cleanup when compaction fails without an after hook", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_failed_compact";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await handlers.onBeforeCompaction(
        { messageCount: 42 },
        { sessionKey, runId },
      );
      await settleRun(
        handlers,
        { success: false, error: "Compaction failed" },
        { sessionKey, runId },
      );

      expect(
        stripAnsi(
          store.sessions.get("discord:direct:123")?.lastRenderedContent ?? "",
        ),
      ).toContain("🗜️ compaction ▾ ✘");

      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();

      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
    });

    it("defers finalization on context overflow agent_end when before_compaction arrives seconds later", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_overflow_delayed_compact";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", durationMs: 120, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );

      await handlers.onAgentEnd(
        {
          success: false,
          error:
            "Context overflow: prompt too large for the model. Try again with less input or a larger-context model.",
        },
        { sessionKey, runId },
      );

      // Simulate 8s session snapshot loading delay before before_compaction fires
      await vi.advanceTimersByTimeAsync(8_000);
      await flushPromises();

      const pendingSession = store.sessions.get("discord:direct:123");
      expect(pendingSession?.finalized).toBe(false);
      expect(pendingSession?.overflowRecoveryPending).toBe(true);
      expect(
        pendingSession?.toolHistory.some(
          (entry) => entry.toolCallId === "agent",
        ),
      ).toBe(false);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(0);

      await handlers.onBeforeCompaction(
        { messageCount: 150 },
        { sessionKey, runId },
      );
      expect(pendingSession?.overflowRecoveryPending).toBe(false);
      expect(pendingSession?.compactionActive).toBe(true);
      expect(pendingSession?.clearTimer).toBeUndefined();
      expect(stripAnsi(pendingSession?.lastRenderedContent ?? "")).toContain(
        "🗜️ compaction ▾ ←",
      );

      await vi.advanceTimersByTimeAsync(3_000);
      await handlers.onAfterCompaction(
        { messageCount: 25, compactedCount: 125 },
        { sessionKey, runId },
      );
      expect(stripAnsi(pendingSession?.lastRenderedContent ?? "")).toContain(
        "🗜️ compaction ▾ ✔ [3s]",
      );

      // Post-compaction retry attempt runs another tool and succeeds
      await handlers.onBeforeToolCall(
        { toolCallId: "call_2", toolName: "read", params: {}, runId },
        { sessionKey, runId, toolName: "read", toolCallId: "call_2" },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_2", toolName: "read", durationMs: 50, runId },
        { sessionKey, runId, toolName: "read", toolCallId: "call_2" },
      );
      await settleRun(handlers, { success: true }, { sessionKey, runId });

      await vi.advanceTimersByTimeAsync(1_500);
      await flushPromises();

      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
    });

    it("retains overflow progress past the old grace deadline until execution settles", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_overflow_unrecovered";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", durationMs: 80, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );

      await handlers.onAgentEnd(
        {
          success: false,
          error: "Request size exceeds model context window",
        },
        { sessionKey, runId },
      );

      await vi.advanceTimersByTimeAsync(29_000);
      await flushPromises();
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(0);

      const patchBodiesBeforeTimeout = fetchMock.mock.calls
        .filter(([input, init]) => {
          const url = String(input);
          const method = (init as RequestInit | undefined)?.method ?? "GET";
          return (
            method === "PATCH" &&
            /\/channels\/dm_channel_123\/messages\/status_1$/.test(url)
          );
        })
        .map(([, init]) =>
          stripAnsi(
            (
              JSON.parse(
                String((init as RequestInit | undefined)?.body ?? "{}"),
              ) as StatusPostBody
            ).content ?? "",
          ),
        );
      expect(
        patchBodiesBeforeTimeout.some((body) => body.includes("💥 agent")),
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await flushPromises();

      expect(store.sessions.get("discord:direct:123")?.finalized).toBe(false);
      expect(countCalls(fetchMock, "DELETE", /messages/)).toBe(0);
      await settleRun(
        handlers,
        {
          success: false,
          error: "Request size exceeds model context window",
        },
        { sessionKey, runId },
      );
      await vi.advanceTimersByTimeAsync(1500);
      const patchBodiesAfterTimeout = fetchMock.mock.calls
        .filter(([input, init]) => {
          const url = String(input);
          const method = (init as RequestInit | undefined)?.method ?? "GET";
          return (
            method === "PATCH" &&
            /\/channels\/dm_channel_123\/messages\/status_1$/.test(url)
          );
        })
        .map(([, init]) =>
          stripAnsi(
            (
              JSON.parse(
                String((init as RequestInit | undefined)?.body ?? "{}"),
              ) as StatusPostBody
            ).content ?? "",
          ),
        );
      expect(patchBodiesAfterTimeout.at(-1)).toContain("💥 agent");
      expect(patchBodiesAfterTimeout.at(-1)).toContain(
        "Request size exceeds model context window",
      );
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
    });

    it("renders overflow failure only on settled error after an intermediate reply", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_overflow_message_sending_fallback";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", durationMs: 50, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );

      await handlers.onAgentEnd(
        {
          success: false,
          error: "Context overflow: prompt too large for the model.",
        },
        { sessionKey, runId },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.overflowRecoveryPending).toBe(true);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).not.toContain(
        "💥 agent",
      );

      await handlers.onMessageSending(
        { to: "user:123", content: "Context overflow error" },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      expect(session?.finalized).toBe(false);
      expect(session?.overflowRecoveryPending).toBe(true);
      await settleRun(
        handlers,
        {
          success: false,
          error: "Context overflow: prompt too large for the model.",
        },
        { sessionKey, runId },
      );

      expect(session?.finalized).toBe(true);
      expect(session?.overflowRecoveryPending).toBe(false);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "💥 agent",
      );
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "Context overflow: prompt too large for the model.",
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
    });

    it("preserves a live run beyond idle timeout before and after compaction", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const shortConfig = resolveConfig({ maxDisplaySeconds: 2 });
      const shortHandlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config: shortConfig,
      });
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_overflow_short_max_display";

      await shortHandlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      await shortHandlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await shortHandlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", durationMs: 50, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );

      await shortHandlers.onAgentEnd(
        {
          success: false,
          error: "Context overflow: prompt too large for the model.",
        },
        { sessionKey, runId },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.overflowRecoveryPending).toBe(true);
      expect(session?.maxDisplayTimer).toBeUndefined();

      // Advance 8s (> maxDisplaySeconds=2s) before before_compaction arrives
      await vi.advanceTimersByTimeAsync(8_000);
      await flushPromises();
      expect(store.sessions.get("discord:direct:123")).toBe(session);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(0);

      await shortHandlers.onBeforeCompaction(
        { messageCount: 100 },
        { sessionKey, runId },
      );
      expect(session?.maxDisplayTimer).toBeUndefined();

      await vi.advanceTimersByTimeAsync(3_000);
      await shortHandlers.onAfterCompaction(
        { messageCount: 20, compactedCount: 80 },
        { sessionKey, runId },
      );
      expect(session?.maxDisplayTimer).toBeDefined();

      // Idle cleanup cannot terminate a known live logical execution.
      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromises();
      expect(store.sessions.get("discord:direct:123")).toBe(session);
      expect(countCalls(fetchMock, "DELETE", /messages/)).toBe(0);
      await settleRun(shortHandlers, { success: true }, { sessionKey, runId });
      await vi.advanceTimersByTimeAsync(1500);
      expect(countCalls(fetchMock, "DELETE", /messages/)).toBe(1);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
    });

    it("keeps an overflow before visible activity until a settled lifecycle arrives", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_overflow_before_activity";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );

      await handlers.onAgentEnd(
        {
          success: false,
          error: "Context overflow: prompt too large for the model.",
        },
        { sessionKey, runId },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.overflowRecoveryPending).toBe(true);
      expect(session?.clearTimer).toBeUndefined();
      expect(countChannelMessagePosts(fetchMock)).toBe(0);

      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();

      expect(countChannelMessagePosts(fetchMock)).toBe(0);
      expect(store.sessions.get("discord:direct:123")).toBe(session);
      await settleRun(handlers, { success: true }, { sessionKey, runId });
      await vi.advanceTimersByTimeAsync(1500);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
      expect(store.contexts.has("discord:direct:123")).toBe(false);
    });

    it("preserves successor compaction when settled cleanup PATCH is in flight", async () => {
      vi.useFakeTimers();
      let holdNextPatch = false;
      let releaseHeldPatch: (() => void) | undefined;
      const heldPatchStarted = new Promise<void>((resolveStarted) => {
        let statusCounter = 0;
        const fetchMock = vi.fn(
          async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? "GET";

            if (url.includes("/users/@me/channels") && method === "POST") {
              return jsonResponse({ id: "dm_channel_123" });
            }
            if (
              url.includes("/channels/") &&
              url.endsWith("/messages") &&
              method === "POST"
            ) {
              statusCounter += 1;
              return jsonResponse({ id: `status_${statusCounter}` });
            }
            if (
              url.includes("/channels/") &&
              url.includes("/messages/") &&
              method === "PATCH"
            ) {
              if (holdNextPatch) {
                holdNextPatch = false;
                resolveStarted();
                await new Promise<void>((resolveRelease) => {
                  releaseHeldPatch = resolveRelease;
                });
              }
              return jsonResponse({ ok: true });
            }
            if (
              url.includes("/channels/") &&
              url.includes("/messages/") &&
              method === "DELETE"
            ) {
              return emptyResponse();
            }
            return jsonResponse({ ok: true });
          },
        );
        vi.stubGlobal("fetch", fetchMock);
      });
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_overflow_expiry_patch_race";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", durationMs: 40, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );

      await handlers.onAgentEnd(
        {
          success: false,
          error: "Context overflow: prompt too large for the model.",
        },
        { sessionKey, runId },
      );

      // The old execution settles while its final PATCH is held.
      holdNextPatch = true;
      const terminal = settleRun(
        handlers,
        { success: false, error: "Context overflow" },
        { sessionKey, runId },
      );
      await heldPatchStarted;

      await handlers.onMessageReceived(
        { messageId: "next-message", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId: "next-run" },
      );
      // Successor compaction must survive the old terminal operation.
      const beforeCompactionPromise = handlers.onBeforeCompaction(
        { messageCount: 90 },
        { sessionKey, runId: "next-run" },
      );
      await flushPromises();

      // Release the held expiry PATCH
      releaseHeldPatch?.();
      await Promise.all([beforeCompactionPromise, terminal]);
      await flushPromises();

      const session = store.sessions.get("discord:direct:123");
      expect(session).toBeDefined();
      expect(session?.compactionActive).toBe(true);
      expect(session?.finalized).toBe(false);
      expect(store.contexts.has("discord:direct:123")).toBe(true);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_2$/,
        ),
      ).toBe(0);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🗜️ compaction ▾ ←",
      );
    });

    it("preserves successor context and compaction while settled cleanup DELETE is in flight", async () => {
      vi.useFakeTimers();
      let holdNextDelete = false;
      let releaseHeldDelete: (() => void) | undefined;
      const heldDeleteStarted = new Promise<void>((resolveStarted) => {
        let statusCounter = 0;
        const fetchMock = vi.fn(
          async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? "GET";

            if (url.includes("/users/@me/channels") && method === "POST") {
              return jsonResponse({ id: "dm_channel_123" });
            }
            if (
              url.includes("/channels/") &&
              url.endsWith("/messages") &&
              method === "POST"
            ) {
              statusCounter += 1;
              return jsonResponse({ id: `status_${statusCounter}` });
            }
            if (
              url.includes("/channels/") &&
              url.includes("/messages/") &&
              method === "PATCH"
            ) {
              return jsonResponse({ ok: true });
            }
            if (
              url.includes("/channels/") &&
              url.includes("/messages/") &&
              method === "DELETE"
            ) {
              if (holdNextDelete) {
                holdNextDelete = false;
                resolveStarted();
                await new Promise<void>((resolveRelease) => {
                  releaseHeldDelete = resolveRelease;
                });
              }
              return emptyResponse();
            }
            return jsonResponse({ ok: true });
          },
        );
        vi.stubGlobal("fetch", fetchMock);
      });
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_overflow_expiry_delete_race";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {}, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );
      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", durationMs: 40, runId },
        { sessionKey, runId, toolName: "bash", toolCallId: "call_1" },
      );

      await handlers.onAgentEnd(
        {
          success: false,
          error: "Context overflow: prompt too large for the model.",
        },
        { sessionKey, runId },
      );

      await settleRun(
        handlers,
        { success: false, error: "Context overflow" },
        { sessionKey, runId },
      );
      // Hold the settled execution's cleanup DELETE.
      holdNextDelete = true;
      await vi.advanceTimersByTimeAsync(1500);
      await heldDeleteStarted;

      await handlers.onMessageReceived(
        { messageId: "next-message", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId: "next-run" },
      );
      // Successor compaction must survive the old cleanup.
      const beforeCompactionPromise = handlers.onBeforeCompaction(
        { messageCount: 90 },
        { sessionKey, runId: "next-run" },
      );
      await flushPromises();

      // Release the held expiry DELETE
      releaseHeldDelete?.();
      await beforeCompactionPromise;
      await flushPromises();

      const session = store.sessions.get("discord:direct:123");
      expect(session).toBeDefined();
      expect(session?.compactionActive).toBe(true);
      expect(session?.finalized).toBe(false);
      expect(store.contexts.has("discord:direct:123")).toBe(true);
      expect(session?.statusMessageId).toBe("status_2");
      expect(countChannelMessagePosts(fetchMock)).toBe(2);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🗜️ compaction ▾ ←",
      );
    });

    it("renders compaction progress even when before_compaction fires before any tool or pipeline activity", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";
      const runId = "run_first_turn_compact";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId, accountId: "default" },
      );

      await handlers.onBeforeCompaction(
        { messageCount: 80 },
        { sessionKey, runId },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.compactionActive).toBe(true);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "🗜️ compaction ▾ ←",
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("does not finalize on before_agent_reply before any activity exists", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const result = await handlers.onBeforeAgentReply(
        { cleanedBody: "done" },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(result).toEqual({ handled: false });
      expect(session?.finalized).toBeFalsy();
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toBe("");
      expect(plainContent).not.toContain("💡 skill-harness");
      expect(countChannelMessagePosts(fetchMock)).toBe(0);
    });

    it("keeps one status message across before_agent_reply and agent_end cleanup", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: { command: "ls" } },
        {
          sessionKey: "agent:main:discord:direct:123",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );

      await handlers.onBeforeAgentReply(
        { cleanedBody: "done" },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session).toBeDefined();
      expect(session?.finalized).toBe(false);
      expect(session?.clearTimer).toBeUndefined();

      await settleRun(
        handlers,
        { messages: [], success: true },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(0);
      expect(
        store.sessions.get("discord:direct:123")?.clearTimer,
      ).toBeDefined();

      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();

      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
      expect(store.sessions.has("discord:direct:123")).toBe(false);
    });
    it("does not patch again when agent_end follows a successful final render", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, accountId: "default" },
      );
      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: { command: "ls" } },
        { sessionKey, toolName: "bash", toolCallId: "call_1" },
      );
      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        { channelId: "discord", sessionKey },
      );
      await settleRun(
        handlers,
        { success: true },
        { channelId: "discord", sessionKey },
      );
      const patchesBefore = countCalls(
        fetchMock,
        "PATCH",
        /\/channels\/dm_channel_123\/messages\/status_1$/,
      );

      await settleRun(handlers, { success: true }, { sessionKey });

      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(patchesBefore);
      expect(
        store.sessions.get("discord:direct:123")?.clearTimer,
      ).toBeDefined();

      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("replaces a finalized session on a new inbound message from the same DM conversation", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: { command: "ls" } },
        {
          sessionKey: "agent:main:discord:direct:123",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );

      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
        },
      );
      await settleRun(
        handlers,
        { success: true },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
        },
      );

      const firstSession = store.sessions.get("discord:direct:123");
      expect(firstSession?.finalized).toBe(true);

      await handlers.onMessageReceived(
        { messageId: "user_msg_2", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const replacement = store.sessions.get("discord:direct:123");
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(firstSession);
      expect(replacement?.generation).toBe(2);
      expect(replacement?.finalized).toBe(false);
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("renders skill-harness pipeline events as a single status entry with status/result format", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "name-match",
          state: "completed",
          intent: "social-casual",
          domain: "chat",
          keywords: ["hi", "hello"],
          topic: "User is greeting.",
          keyword: "hi",
          matchedKeyword: "hello",
          score: 1,
          candidateCount: 1,
          confidence: 0.95,
          reason: "exact keyword matched",
          result: ["weather"],
          rawContext: "do not persist this",
        },
      });

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "completed",
          durationMs: 400,
        },
      });

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "skill-harness",
          toolName: "skill-harness",
          params: {
            result: "1 skill selected: weather (.95)",
          },
          status: "completed",
        }),
      ]);
      expect(
        session?.toolHistory.find((tool) => tool.toolCallId === "skill-harness")
          ?.params,
      ).not.toHaveProperty("intent");
      expect(
        session?.toolHistory.find((tool) => tool.toolCallId === "skill-harness")
          ?.params,
      ).not.toHaveProperty("rawContext");
      expect(
        session?.toolHistory.find((tool) => tool.toolCallId === "skill-harness")
          ?.params,
      ).not.toHaveProperty("keywords");
      expect(
        session?.toolHistory.find((tool) => tool.toolCallId === "skill-harness")
          ?.params,
      ).not.toHaveProperty("domain");
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("💡 skill-harness ▾ ✔");
      expect(plainContent).toContain("    ⊹ 1 skill selected: weather (.95)");
      expect(plainContent).not.toContain("result:");
      expect(plainContent).not.toContain("keywords");
      expect(plainContent).not.toContain("domain");
      expect(plainContent).not.toContain("topic");
      expect(plainContent).not.toContain("matchedKeyword");
      expect(plainContent).not.toContain("score:");
      expect(plainContent).not.toContain("rawContext");
      expect(plainContent).not.toMatch(/fastpath-a[12]/i);
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("renders terminal skill-harness failures as flat error history", async () => {
      createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "failed",
          error: "classifier crashed",
        },
      });

      const entry = store.sessions
        .get("discord:direct:123")
        ?.toolHistory.find((tool) => tool.toolCallId === "skill-harness");
      expect(entry).toEqual(
        expect.objectContaining({
          status: "error",
          error: "classifier crashed",
          params: {},
        }),
      );
      expect(entry?.params).not.toHaveProperty("reason");
      expect(entry?.params).not.toHaveProperty("result");

      const rendered =
        store.sessions.get("discord:direct:123")?.lastRenderedContent;
      expect(stripAnsi(rendered ?? "")).toContain("💡 skill-harness ▾ ✘");
      expect(stripAnsi(rendered ?? "")).toContain(
        "💡 skill-harness ▾ ✘\n    ⊹ classifier crashed",
      );
      expect(rendered).toContain(
        "\u001b[31m⊹ classifier crashed\u001b[0m\u001b[31m ✘\u001b[0m",
      );
      expect(rendered?.match(/classifier crashed/g)).toHaveLength(1);
    });

    it("calculates skill-harness phase duration from first to final pipeline event", async () => {
      const fetchMock = createDiscordFetchMock();
      const nowSpy = vi.spyOn(Date, "now");

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      nowSpy.mockReturnValueOnce(900);
      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      });

      nowSpy.mockReturnValueOnce(1_000);
      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "search",
          state: "completed",
          candidateCount: 1,
          confidence: 0.43,
          reason: "#1 travel-day",
          result: ["travel-day"],
        },
      });

      const session = store.sessions.get("discord:direct:123");
      const entry = session?.toolHistory.find(
        (tool) => tool.toolCallId === "skill-harness",
      );
      expect(entry).toEqual(
        expect.objectContaining({
          status: "pending",
          startedAtMs: 900,
          params: expect.objectContaining({
            status: "search · 1 candidate (.43) (#1 travel-day)",
          }),
        }),
      );
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("💡 skill-harness ▾ ←");
      expect(plainContent).toContain(
        "search · 1 candidate (.43) (#1 travel-day)",
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);

      nowSpy.mockReturnValueOnce(2_400);
      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "completed",
          durationMs: 1_500,
        },
      });

      const completedContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(completedContent).toContain("💡 skill-harness ▾ ✔ [1.5s]");
    });

    it("does not render duplicate skill-harness pipeline events twice", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const event = {
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      };

      await handlers.onSkillHarnessPipelineEvent(event);
      await handlers.onSkillHarnessPipelineEvent(event);

      expect(
        store.sessions
          .get("discord:direct:123")
          ?.toolHistory.filter((tool) => tool.toolCallId === "skill-harness"),
      ).toHaveLength(1);
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(0);
    });

    it("uses skill-harness data sessionKey when the event wrapper omits it", async () => {
      createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "completed",
          sessionKey: "agent:main:discord:direct:123",
        },
      });

      const entry = store.sessions
        .get("discord:direct:123")
        ?.toolHistory.find((tool) => tool.toolCallId === "skill-harness");
      expect(entry).toEqual(expect.objectContaining({ status: "completed" }));
    });

    it("accepts the skill-harness sessionKey fallback run id", async () => {
      createDiscordFetchMock();
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "main-run-1",
        },
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: sessionKey,
        stream: "plugin:skill-harness",
        sessionKey,
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "completed",
          result: ["health-tracking"],
        },
      });

      const session = store.sessions.get("discord:direct:123");
      expect(session?.runId).toBe("main-run-1");
      expect(session?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: "skill-harness",
          status: "completed",
          params: { result: "1 skill selected: health-tracking" },
        }),
      );
    });

    it("does not downgrade completed skill-harness to pending", async () => {
      createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const eventBase = {
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
      } as const;
      await handlers.onSkillHarnessPipelineEvent({
        ...eventBase,
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "completed",
        },
      });
      await handlers.onSkillHarnessPipelineEvent({
        ...eventBase,
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      });

      const entry = store.sessions
        .get("discord:direct:123")
        ?.toolHistory.find((tool) => tool.toolCallId === "skill-harness");
      expect(entry?.status).toBe("completed");
    });

    it("ignores malformed skill-harness pipeline events", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        data: {
          kind: "skill-harness.pipeline",
          phase: "exact-keyword-hint",
          state: "completed",
        },
      });
      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "other",
          phase: "exact-keyword-hint",
          state: "completed",
        },
      });

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual([]);
      expect(countChannelMessagePosts(fetchMock)).toBe(0);
    });

    it("ignores late tool events after finalization instead of creating another status message", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: { command: "ls" } },
        {
          sessionKey: "agent:main:discord:direct:123",
          toolName: "bash",
          toolCallId: "call_1",
        },
      );

      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
        },
      );
      await settleRun(
        handlers,
        { success: true },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      const beforeLateEventHistoryLength = session?.toolHistory.length ?? 0;
      const postCountBefore = countChannelMessagePosts(fetchMock);
      const patchCountBefore = countCalls(
        fetchMock,
        "PATCH",
        /\/channels\/dm_channel_123\/messages\/status_1$/,
      );

      await handlers.onBeforeToolCall(
        {
          toolCallId: "call_2",
          toolName: "cron",
          params: { expr: "* * * * *" },
        },
        {
          sessionKey: "agent:main:discord:direct:123",
          toolName: "cron",
          toolCallId: "call_2",
        },
      );

      await handlers.onAfterToolCall(
        { toolCallId: "call_2", toolName: "cron", params: {}, durationMs: 10 },
        {
          sessionKey: "agent:main:discord:direct:123",
          toolName: "cron",
          toolCallId: "call_2",
        },
      );

      expect(store.sessions.get("discord:direct:123")?.toolHistory.length).toBe(
        beforeLateEventHistoryLength,
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(postCountBefore);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(patchCountBefore);
    });

    it("keeps skill-harness ahead of tool calls across its lifecycle", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onBeforeAgentReply(
        { cleanedBody: "done" },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      await handlers.onBeforeToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {} },
        { sessionKey: "agent:main:discord:direct:123", toolName: "bash" },
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "started",
        },
      });

      const initial = store.sessions.get("discord:direct:123");
      expect(initial?.toolHistory.map((t) => t.toolCallId)).toEqual([
        "call_1",
        "skill-harness",
      ]);

      await handlers.onAfterToolCall(
        { toolCallId: "call_1", toolName: "bash", params: {} },
        { sessionKey: "agent:main:discord:direct:123", toolName: "bash" },
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "intent-classification",
          state: "completed",
          intent: "social-casual",
          domain: "chat",
        },
      });

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "pipeline",
          state: "completed",
        },
      });

      const afterSkillHarness = store.sessions.get("discord:direct:123");
      const skillHarnessContent = stripAnsi(
        afterSkillHarness?.lastRenderedContent ?? "",
      );
      expect(skillHarnessContent).toContain("bash");
      expect(skillHarnessContent).toContain("💡 skill-harness ▾ ✔");
      expect(
        afterSkillHarness!.lastRenderedContent!.indexOf("bash"),
      ).toBeGreaterThan(
        afterSkillHarness!.lastRenderedContent!.indexOf("💡 skill-harness"),
      );

      await settleRun(
        handlers,
        { messages: [], success: true },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      const final = store.sessions.get("discord:direct:123");
      expect(stripAnsi(final?.lastRenderedContent ?? "")).toContain("bash");
      expect(final?.lastRenderedContent).toContain("skill-harness");
      expect(final!.lastRenderedContent!.indexOf("bash")).toBeGreaterThan(
        final!.lastRenderedContent!.indexOf("💡 skill-harness"),
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });
  });
});
