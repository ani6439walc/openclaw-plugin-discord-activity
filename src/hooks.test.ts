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
import { flushPromises } from "../test-helpers.js";
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
  let isActiveMemoryEnabled: Mock<HookDeps["isActiveMemoryEnabled"]>;
  let isSkillHarnessEnabled: Mock<HookDeps["isSkillHarnessEnabled"]>;
  let handlers: ReturnType<typeof createHookHandlers>;

  beforeEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    store = defaultStore;
    orphans = createOrphanManager();
    getToken = vi.fn<HookDeps["getToken"]>().mockReturnValue("test-token");
    config = resolveConfig({});
    isActiveMemoryEnabled = vi
      .fn<HookDeps["isActiveMemoryEnabled"]>()
      .mockReturnValue(true);
    isSkillHarnessEnabled = vi
      .fn<HookDeps["isSkillHarnessEnabled"]>()
      .mockReturnValue(false);
    handlers = createHookHandlers({
      store,
      orphans,
      getToken,
      config,
      isActiveMemoryEnabled,
      isSkillHarnessEnabled,
    });
  });

  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(false);
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "msg_old", metadata: { to: "user:123" } },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      const oldSession = store.sessions.get("discord:direct:123");
      if (!oldSession) throw new Error("expected initial session");
      oldSession.statusCreateNonce = "stale_nonce";
      oldSession.confirmedDisplayState = {
        activeMemory: "removed",
        skillHarness: "collapsed",
      };
      oldSession.monotonicSafetyFloor = {
        activeMemory: "removed",
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

    it("shows pending skill-harness status when enabled", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

      await handlers.onMessageReceived(
        { messageId: "msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const session = store.sessions.get("discord:direct:123");
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

    it("inserts active-memory and skill-harness placeholders together in stable order", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(true);

      await handlers.onMessageReceived(
        { messageId: "msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory.map((t) => t.toolCallId)).toEqual([
        "active-memory",
        "skill-harness",
      ]);
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("🧩 active-memory ▾ ←");
      expect(plainContent).toContain("💡 skill-harness ▾ ←");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("skips active-memory sessions", async () => {
      await handlers.onMessageReceived(
        { messageId: "msg_1", metadata: {} },
        {
          channelId: "discord",
          sessionKey: "discord:channel:123:active-memory:abc",
        },
      );
      expect(store.contexts.size).toBe(0);
    });

    it("characterizes the default hook flow with a channel reply reference", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(false);
      config = resolveConfig({});
      handlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config,
        isActiveMemoryEnabled,
        isSkillHarnessEnabled,
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

      const postBodies = getStatusPostBodies(fetchMock);
      expect(postBodies).toHaveLength(1);
      expect(postBodies[0]?.message_reference).toEqual({
        message_id: "user_msg_1",
      });
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
        isActiveMemoryEnabled.mockReturnValue(false);
        isSkillHarnessEnabled.mockReturnValue(false);
        config = resolveConfig({ replyMode });
        handlers = createHookHandlers({
          store,
          orphans,
          getToken,
          config,
          isActiveMemoryEnabled,
          isSkillHarnessEnabled,
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
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(false);
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

    it("rejects a late active-memory agent_end from a superseded run", async () => {
      const { replacement, sessionKey } = await createReplacementForNewRun();

      await handlers.onAgentEnd(
        {
          messages: [],
          success: false,
          error: "old active-memory failure",
        },
        {
          sessionKey: `${sessionKey}:active-memory:old`,
          runId: "run_old",
        },
      );

      expect(replacement?.toolHistory).toEqual([]);
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
    it("fails open when active-memory admission cannot resolve its parent", async () => {
      const failingStore = {
        ...store,
        resolveSession: vi
          .fn<typeof store.resolveSession>()
          .mockRejectedValue(new Error("parent session unavailable")),
      };
      const failingHandlers = createHookHandlers({
        store: failingStore,
        orphans,
        getToken,
        config,
        isActiveMemoryEnabled,
        isSkillHarnessEnabled,
      });

      await expect(
        failingHandlers.onBeforeAgentReply(
          { cleanedBody: "active-memory admission" },
          {
            sessionKey: "agent:main:discord:direct:123:active-memory:child",
            runId: "active-memory-run-current",
          },
        ),
      ).resolves.toEqual({ handled: false });
    });

    it("does not let a delayed unregistered active-memory child tool event mutate its successor generation", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(false);
      const sessionKey = "agent:main:discord:direct:123";
      const activeMemorySessionKey = `${sessionKey}:active-memory:old`;
      const activeMemoryRunId = "active-memory-run-old";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_old",
        },
      );
      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      await handlers.onBeforeAgentReply(
        { cleanedBody: "queued followup" },
        { sessionKey, runId: "run_new" },
      );

      const successor = store.sessions.get("discord:direct:123");
      const historyBeforeLateChild = [...(successor?.toolHistory ?? [])];
      const postCountBeforeLateChild = countChannelMessagePosts(fetchMock);
      const patchCountBeforeLateChild = countCalls(
        fetchMock,
        "PATCH",
        /\/channels\/dm_channel_123\/messages\/status_2$/,
      );

      await handlers.onBeforeToolCall(
        {
          toolCallId: "memory_call_old",
          toolName: "memory_search",
          params: { query: "old context" },
          runId: activeMemoryRunId,
        },
        {
          sessionKey: activeMemorySessionKey,
          toolCallId: "memory_call_old",
          toolName: "memory_search",
          runId: activeMemoryRunId,
        },
      );

      await handlers.onAgentEnd(
        {
          messages: [],
          success: false,
          error: "old active-memory failure",
        },
        {
          sessionKey: activeMemorySessionKey,
          runId: activeMemoryRunId,
        },
      );

      expect(successor?.generation).toBe(2);
      expect(successor?.runId).toBe("run_new");
      expect(successor?.toolHistory).toEqual(historyBeforeLateChild);
      expect(countChannelMessagePosts(fetchMock)).toBe(
        postCountBeforeLateChild,
      );
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_2$/,
        ),
      ).toBe(patchCountBeforeLateChild);
    });

    it("does not let a no-tool active-memory child run mutate its successor generation", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(false);
      const sessionKey = "agent:main:discord:direct:123";
      const activeMemorySessionKey = `${sessionKey}:active-memory:old`;
      const activeMemoryRunId = "active-memory-run-old";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_old",
        },
      );
      await handlers.onBeforeAgentRun(
        { prompt: "old active-memory run", messages: [] },
        { sessionKey: activeMemorySessionKey, runId: activeMemoryRunId },
      );
      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
        { channelId: "discord", sessionKey, runId: "run_old" },
      );
      await handlers.onBeforeAgentReply(
        { cleanedBody: "queued followup" },
        { sessionKey, runId: "run_new" },
      );

      const successor = store.sessions.get("discord:direct:123");
      const historyBeforeLateChild = [...(successor?.toolHistory ?? [])];
      const postCountBeforeLateChild = countChannelMessagePosts(fetchMock);
      const patchCountBeforeLateChild = countCalls(
        fetchMock,
        "PATCH",
        /\/channels\/dm_channel_123\/messages\/status_2$/,
      );

      await handlers.onAgentEnd(
        {
          messages: [],
          success: false,
          error: "old active-memory failure",
        },
        {
          sessionKey: activeMemorySessionKey,
          runId: activeMemoryRunId,
        },
      );

      expect(successor?.generation).toBe(2);
      expect(successor?.runId).toBe("run_new");
      expect(successor?.toolHistory).toEqual(historyBeforeLateChild);
      expect(countChannelMessagePosts(fetchMock)).toBe(
        postCountBeforeLateChild,
      );
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_2$/,
        ),
      ).toBe(patchCountBeforeLateChild);
    });

    it("reconciles a registered no-tool active-memory child in the current generation", async () => {
      createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(false);
      const sessionKey = "agent:main:discord:direct:123";
      const activeMemorySessionKey = `${sessionKey}:active-memory:current`;
      const activeMemoryRunId = "active-memory-run-current";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_current",
        },
      );
      await handlers.onBeforeAgentReply(
        { cleanedBody: "current active-memory run" },
        { sessionKey: activeMemorySessionKey, runId: activeMemoryRunId },
      );
      await handlers.onAgentEnd(
        { messages: [], success: true, durationMs: 500 },
        { sessionKey: activeMemorySessionKey, runId: activeMemoryRunId },
      );

      expect(
        store.sessions.get("discord:direct:123")?.toolHistory,
      ).toContainEqual(
        expect.objectContaining({
          toolCallId: "active-memory",
          status: "completed",
          durationMs: 500,
        }),
      );
    });

    it("fails open when active-memory run registration cannot resolve its parent", async () => {
      const failingStore = {
        ...store,
        resolveSession: vi
          .fn<typeof store.resolveSession>()
          .mockRejectedValue(new Error("parent session unavailable")),
      };
      const failingHandlers = createHookHandlers({
        store: failingStore,
        orphans,
        getToken,
        config,
        isActiveMemoryEnabled,
        isSkillHarnessEnabled,
      });

      await expect(
        failingHandlers.onBeforeAgentRun(
          { prompt: "active-memory recall", messages: [] },
          {
            sessionKey: "agent:main:discord:direct:123:active-memory:current",
            runId: "active-memory-run-current",
          },
        ),
      ).resolves.toBeUndefined();
    });

    it("shows tools from a registered active-memory child run", async () => {
      createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(false);
      const sessionKey = "agent:main:discord:direct:123";
      const activeMemorySessionKey = `${sessionKey}:active-memory:current`;
      const activeMemoryRunId = "active-memory-run-current";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_current",
        },
      );
      await handlers.onBeforeAgentRun(
        { prompt: "current active-memory run", messages: [] },
        { sessionKey: activeMemorySessionKey, runId: activeMemoryRunId },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "memory_call",
          toolName: "memory_get",
          params: { path: "knowledge/concepts/example.md" },
          runId: activeMemoryRunId,
        },
        {
          sessionKey: activeMemorySessionKey,
          toolCallId: "memory_call",
          toolName: "memory_get",
          runId: activeMemoryRunId,
        },
      );
      await handlers.onAfterToolCall(
        {
          toolCallId: "memory_call",
          toolName: "memory_get",
          params: { path: "knowledge/concepts/example.md" },
          runId: activeMemoryRunId,
        },
        {
          sessionKey: activeMemorySessionKey,
          toolCallId: "memory_call",
          toolName: "memory_get",
          runId: activeMemoryRunId,
        },
      );

      await handlers.onAgentEnd(
        {
          messages: [{ role: "assistant", content: "NONE" }],
          success: true,
          durationMs: 500,
        },
        { sessionKey: activeMemorySessionKey, runId: activeMemoryRunId },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: "active-memory:memory_call",
          toolName: "active-memory:memory_get",
          status: "completed",
        }),
      );
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "result: NONE",
      );
    });

    it("ignores an unregistered distinct active-memory child in the current generation", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(false);
      const sessionKey = "agent:main:discord:direct:123";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey,
          accountId: "default",
          runId: "run_current",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      const historyBeforeChild = [...(session?.toolHistory ?? [])];
      const patchCountBeforeChild = countCalls(
        fetchMock,
        "PATCH",
        /\/channels\/dm_channel_123\/messages\/status_1$/,
      );
      await handlers.onAgentEnd(
        { messages: [], success: false, error: "unregistered child" },
        {
          sessionKey: `${sessionKey}:active-memory:unregistered`,
          runId: "active-memory-run-unregistered",
        },
      );

      expect(session?.toolHistory).toEqual(historyBeforeChild);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(patchCountBeforeChild);
    });

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
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(true);
      config = resolveConfig({ replyMode: "direct" });
      handlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config,
        isActiveMemoryEnabled,
        isSkillHarnessEnabled,
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
      expect(queuedSession?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "active-memory",
          status: "pending",
        }),
        expect.objectContaining({
          toolCallId: "skill-harness",
          status: "pending",
        }),
      ]);
      expect(getStatusPostBodies(fetchMock)).toEqual([
        expect.objectContaining({
          message_reference: { message_id: "user_msg_1" },
        }),
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
          phase: "intent-classification",
          state: "completed",
          intent: "queued-followup",
        },
      });

      expect(queuedSession?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: "skill-harness:run_new:intent-classification",
          status: "completed",
          params: { intent: "queued-followup" },
        }),
      );
      expect(stripAnsi(queuedSession?.lastRenderedContent ?? "")).toContain(
        "intent-classification ✔",
      );
    });

    it("guards queued successor takeover and fences late run events", async () => {
      vi.useFakeTimers();
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);
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
      await handlers.onAgentEnd(
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
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);
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
      await handlers.onMessageSending(
        { to: "user:123", content: "done" },
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
        isActiveMemoryEnabled,
        isSkillHarnessEnabled,
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
    it("shows active-memory subagent tool calls in the parent session", async () => {
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
        {
          toolCallId: "call_1",
          toolName: "memory_search",
          params: { query: "fastpath" },
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
          toolName: "memory_search",
          toolCallId: "call_1",
        },
      );

      await handlers.onAfterToolCall(
        {
          toolCallId: "call_1",
          toolName: "memory_search",
          params: { query: "fastpath" },
          durationMs: 42,
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
          toolName: "memory_search",
          toolCallId: "call_1",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "active-memory",
          toolName: "active-memory",
          status: "pending",
        }),
        expect.objectContaining({
          toolCallId: "active-memory:call_1",
          toolName: "active-memory:memory_search",
          status: "completed",
          durationMs: 42,
        }),
      ]);
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("🧩 active-memory ▾ ←\n");
      expect(plainContent).toContain("memory_search ✔ [42ms]");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("shows active-memory tool calls from subagent-scoped session keys", async () => {
      const fetchMock = createDiscordFetchMock();
      const activeMemorySessionKey =
        "agent:main:discord:direct:123:subagent:abc:active-memory:def";

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onBeforeToolCall(
        {
          toolCallId: "call_1",
          toolName: "memory_search",
          params: { query: "fastpath" },
        },
        {
          sessionKey: activeMemorySessionKey,
          toolName: "memory_search",
          toolCallId: "call_1",
        },
      );

      await handlers.onAfterToolCall(
        {
          toolCallId: "call_1",
          toolName: "memory_search",
          params: { query: "fastpath" },
          durationMs: 42,
        },
        {
          sessionKey: activeMemorySessionKey,
          toolName: "memory_search",
          toolCallId: "call_1",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("🧩 active-memory ▾ ←\n");
      expect(plainContent).toContain("memory_search ✔ [42ms]");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
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
      await handlers.onAgentEnd(
        { messages: [] },
        { sessionKey: "discord:channel:123:subagent:abc" },
      );
      consoleSpy.mockRestore();
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
        isActiveMemoryEnabled,
        isSkillHarnessEnabled,
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
      await handlers.onAgentEnd({ success: true }, { sessionKey, runId });
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
      await handlers.onAgentEnd(
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

    it("does not finalize on before_agent_reply when only pending subagent placeholders exist", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(true);

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
      expect(plainContent).toContain("🧩 active-memory ▾ ←");
      expect(plainContent).toContain("💡 skill-harness ▾ ←");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("keeps one status message across before_agent_reply, active-memory agent_end, and main agent_end cleanup", async () => {
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

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "mem_1",
                  name: "memory_search",
                  arguments: { query: "hello" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mem_1",
              toolName: "memory_search",
            },
          ],
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
        },
      );

      await handlers.onAgentEnd(
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
      ).toBe(2);
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
      expect(countChannelMessagePosts(fetchMock)).toBe(2);
      expect(
        countCalls(
          fetchMock,
          "DELETE",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("keeps active-memory visible as error when active-memory agent_end times out before producing tool entries", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onAgentEnd(
        {
          messages: [],
          success: false,
          error: "timed out after 15000ms",
          durationMs: 15196,
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({
          toolCallId: "active-memory",
          toolName: "active-memory",
          status: "error",
          durationMs: 15196,
          error: "timed out after 15000ms",
        }),
      ]);
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("🧩 active-memory ▾ ✘ [15.2s]");
      expect(plainContent).toContain("timed out after 15000ms");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("renders the final active-memory assistant message as a result item", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const pendingSession = store.sessions.get("discord:direct:123");
      if (!pendingSession) throw new Error("expected active session");
      pendingSession.confirmedDisplayState = {
        "group:active-memory": "collapsed",
      };
      pendingSession.monotonicSafetyFloor = {
        "group:active-memory": "collapsed",
      };

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "mem_1",
                  name: "memory_search",
                  arguments: { query: "hello" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mem_1",
              toolName: "memory_search",
            },
            {
              role: "assistant",
              content: "每日早報重跑已觸發 Cron job",
            },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolCallId: "active-memory:mem_1",
            toolName: "active-memory:memory_search",
            status: "completed",
          }),
          expect.objectContaining({
            toolCallId: "active-memory:result",
            toolName: "active-memory:result",
            params: { text: "每日早報重跑已觸發 Cron job" },
            status: "completed",
          }),
        ]),
      );
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "active-memory ▾ ✔",
      );
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "result: 每日早報重跑已觸發 Cron job",
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("captures active-memory results from subagent-scoped session keys", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "mem_1",
                  name: "memory_search",
                  arguments: { query: "hello" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mem_1",
              toolName: "memory_search",
            },
            {
              role: "assistant",
              content: "NONE",
            },
          ],
          success: true,
        },
        {
          sessionKey:
            "agent:main:discord:direct:123:subagent:abc:active-memory:def",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("🧩 active-memory ▾ ✔");
      expect(plainContent).toContain("memory_search ✔");
      expect(plainContent).toContain("result: NONE");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("renders skill-harness pipeline events as grouped status entries", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

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
          phase: "exact-keyword-hint",
          state: "completed",
          intent: "social-casual",
          domain: "chat",
          keywords: ["hi", "hello"],
          topic: "User is greeting.",
          keyword: "hi",
          matchedKeyword: "hello",
          score: 1,
          reason: "exact keyword matched",
          result: "matched greeting keyword",
          rawContext: "do not persist this",
        },
      });

      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "prompt-prefix-injection",
          state: "completed",
          intent: "social-casual",
          domain: "chat",
        },
      });

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolCallId: "skill-harness:run-1:exact-keyword-hint",
            toolName: "skill-harness:exact-keyword-hint",
            params: expect.objectContaining({ intent: "social-casual" }),
            status: "completed",
          }),
        ]),
      );
      expect(
        session?.toolHistory.find(
          (tool) =>
            tool.toolCallId === "skill-harness:run-1:exact-keyword-hint",
        )?.params,
      ).not.toHaveProperty("rawContext");
      expect(
        session?.toolHistory.find(
          (tool) =>
            tool.toolCallId === "skill-harness:run-1:exact-keyword-hint",
        )?.params,
      ).not.toEqual(
        expect.objectContaining({
          matchedKeyword: expect.anything(),
          score: expect.anything(),
        }),
      );
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("💡 skill-harness ▾ ✔");
      expect(plainContent).toContain("exact-keyword-hint ✔");
      expect(plainContent).toContain('keywords: ["hi","hello"]');
      expect(plainContent).toContain("topic: User is greeting.");
      expect(plainContent).toContain("result: matched greeting keyword");
      expect(plainContent).not.toContain("matchedKeyword");
      expect(plainContent).not.toContain("score:");
      expect(plainContent).not.toContain("reason");
      expect(plainContent).toContain("prompt-prefix-injection ✔");
      expect(plainContent).not.toContain("rawContext");
      expect(plainContent).not.toMatch(/fastpath-a[12]/i);
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(2);
    });

    it("renders canonical skill-harness failures as phase-local errors", async () => {
      createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

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
          phase: "intent-classification",
          state: "failed",
          error: "classifier crashed",
        },
      });

      const entry = store.sessions
        .get("discord:direct:123")
        ?.toolHistory.find(
          (tool) =>
            tool.toolCallId === "skill-harness:run-1:intent-classification",
        );
      expect(entry).toEqual(
        expect.objectContaining({
          status: "error",
          error: "classifier crashed",
          params: { error: "classifier crashed" },
        }),
      );
      expect(entry?.params).not.toHaveProperty("reason");
      expect(entry?.params).not.toHaveProperty("result");

      const rendered =
        store.sessions.get("discord:direct:123")?.lastRenderedContent;
      expect(stripAnsi(rendered ?? "")).toContain("intent-classification ✘");
      expect(stripAnsi(rendered ?? "")).toContain("error: classifier crashed");
      expect(rendered?.match(/classifier crashed/g)).toHaveLength(1);
    });

    it("calculates skill-harness phase duration from first to final pipeline event", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);
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
          phase: "topic-triage",
          state: "started",
          domain: "openclaw-platform",
        },
      });

      nowSpy.mockReturnValueOnce(2_100);
      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "topic-triage",
          state: "completed",
          domain: "openclaw-platform",
          topic: "User approves deletion of workspace-doc-maintenance.",
        },
      });

      const session = store.sessions.get("discord:direct:123");
      const entry = session?.toolHistory.find(
        (tool) => tool.toolCallId === "skill-harness:run-1:topic-triage",
      );
      expect(entry).toEqual(
        expect.objectContaining({
          status: "completed",
          startedAtMs: 1_000,
          durationMs: 1_100,
        }),
      );
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("💡 skill-harness ▾ ←");
      expect(plainContent).not.toContain("💡 skill-harness ▾ ← [");
      expect(plainContent).toContain("topic-triage ✔ [1.1s]");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);

      nowSpy.mockReturnValueOnce(2_200);
      await handlers.onSkillHarnessPipelineEvent({
        runId: "run-1",
        stream: "plugin:skill-harness",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "skill-harness.pipeline",
          phase: "intent-classification",
          state: "started",
          intent: "implementation",
        },
      });

      const pendingContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(pendingContent).toContain("💡 skill-harness ▾ ←");
      expect(pendingContent).toContain("intent-classification ←");

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
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

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
          phase: "session-record",
          state: "completed",
        },
      };

      await handlers.onSkillHarnessPipelineEvent(event);
      await handlers.onSkillHarnessPipelineEvent(event);

      expect(
        store.sessions
          .get("discord:direct:123")
          ?.toolHistory.filter(
            (tool) => tool.toolCallId === "skill-harness:run-1:session-record",
          ),
      ).toHaveLength(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(1);
    });

    it("uses skill-harness data sessionKey when the event wrapper omits it", async () => {
      createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

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
          phase: "prompt-prefix-injection",
          state: "skipped",
          sessionKey: "agent:main:discord:direct:123",
        },
      });

      const entry = store.sessions
        .get("discord:direct:123")
        ?.toolHistory.find(
          (tool) =>
            tool.toolCallId === "skill-harness:run-1:prompt-prefix-injection",
        );
      expect(entry).toEqual(expect.objectContaining({ status: "completed" }));
    });

    it("accepts the skill-harness sessionKey fallback run id", async () => {
      createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);
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
          phase: "topic-triage",
          state: "completed",
          topic: "health tracking",
        },
      });

      const session = store.sessions.get("discord:direct:123");
      expect(session?.runId).toBe("main-run-1");
      expect(session?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: `skill-harness:${sessionKey}:topic-triage`,
          status: "completed",
          params: { topic: "health tracking" },
        }),
      );
    });

    it("keeps active-memory agent end correlated when its child run id differs from the parent", async () => {
      createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(true);
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
      const activeMemorySessionKey = `${sessionKey}:active-memory:child`;
      const activeMemoryContext = {
        sessionKey: activeMemorySessionKey,
        toolName: "memory_search",
        toolCallId: "memory-call-1",
        runId: "active-memory-run-1",
      };
      await handlers.onBeforeAgentReply(
        { cleanedBody: "active-memory admission" },
        {
          sessionKey: activeMemorySessionKey,
          runId: "active-memory-run-1",
        },
      );
      await handlers.onBeforeToolCall(
        {
          toolCallId: "memory-call-1",
          toolName: "memory_search",
          params: { query: "weight history" },
          runId: "active-memory-run-1",
        },
        activeMemoryContext,
      );
      await handlers.onAfterToolCall(
        {
          toolCallId: "memory-call-1",
          toolName: "memory_search",
          params: { query: "weight history" },
          durationMs: 100,
          runId: "active-memory-run-1",
        },
        activeMemoryContext,
      );
      await handlers.onAgentEnd(
        { messages: [], success: true, durationMs: 500 },
        {
          sessionKey: activeMemorySessionKey,
          runId: "active-memory-run-1",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.runId).toBe("main-run-1");
      expect(session?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: "active-memory",
          status: "completed",
          durationMs: 500,
        }),
      );

      await handlers.onBeforeToolCall(
        {
          toolCallId: "main-call-1",
          toolName: "bash",
          params: { command: "pwd" },
          runId: "main-run-1",
        },
        {
          sessionKey,
          toolName: "bash",
          toolCallId: "main-call-1",
          runId: "main-run-1",
        },
      );

      expect(session?.runId).toBe("main-run-1");
      expect(session?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: "main-call-1",
          toolName: "bash",
          status: "pending",
        }),
      );

      await handlers.onSkillHarnessPipelineEvent({
        runId: "main-run-1",
        stream: "plugin:skill-harness",
        sessionKey,
        data: {
          kind: "skill-harness.pipeline",
          phase: "intent-classify",
          state: "completed",
          intent: "implementation",
        },
      });

      expect(session?.runId).toBe("main-run-1");
      expect(session?.toolHistory).toContainEqual(
        expect.objectContaining({
          toolCallId: "skill-harness:main-run-1:intent-classify",
          status: "completed",
          params: { intent: "implementation" },
        }),
      );
    });

    it("does not downgrade completed skill-harness phases to pending", async () => {
      createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

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
          phase: "intent-classification",
          state: "completed",
        },
      });
      await handlers.onSkillHarnessPipelineEvent({
        ...eventBase,
        data: {
          kind: "skill-harness.pipeline",
          phase: "intent-classification",
          state: "started",
        },
      });

      const entry = store.sessions
        .get("discord:direct:123")
        ?.toolHistory.find(
          (tool) =>
            tool.toolCallId === "skill-harness:run-1:intent-classification",
        );
      expect(entry?.status).toBe("completed");
    });

    it("ignores legacy skill-harness agent_end result rendering", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content:
                "INTENT:RESEARCH | GOAL: 查文件 | SUGGESTED_TOOLS: context7",
            },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:123:skill-harness:abc",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(
        session?.toolHistory.some(
          (tool) => tool.toolName === "skill-harness:result",
        ),
      ).toBe(false);
      expect(stripAnsi(session?.lastRenderedContent ?? "")).toContain(
        "💡 skill-harness ▾ ←",
      );
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("ignores malformed skill-harness pipeline events", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isSkillHarnessEnabled.mockReturnValue(true);

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
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({ toolName: "skill-harness" }),
      ]);
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("does not reuse earlier assistant text when the final assistant message has only tool calls", async () => {
      const fetchMock = createDiscordFetchMock();

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content: "這是比較早的摘要",
            },
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "mem_1",
                  name: "memory_search",
                  arguments: { query: "hello" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mem_1",
              toolName: "memory_search",
            },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({
            toolCallId: "active-memory:result",
          }),
        ]),
      );
      expect(session?.lastRenderedContent).not.toContain("- result:");
      expect(session?.lastRenderedContent).toContain("memory_search");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
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

    it("keeps parent order stable across the real subagent lifecycle", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isSkillHarnessEnabled.mockReturnValue(true);

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

      const initial = store.sessions.get("discord:direct:123");
      expect(initial?.toolHistory.map((t) => t.toolCallId)).toEqual([
        "active-memory",
        "skill-harness",
      ]);

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "mem_1",
                  name: "memory_search",
                  arguments: { query: "hello" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mem_1",
              toolName: "memory_search",
            },
            {
              role: "assistant",
              content: "NONE",
            },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
        },
      );

      const afterActiveMemory = store.sessions.get("discord:direct:123");
      expect(
        afterActiveMemory?.toolHistory.find(
          (entry) => entry.toolCallId === "active-memory",
        ),
      ).toEqual(expect.objectContaining({ status: "completed" }));
      const activeMemoryContent = stripAnsi(
        afterActiveMemory?.lastRenderedContent ?? "",
      );
      expect(activeMemoryContent).toContain("🧩 active-memory ▾ ✔");
      expect(activeMemoryContent).toContain("💡 skill-harness ▾ ←");
      expect(
        afterActiveMemory!.lastRenderedContent!.indexOf("skill-harness"),
      ).toBeLessThan(
        afterActiveMemory!.lastRenderedContent!.indexOf("🧩 active-memory"),
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

      const afterSkillHarness = store.sessions.get("discord:direct:123");
      const skillHarnessContent = stripAnsi(
        afterSkillHarness?.lastRenderedContent ?? "",
      );
      expect(skillHarnessContent).toContain("🧩 active-memory ▾ ✔");
      expect(skillHarnessContent).toContain("💡 skill-harness ▾ ✔");
      expect(
        afterSkillHarness!.lastRenderedContent!.indexOf("💡 skill-harness"),
      ).toBeLessThan(
        afterSkillHarness!.lastRenderedContent!.indexOf("🧩 active-memory"),
      );

      await handlers.onAgentEnd(
        { messages: [], success: true },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      const final = store.sessions.get("discord:direct:123");
      expect(stripAnsi(final?.lastRenderedContent ?? "")).toContain(
        "🧩 active-memory ▾ ✔",
      );
      expect(final?.lastRenderedContent).toContain("skill-harness");
      expect(
        final!.lastRenderedContent!.indexOf("💡 skill-harness"),
      ).toBeLessThan(final!.lastRenderedContent!.indexOf("🧩 active-memory"));
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });
  });
});
