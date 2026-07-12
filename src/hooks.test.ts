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
        "💡 skill-harness ←",
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
      expect(plainContent).toContain("🧩 active-memory ←");
      expect(plainContent).toContain("💡 skill-harness ←");
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
        "memory_search ✔",
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
        "skill_view ←",
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
        "memory_search ✔",
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
      expect(plainContent).toContain("🧩 active-memory ✔ [42ms]");
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
      expect(plainContent).toContain("🧩 active-memory ✔ [42ms]");
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
        "🚀 exec ✔ [538ms]",
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
        "🚀 exec ✔ [1.5s]",
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
        "🚀 exec ♻︎ [250ms]",
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
      expect(plainContent).toContain("bash ✘ [100ms]");
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
      expect(plainContent).toContain("🧩 active-memory ←");
      expect(plainContent).toContain("💡 skill-harness ←");
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
      const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
      expect(plainContent).toContain("🧩 active-memory ✘ [15.2s]");
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
      expect(plainContent).toContain("🧩 active-memory ✔");
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
      expect(plainContent).toContain("💡 skill-harness ✔");
      expect(plainContent).toContain("exact-keyword-hint ✔");
      expect(plainContent).toContain('keywords: ["hi","hello"]');
      expect(plainContent).toContain("topic: User is greeting.");
      expect(plainContent).toContain("result: matched greeting keyword");
      expect(plainContent).not.toContain("matchedKeyword");
      expect(plainContent).not.toContain("score:");
      expect(plainContent).toContain("reason: exact keyword matched");
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
      expect(plainContent).toContain("💡 skill-harness ✔ [1.1s]");
      expect(plainContent).toContain("topic-triage ✔ [1.1s]");
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
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

    it("does not downgrade completed skill-harness phases to pending", async () => {
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
        "💡 skill-harness ←",
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
      expect(activeMemoryContent).toContain("🧩 active-memory ✔");
      expect(activeMemoryContent).toContain("💡 skill-harness ←");
      expect(
        afterActiveMemory!.lastRenderedContent!.indexOf("🧩 active-memory"),
      ).toBeLessThan(
        afterActiveMemory!.lastRenderedContent!.indexOf("skill-harness"),
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
      expect(skillHarnessContent).toContain("🧩 active-memory ✔");
      expect(skillHarnessContent).toContain("💡 skill-harness ✔");
      expect(
        afterSkillHarness!.lastRenderedContent!.indexOf("🧩 active-memory"),
      ).toBeLessThan(
        afterSkillHarness!.lastRenderedContent!.indexOf("skill-harness"),
      );

      await handlers.onAgentEnd(
        { messages: [], success: true },
        { sessionKey: "agent:main:discord:direct:123" },
      );

      const final = store.sessions.get("discord:direct:123");
      expect(stripAnsi(final?.lastRenderedContent ?? "")).toContain(
        "🧩 active-memory ✔",
      );
      expect(final?.lastRenderedContent).toContain("skill-harness");
      expect(
        final!.lastRenderedContent!.indexOf("🧩 active-memory"),
      ).toBeLessThan(final!.lastRenderedContent!.indexOf("skill-harness"));
      expect(countChannelMessagePosts(fetchMock)).toBe(1);
    });
  });
});
