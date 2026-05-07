import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHookHandlers } from "./hooks.js";
import { createOrphanToolManager } from "./orphans.js";
import { resolveConfig } from "./config.js";
import { flushPromises } from "../test-helpers.js";
import { defaultStore } from "./session.js";

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
  let orphans: ReturnType<typeof createOrphanToolManager>;
  let getToken: ReturnType<typeof vi.fn>;
  let config: ReturnType<typeof resolveConfig>;
  let isActiveMemoryEnabled: ReturnType<typeof vi.fn>;
  let handlers: ReturnType<typeof createHookHandlers>;

  beforeEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    store = defaultStore;
    orphans = createOrphanToolManager();
    getToken = vi.fn().mockReturnValue("test-token");
    config = resolveConfig({});
    isActiveMemoryEnabled = vi.fn().mockReturnValue(true);
    handlers = createHookHandlers({
      store,
      orphans,
      getToken,
      config,
      isActiveMemoryEnabled,
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
      ).toBeGreaterThanOrEqual(3);
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
  });
});
