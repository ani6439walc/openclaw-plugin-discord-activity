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
import { createEnhancedOrphanManager } from "./enhanced-orphans.js";
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

describe("createHookHandlers", () => {
  let store: typeof defaultStore;
  let orphans: ReturnType<typeof createEnhancedOrphanManager>;
  let getToken: Mock<HookDeps["getToken"]>;
  let config: ReturnType<typeof resolveConfig>;
  let isActiveMemoryEnabled: Mock<HookDeps["isActiveMemoryEnabled"]>;
  let isIntentionHintEnabled: Mock<HookDeps["isIntentionHintEnabled"]>;
  let handlers: ReturnType<typeof createHookHandlers>;

  beforeEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    store = defaultStore;
    orphans = createEnhancedOrphanManager();
    getToken = vi.fn<HookDeps["getToken"]>().mockReturnValue("test-token");
    config = resolveConfig({});
    isActiveMemoryEnabled = vi
      .fn<HookDeps["isActiveMemoryEnabled"]>()
      .mockReturnValue(true);
    isIntentionHintEnabled = vi
      .fn<HookDeps["isIntentionHintEnabled"]>()
      .mockReturnValue(false);
    handlers = createHookHandlers({
      store,
      orphans,
      getToken,
      config,
      isActiveMemoryEnabled,
      isIntentionHintEnabled,
    });
  });

  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    it("shows pending intention-hint status when enabled", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isIntentionHintEnabled.mockReturnValue(true);

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
          toolCallId: "intention-hint",
          toolName: "intention-hint",
          status: "pending",
        }),
      ]);
      expect(session?.lastRenderedContent).toContain("💡 intention-hint: ←");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("inserts active-memory and intention-hint placeholders together in stable order", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isIntentionHintEnabled.mockReturnValue(true);

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
        "intention-hint",
      ]);
      expect(session?.lastRenderedContent).toContain("🧩 active-memory: ←");
      expect(session?.lastRenderedContent).toContain("💡 intention-hint: ←");
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

    it("trims tool history using configured maxToolHistoryLength", async () => {
      getToken.mockReturnValue("");
      config = resolveConfig({ maxToolHistoryLength: 2 });
      handlers = createHookHandlers({
        store,
        orphans,
        getToken,
        config,
        isActiveMemoryEnabled,
        isIntentionHintEnabled,
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
  });

  describe("onAfterToolCall", () => {
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
      expect(session?.lastRenderedContent).toContain("bash: ✘");
      expect(session?.lastRenderedContent).toContain("permission denied");
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

    it("does not finalize on before_agent_reply when only pending subagent placeholders exist", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isIntentionHintEnabled.mockReturnValue(true);

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
      expect(session?.lastRenderedContent).toContain("🧩 active-memory: ←");
      expect(session?.lastRenderedContent).toContain("💡 intention-hint: ←");
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
      expect(session?.finalized).toBe(true);
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

      await handlers.onBeforeAgentReply(
        { cleanedBody: "done" },
        { sessionKey: "agent:main:discord:direct:123" },
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
      expect(session?.lastRenderedContent).toContain("🧩 active-memory: ✘");
      expect(session?.lastRenderedContent).toContain("timed out after 15000ms");
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
      expect(session?.lastRenderedContent).toContain(
        "- result: 每日早報重跑已觸發 Cron job",
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

    it("renders intention-hint pipeline events as grouped status entries", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isIntentionHintEnabled.mockReturnValue(true);

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onIntentionHintPipelineEvent({
        runId: "run-1",
        stream: "plugin:intention-hint",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "intention-hint.pipeline",
          phase: "exact-keyword-hint",
          state: "completed",
          intent: "social-casual",
          domain: "chat",
          keyword: "hi",
          rawContext: "do not persist this",
        },
      });

      await handlers.onIntentionHintPipelineEvent({
        runId: "run-1",
        stream: "plugin:intention-hint",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "intention-hint.pipeline",
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
            toolCallId: "intention-hint:run-1:exact-keyword-hint",
            toolName: "intention-hint:exact-keyword-hint",
            params: expect.objectContaining({ intent: "social-casual" }),
            status: "completed",
          }),
        ]),
      );
      expect(
        session?.toolHistory.find(
          (tool) =>
            tool.toolCallId === "intention-hint:run-1:exact-keyword-hint",
        )?.params,
      ).not.toHaveProperty("rawContext");
      expect(session?.lastRenderedContent).toContain("💡 intention-hint: ✔");
      expect(session?.lastRenderedContent).toContain("- exact-keyword-hint: ✔");
      expect(session?.lastRenderedContent).toContain(
        "- prompt-prefix-injection: ✔",
      );
      expect(session?.lastRenderedContent).not.toMatch(/fastpath-a[12]/i);
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
      expect(
        countCalls(
          fetchMock,
          "PATCH",
          /\/channels\/dm_channel_123\/messages\/status_1$/,
        ),
      ).toBe(2);
    });

    it("ignores legacy intention-hint agent_end result rendering", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isIntentionHintEnabled.mockReturnValue(true);

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
          sessionKey: "agent:main:discord:direct:123:intention-hint:abc",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(
        session?.toolHistory.some(
          (tool) => tool.toolName === "intention-hint:result",
        ),
      ).toBe(false);
      expect(session?.lastRenderedContent).toContain("💡 intention-hint: ←");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("ignores malformed intention-hint pipeline events", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(false);
      isIntentionHintEnabled.mockReturnValue(true);

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      await handlers.onIntentionHintPipelineEvent({
        runId: "run-1",
        stream: "plugin:intention-hint",
        data: {
          kind: "intention-hint.pipeline",
          phase: "exact-keyword-hint",
          state: "completed",
        },
      });
      await handlers.onIntentionHintPipelineEvent({
        runId: "run-1",
        stream: "plugin:intention-hint",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "other",
          phase: "exact-keyword-hint",
          state: "completed",
        },
      });

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory).toEqual([
        expect.objectContaining({ toolName: "intention-hint" }),
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

      await handlers.onBeforeAgentReply(
        { cleanedBody: "done" },
        { sessionKey: "agent:main:discord:direct:123" },
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

    it("preserves group order when active-memory completes before intention-hint", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isIntentionHintEnabled.mockReturnValue(true);

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:123",
          accountId: "default",
        },
      );

      const session = store.sessions.get("discord:direct:123");
      expect(session?.toolHistory.map((t) => t.toolCallId)).toEqual([
        "active-memory",
        "intention-hint",
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
                  arguments: { query: "test" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mem_1",
              toolName: "memory_search",
            },
            { role: "assistant", content: "found result" },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:123:active-memory:abc",
        },
      );

      const afterAm = store.sessions.get("discord:direct:123");
      const amIdx = afterAm!.toolHistory.findIndex(
        (t) =>
          t.toolName === "active-memory" ||
          t.toolName.startsWith("active-memory:"),
      );
      const ihIdx = afterAm!.toolHistory.findIndex(
        (t) =>
          t.toolName === "intention-hint" ||
          t.toolName.startsWith("intention-hint:"),
      );
      expect(amIdx).toBeLessThan(ihIdx);

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content: "INTENT:RESEARCH | GOAL: docs",
            },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:123:intention-hint:xyz",
        },
      );

      const final = store.sessions.get("discord:direct:123");
      const finalAmIdx = final!.toolHistory.findIndex(
        (t) =>
          t.toolName === "active-memory" ||
          t.toolName.startsWith("active-memory:"),
      );
      const finalIhIdx = final!.toolHistory.findIndex(
        (t) =>
          t.toolName === "intention-hint" ||
          t.toolName.startsWith("intention-hint:"),
      );
      expect(finalAmIdx).toBeLessThan(finalIhIdx);
    });

    it("keeps parent order stable across the real subagent lifecycle", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isIntentionHintEnabled.mockReturnValue(true);

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
        "intention-hint",
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
        afterActiveMemory?.toolHistory.some(
          (t) => t.toolCallId === "active-memory",
        ),
      ).toBe(false);
      expect(afterActiveMemory?.lastRenderedContent).toContain(
        "🧩 active-memory: ✔",
      );
      expect(afterActiveMemory?.lastRenderedContent).toContain(
        "💡 intention-hint: ←",
      );
      expect(
        afterActiveMemory!.lastRenderedContent!.indexOf("🧩 active-memory"),
      ).toBeLessThan(
        afterActiveMemory!.lastRenderedContent!.indexOf("intention-hint"),
      );

      await handlers.onIntentionHintPipelineEvent({
        runId: "run-1",
        stream: "plugin:intention-hint",
        sessionKey: "agent:main:discord:direct:123",
        data: {
          kind: "intention-hint.pipeline",
          phase: "intent-classification",
          state: "completed",
          intent: "social-casual",
          domain: "chat",
        },
      });

      const afterIntentionHint = store.sessions.get("discord:direct:123");
      expect(afterIntentionHint?.lastRenderedContent).toContain(
        "🧩 active-memory: ✔",
      );
      expect(afterIntentionHint?.lastRenderedContent).toContain(
        "💡 intention-hint: ✔",
      );
      expect(
        afterIntentionHint!.lastRenderedContent!.indexOf("🧩 active-memory"),
      ).toBeLessThan(
        afterIntentionHint!.lastRenderedContent!.indexOf("intention-hint"),
      );

      await handlers.onAgentEnd(
        { messages: [], success: true },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      const final = store.sessions.get("discord:direct:123");
      expect(final?.lastRenderedContent).toContain("🧩 active-memory: ✔");
      expect(final?.lastRenderedContent).toContain("intention-hint");
      expect(
        final!.lastRenderedContent!.indexOf("🧩 active-memory"),
      ).toBeLessThan(final!.lastRenderedContent!.indexOf("intention-hint"));
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });

    it("preserves group order when intention-hint completes before active-memory", async () => {
      const fetchMock = createDiscordFetchMock();
      isActiveMemoryEnabled.mockReturnValue(true);
      isIntentionHintEnabled.mockReturnValue(true);

      await handlers.onMessageReceived(
        { messageId: "user_msg_1", metadata: { to: "user:123" } },
        {
          channelId: "discord",
          sessionKey: "agent:main:discord:direct:456",
          accountId: "default",
        },
      );

      const session = store.sessions.get("discord:direct:456");
      expect(session?.toolHistory.map((t) => t.toolCallId)).toEqual([
        "active-memory",
        "intention-hint",
      ]);

      await handlers.onAgentEnd(
        {
          messages: [
            {
              role: "assistant",
              content: "INTENT:RESEARCH | GOAL: docs",
            },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:456:intention-hint:xyz",
        },
      );

      const afterIh = store.sessions.get("discord:direct:456");
      const amIdx = afterIh!.toolHistory.findIndex(
        (t) =>
          t.toolName === "active-memory" ||
          t.toolName.startsWith("active-memory:"),
      );
      const ihIdx = afterIh!.toolHistory.findIndex(
        (t) =>
          t.toolName === "intention-hint" ||
          t.toolName.startsWith("intention-hint:"),
      );
      expect(amIdx).toBeLessThan(ihIdx);

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
                  arguments: { query: "test" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "mem_1",
              toolName: "memory_search",
            },
            { role: "assistant", content: "found result" },
          ],
          success: true,
        },
        {
          sessionKey: "agent:main:discord:direct:456:active-memory:abc",
        },
      );

      const final = store.sessions.get("discord:direct:456");
      const finalAmIdx = final!.toolHistory.findIndex(
        (t) =>
          t.toolName === "active-memory" ||
          t.toolName.startsWith("active-memory:"),
      );
      const finalIhIdx = final!.toolHistory.findIndex(
        (t) =>
          t.toolName === "intention-hint" ||
          t.toolName.startsWith("intention-hint:"),
      );
      expect(finalAmIdx).toBeLessThan(finalIhIdx);
    });
  });
});
