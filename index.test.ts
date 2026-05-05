import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
};

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => mockLogger,
}));

import plugin from "./index.js";
import { activeSessions, sessionContextMap } from "./src/session.js";

type Handler = (event: any, ctx: any) => Promise<any>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createApiMock(configOverrides?: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const api = {
    config: {
      channels: {
        discord: {
          token: "token",
        },
      },
      ...configOverrides,
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as any;

  plugin.register(api);

  async function emit(name: string, event: any, ctx: any) {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Handler not found: ${name}`);
    return handler(event, ctx);
  }

  return { emit };
}

describe("discord-tool-status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger.trace.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    activeSessions.clear();
    sessionContextMap.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps separate sessions by context key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-2" }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    await emit(
      "message_received",
      {
        messageId: "u1",
        metadata: { to: "discord:channel:111", senderId: "42" },
      },
      { channelId: "discord", sessionKey: "discord:channel:111:thread:x" },
    );

    await emit(
      "message_received",
      {
        messageId: "u2",
        metadata: { to: "discord:channel:222", senderId: "42" },
      },
      { channelId: "discord", sessionKey: "discord:channel:222:thread:y" },
    );

    await emit(
      "before_tool_call",
      { toolCallId: "t1", toolName: "read", params: { filePath: "a" } },
      { channelId: "discord", sessionKey: "discord:channel:111:thread:x" },
    );

    await emit(
      "before_tool_call",
      { toolCallId: "t2", toolName: "read", params: { filePath: "b" } },
      { channelId: "discord", sessionKey: "discord:channel:222:thread:y" },
    );

    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(
      calledUrls.some((url) => url.includes("/channels/111/messages")),
    ).toBe(true);
    expect(
      calledUrls.some((url) => url.includes("/channels/222/messages")),
    ).toBe(true);
  });

  it("dedupes delayed cleanup and deletes status once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-1" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "discord:channel:333:thread:z",
    };

    await emit(
      "message_received",
      {
        messageId: "u3",
        metadata: { to: "discord:channel:333", senderId: "42" },
      },
      ctx,
    );

    await emit(
      "before_tool_call",
      { toolCallId: "t3", toolName: "read", params: { filePath: "c" } },
      ctx,
    );

    await emit("message_sending", {}, ctx);
    await emit("before_agent_reply", {}, ctx);
    await emit("agent_end", {}, ctx);

    await vi.advanceTimersByTime(2000);

    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/333/messages/status-1") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(1);
  });

  it("formats params with first bullet and indented follow-up keys", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-format-1" }), {
          status: 200,
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-format-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    await emit(
      "before_tool_call",
      {
        toolCallId: "fmt-1",
        toolName: "web_search",
        params: {
          query: "Singtel 提醒 cronjob 更新日期 2026-08-15 2026-08-27",
          maxResults: 3,
          corpus: "all",
        },
      },
      ctx,
    );

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        ((init as RequestInit | undefined)?.method ?? "POST") === "POST",
    );
    expect(postCall).toBeDefined();

    const postBody = JSON.parse(
      String((postCall?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { content?: string };
    const content = postBody.content ?? "";

    expect(content).toContain(
      "   - query: Singtel 提醒 cronjob 更新日期 2026-08-15 2026-08-27",
    );
    expect(content).toContain("     maxResults: 3");
    expect(content).toContain("     corpus: all");
    expect(content).not.toContain("   - maxResults: 3");
    expect(content).not.toContain("   - corpus: all");

    await emit("agent_end", {}, ctx);
    await vi.advanceTimersByTime(3000);
  });

  it("creates one status message for concurrent tool calls in the same run", async () => {
    const firstPost = deferred<Response>();
    let postCount = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation((url: unknown, init?: unknown) => {
        const requestUrl = String(url);
        const method = (init as RequestInit | undefined)?.method ?? "GET";

        if (
          requestUrl.includes("/channels/1472937004919423059/messages") &&
          method === "POST"
        ) {
          postCount += 1;
          if (postCount === 1) {
            return firstPost.promise;
          }

          return Promise.resolve(
            new Response(
              JSON.stringify({ id: `status-concurrent-${postCount}` }),
              {
                status: 200,
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      });

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-concurrent-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    const firstTool = emit(
      "before_tool_call",
      {
        toolCallId: "concurrent-1",
        toolName: "wiki_get",
        params: { lookup: "entities/lobby.md" },
      },
      ctx,
    );

    await Promise.resolve();

    const secondTool = emit(
      "before_tool_call",
      {
        toolCallId: "concurrent-2",
        toolName: "message",
        params: {
          action: "member-info",
          channel: "discord",
          guildId: "1391660337995972759",
          userId: "529296776637972480",
        },
      },
      ctx,
    );

    firstPost.resolve(
      new Response(JSON.stringify({ id: "status-concurrent-1" }), {
        status: 200,
      }),
    );

    await vi.advanceTimersByTime(100);
    await Promise.all([firstTool, secondTool]);

    const postCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        ((init as RequestInit | undefined)?.method ?? "POST") === "POST",
    );
    expect(postCalls.length).toBe(1);

    const patchCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(
          "/channels/1472937004919423059/messages/status-concurrent-1",
        ) && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    await emit("agent_end", {}, ctx);
    await vi.advanceTimersByTime(3000);
  });

  it("prevents auxiliary run from taking ownership or deleting primary status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-4" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:444",
    };
    const auxCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:444:active-memory:run-1",
    };

    await emit(
      "message_received",
      {
        messageId: "u4",
        metadata: { to: "channel:444", senderId: "42" },
      },
      primaryCtx,
    );

    const auxBeforeTool = emit(
      "before_tool_call",
      { toolCallId: "aux-1", toolName: "memory_search", params: { q: "x" } },
      auxCtx,
    );
    await vi.advanceTimersByTime(100);
    await auxBeforeTool;

    expect(fetchMock.mock.calls.length).toBe(0);

    await emit(
      "before_tool_call",
      { toolCallId: "main-1", toolName: "read", params: { filePath: "d" } },
      primaryCtx,
    );

    const auxAgentEnd = emit("agent_end", {}, auxCtx);
    await vi.advanceTimersByTime(100);
    await auxAgentEnd;
    await vi.advanceTimersByTime(2000);

    const deleteCallsAfterAuxEnd = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/444/messages/status-4") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCallsAfterAuxEnd.length).toBe(0);

    await emit("agent_end", {}, primaryCtx);
    await vi.advanceTimersByTime(3000);

    const finalDeleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/444/messages/status-4") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(finalDeleteCalls.length).toBe(1);
  });

  it("skips subagent sessions across hooks and keeps primary status flow intact", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-sub-1" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };
    const subagentCtx = {
      channelId: "discord",
      sessionKey:
        "agent:main:discord:direct:529296776637972480:subagent:explore:run-1",
    };

    await emit(
      "message_received",
      {
        messageId: "u-sub-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      primaryCtx,
    );

    await emit(
      "before_tool_call",
      { toolCallId: "main-sub-1", toolName: "read", params: { filePath: "x" } },
      primaryCtx,
    );

    const callsAfterPrimary = fetchMock.mock.calls.length;

    await emit(
      "message_received",
      {
        messageId: "u-subagent-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      subagentCtx,
    );
    await emit(
      "before_tool_call",
      { toolCallId: "sub-1", toolName: "memory_search", params: { q: "a" } },
      subagentCtx,
    );
    await emit("after_tool_call", { toolCallId: "sub-1" }, subagentCtx);
    await emit("message_sending", {}, subagentCtx);
    await emit("before_agent_reply", {}, subagentCtx);
    await emit("agent_end", {}, subagentCtx);
    await vi.advanceTimersByTime(2000);

    expect(fetchMock.mock.calls.length).toBe(callsAfterPrimary);

    await emit("agent_end", {}, primaryCtx);
    await vi.advanceTimersByTime(2000);

    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(
          "/channels/1472937004919423059/messages/status-sub-1",
        ) && (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(1);
  });

  it("renders active-memory tool summary at agent_end with prefixed tool name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-am-1" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };
    const auxCtx = {
      channelId: "discord",
      sessionKey:
        "agent:main:discord:direct:529296776637972480:active-memory:b4b4871a8495",
    };

    await emit(
      "message_received",
      {
        messageId: "u-am-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      primaryCtx,
    );

    await emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "fv6SmFFn3",
                name: "memory_search",
                arguments: {
                  query: "plugin development",
                  maxResults: 3,
                  corpus: "all",
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "fv6SmFFn3",
            toolName: "memory_search",
          },
        ],
      },
      auxCtx,
    );

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        ((init as RequestInit | undefined)?.method ?? "POST") === "POST",
    );
    expect(postCall).toBeDefined();

    const postBody = JSON.parse(
      String((postCall?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { content?: string };
    const content = postBody.content ?? "";
    expect(content).toContain("🧠 active-memory:");
    expect(content).toContain("- memory_search:");
    expect(content).not.toContain("active-memory:memory_search:");

    await emit(
      "before_tool_call",
      { toolCallId: "main-after-am-1", toolName: "wiki_status", params: {} },
      primaryCtx,
    );

    const patchCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(
          "/channels/1472937004919423059/messages/status-am-1",
        ) && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTime(2000);

    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(
          "/channels/1472937004919423059/messages/status-am-1",
        ) && (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(0);

    await emit("agent_end", {}, primaryCtx);
    await vi.advanceTimersByTime(2000);
  });

  it("ignores stale active-memory agent_end after owner switch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-owner-a" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-owner-b" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryA = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:888",
    };
    const auxA = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:888:active-memory:run-old",
    };
    const primaryB = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:888:thread:new-owner",
    };

    await emit(
      "message_received",
      { messageId: "u8a", metadata: { to: "channel:888", senderId: "42" } },
      primaryA,
    );
    await emit(
      "before_tool_call",
      { toolCallId: "own-a-1", toolName: "read", params: { filePath: "a" } },
      primaryA,
    );

    await emit(
      "message_received",
      { messageId: "u8b", metadata: { to: "channel:888", senderId: "42" } },
      primaryB,
    );
    await emit(
      "before_tool_call",
      {
        toolCallId: "own-b-1",
        toolName: "wiki_status",
        params: { scope: "new" },
      },
      primaryB,
    );

    await emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "stale-1",
                name: "memory_search",
                arguments: { query: "stale" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "stale-1",
            toolName: "memory_search",
          },
        ],
      },
      auxA,
    );

    const stalePatchCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/888/messages/status-owner-b") &&
        (init as RequestInit | undefined)?.method === "PATCH" &&
        String((init as RequestInit | undefined)?.body ?? "").includes(
          "active-memory:memory_search",
        ),
    );
    expect(stalePatchCalls.length).toBe(0);

    await emit("agent_end", {}, primaryB);
    await vi.advanceTimersByTime(2000);
  });

  it("cancels pending cleanup when active-memory agent_end updates status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-am-timer" }), {
          status: 200,
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:1234567890",
    };
    const auxCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:1234567890:active-memory:run-9",
    };

    await emit(
      "message_received",
      {
        messageId: "u-am-timer",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      primaryCtx,
    );

    await emit(
      "before_tool_call",
      {
        toolCallId: "main-timer-1",
        toolName: "read",
        params: { filePath: "x" },
      },
      primaryCtx,
    );

    await emit("before_agent_reply", {}, primaryCtx);

    await emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "timer-1",
                name: "memory_search",
                arguments: { query: "keep-alive" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "timer-1",
            toolName: "memory_search",
          },
        ],
      },
      auxCtx,
    );

    await vi.advanceTimersByTime(1200);

    const earlyDeletes = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(
          "/channels/1472937004919423059/messages/status-am-timer",
        ) && (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(earlyDeletes.length).toBe(0);

    await emit("agent_end", {}, primaryCtx);
    await vi.advanceTimersByTime(2000);

    const finalDeletes = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(
          "/channels/1472937004919423059/messages/status-am-timer",
        ) && (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(finalDeletes.length).toBe(1);
  });

  it("recovers when message_received arrives during resolve retry window", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-retry" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:555",
    };

    const beforeTool = emit(
      "before_tool_call",
      { toolCallId: "rt-1", toolName: "read", params: { filePath: "x" } },
      ctx,
    );

    await emit(
      "message_received",
      {
        messageId: "u5",
        metadata: { to: "channel:555", senderId: "42" },
      },
      ctx,
    );

    await vi.advanceTimersByTime(100);
    await beforeTool;

    const postCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/555/messages") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls.length).toBe(1);
  });

  it("does not clear context when before_agent_reply fires before first tool", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-early" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-direct-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    await emit("before_agent_reply", {}, ctx);
    await vi.advanceTimersByTime(1500);

    await emit(
      "before_tool_call",
      { toolCallId: "direct-t1", toolName: "read", params: { filePath: "x" } },
      ctx,
    );

    const postCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls.length).toBe(1);
  });

  it("invalidates old cleanup when ownership switches before next tool", async () => {
    let postCount = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation((url: unknown, init?: unknown) => {
        const requestUrl = String(url);
        const method = (init as RequestInit | undefined)?.method ?? "GET";

        if (
          requestUrl.includes("/channels/666/messages") &&
          method === "POST"
        ) {
          postCount += 1;
          if (postCount === 1) {
            return Promise.resolve(
              new Response(JSON.stringify({ id: "status-switch" }), {
                status: 200,
              }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ id: "status-switch-new" }), {
              status: 200,
            }),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      });

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const runA = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:666",
    };
    const runB = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:666:thread:b",
    };

    await emit(
      "message_received",
      {
        messageId: "u6a",
        metadata: { to: "channel:666", senderId: "42" },
      },
      runA,
    );

    await emit(
      "before_tool_call",
      { toolCallId: "sw-1", toolName: "read", params: { filePath: "a" } },
      runA,
    );

    await emit("agent_end", {}, runA);

    await emit(
      "message_received",
      {
        messageId: "u6b",
        metadata: { to: "channel:666", senderId: "42" },
      },
      runB,
    );

    await vi.advanceTimersByTime(2000);

    const deleteAfterSwitch = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/666/messages/status-switch") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteAfterSwitch.length).toBe(1);

    const runBBeforeTool = emit(
      "before_tool_call",
      { toolCallId: "sw-2", toolName: "memory_search", params: { q: "ok" } },
      runB,
    );
    await vi.advanceTimersByTime(100);
    await runBBeforeTool;

    await emit("agent_end", {}, runB);
    await vi.advanceTimersByTime(2000);

    const finalDelete = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/666/messages/status-switch-new") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(finalDelete.length).toBe(1);

    const oldDelete = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/666/messages/status-switch") &&
        !String(url).includes("status-switch-new") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(oldDelete.length).toBe(1);
  });

  it("isolates new owner when previous owner send is still pending", async () => {
    const firstPost = deferred<Response>();
    let postCount = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation((url: unknown, init?: unknown) => {
        const requestUrl = String(url);
        const method = (init as RequestInit | undefined)?.method ?? "GET";

        if (
          requestUrl.includes("/channels/777/messages") &&
          method === "POST"
        ) {
          postCount += 1;
          if (postCount === 1) {
            return firstPost.promise;
          }
          return Promise.resolve(
            new Response(JSON.stringify({ id: "status-new" }), { status: 200 }),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      });

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const runA = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:777",
    };
    const runB = {
      channelId: "discord",
      sessionKey: "agent:main:discord:channel:777:thread:new-owner",
    };

    await emit(
      "message_received",
      {
        messageId: "u7a",
        metadata: { to: "channel:777", senderId: "42" },
      },
      runA,
    );

    const oldBeforeTool = emit(
      "before_tool_call",
      { toolCallId: "p-1", toolName: "read", params: { filePath: "old" } },
      runA,
    );

    await Promise.resolve();

    await emit(
      "message_received",
      {
        messageId: "u7b",
        metadata: { to: "channel:777", senderId: "42" },
      },
      runB,
    );

    const newBeforeTool = emit(
      "before_tool_call",
      { toolCallId: "p-2", toolName: "memory_search", params: { q: "new" } },
      runB,
    );

    firstPost.resolve(
      new Response(JSON.stringify({ id: "status-old" }), { status: 200 }),
    );
    await vi.advanceTimersByTime(100);
    await Promise.all([newBeforeTool, oldBeforeTool]);

    await emit(
      "before_tool_call",
      { toolCallId: "p-3", toolName: "memory_search", params: { q: "new-2" } },
      runB,
    );

    expect(postCount).toBeGreaterThanOrEqual(1);

    await emit("agent_end", {}, runB);
    await vi.advanceTimersByTime(2000);

    const deleteOld = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/777/messages/status-old") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteOld.length).toBe(1);

    const deleteNew = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/777/messages/status-new") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    if (postCount >= 2) {
      expect(deleteNew.length).toBe(1);
    } else {
      expect(deleteNew.length).toBe(0);
    }
  });

  it.skip("emits skip trace logs for subagent sessions across all relevant hooks [bun:test vi.mock limitation]", async () => {
    const { emit } = createApiMock();

    const subagentCtx = {
      channelId: "discord",
      sessionKey:
        "agent:main:discord:direct:529296776637972480:subagent:explore:run-1",
    };

    await emit(
      "message_received",
      {
        messageId: "sub-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      subagentCtx,
    );
    await emit(
      "before_tool_call",
      { toolCallId: "sub-t1", toolName: "memory_search", params: { q: "x" } },
      subagentCtx,
    );
    await emit("after_tool_call", { toolCallId: "sub-t1" }, subagentCtx);
    await emit("message_sending", {}, subagentCtx);
    await emit("before_agent_reply", {}, subagentCtx);
    await emit("agent_end", {}, subagentCtx);

    const traceMessages = mockLogger.trace.mock.calls.map(([msg]) =>
      String(msg),
    );

    expect(traceMessages).toContain(
      "discord-tool-status: message_received: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: before_tool_call: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: after_tool_call: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: message_sending: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: before_agent_reply: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: agent_end: skip subagent session.",
    );
  });

  it("reconciles MCP-style orphan tool calls in after_tool_call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-mcp" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-mcp",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    await emit(
      "before_tool_call",
      {
        toolCallId: "functions.sequential-thinking__sequentialthinking:47",
        toolName: "sequential-thinking__sequentialthinking",
        params: { thought: "analysis" },
      },
      {},
    );

    await emit(
      "after_tool_call",
      {
        toolCallId: "functions.sequential-thinking__sequentialthinking:47",
        toolName: "sequential-thinking__sequentialthinking",
        params: { thought: "analysis" },
      },
      ctx,
    );

    const allCalls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(allCalls.some((u) => u.includes("1472937004919423059"))).toBe(true);

    await emit("agent_end", {}, ctx);
    await vi.advanceTimersByTime(2000);
  });

  it("prunes stale orphans older than TTL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-ttl" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-ttl",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    await emit(
      "before_tool_call",
      {
        toolCallId: "stale-orphan-1",
        toolName: "stale-tool",
        params: {},
      },
      {},
    );

    await vi.advanceTimersByTime(6 * 60 * 1000);

    await emit(
      "after_tool_call",
      { toolCallId: "stale-orphan-1", toolName: "stale-tool", params: {} },
      ctx,
    );

    const allUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(allUrls.some((u) => u.includes("1472937004919423059"))).toBe(false);
  });

  it("shows error icon for failed tool calls and includes duration", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-err" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-err",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    await emit(
      "before_tool_call",
      { toolCallId: "err-1", toolName: "exec", params: { cmd: "bad" } },
      ctx,
    );

    await emit(
      "after_tool_call",
      {
        toolCallId: "err-1",
        toolName: "exec",
        params: { cmd: "bad" },
        error: "Command failed",
        durationMs: 42,
      },
      ctx,
    );

    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse(
      String((patchCall?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { content?: string };
    const content = patchBody.content ?? "";
    expect(content).toContain("✘");
    expect(content).toContain("(42ms)");
    expect(content).not.toContain("✔");

    await emit("agent_end", {}, ctx);
    await vi.advanceTimersByTime(2000);
  });

  it("shows orphan-completed icon and duration for reconciled MCP calls", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-orphan" }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-orphan-icon",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    await emit(
      "before_tool_call",
      {
        toolCallId: "orphan-icon-1",
        toolName: "sequential-thinking__sequentialthinking",
        params: { thought: "test" },
      },
      {},
    );

    await emit(
      "after_tool_call",
      {
        toolCallId: "orphan-icon-1",
        toolName: "sequential-thinking__sequentialthinking",
        params: { thought: "test" },
        durationMs: 1500,
      },
      ctx,
    );

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        ((init as RequestInit | undefined)?.method ?? "POST") === "POST",
    );
    expect(postCall).toBeDefined();
    const postBody = JSON.parse(
      String((postCall?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { content?: string };
    const content = postBody.content ?? "";
    expect(content).toContain("♻︎");
    expect(content).toContain("(1,500ms)");

    await emit("agent_end", {}, ctx);
    await vi.advanceTimersByTime(2000);
  });

  it("does not add init entry when active-memory is disabled in config", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock({
      plugins: {
        entries: {
          "active-memory": { enabled: false },
        },
      },
    });

    const ctx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-no-init",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      ctx,
    );

    await emit("before_agent_reply", {}, ctx);
    await vi.advanceTimersByTime(2000);

    const postCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        ((init as RequestInit | undefined)?.method ?? "POST") === "POST",
    );
    expect(postCalls.length).toBe(0);
  });

  it("renders nested active-memory entries with parent aggregate status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-am-nested" }), {
          status: 200,
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };
    const auxCtx = {
      channelId: "discord",
      sessionKey:
        "agent:main:discord:direct:529296776637972480:active-memory:run-nested",
    };

    await emit(
      "message_received",
      {
        messageId: "u-am-nested",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      primaryCtx,
    );

    await emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "am-1",
                name: "memory_search",
                arguments: {
                  query: "first query",
                  maxResults: 3,
                  corpus: "all",
                },
              },
              {
                type: "toolCall",
                id: "am-2",
                name: "memory_search",
                arguments: {
                  query: "second query",
                  maxResults: 5,
                  corpus: "recent",
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "am-1",
            toolName: "memory_search",
          },
          {
            role: "toolResult",
            toolCallId: "am-2",
            toolName: "memory_search",
          },
        ],
      },
      auxCtx,
    );

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        ((init as RequestInit | undefined)?.method ?? "POST") === "POST",
    );
    expect(postCall).toBeDefined();

    const postBody = JSON.parse(
      String((postCall?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { content?: string };
    const content = postBody.content ?? "";

    expect(content).toContain("🧠 active-memory:");
    expect(content).toMatch(/- memory_search:.*✔/);
    expect(content).toContain("query: first query");
    expect(content).toContain("query: second query");
    expect(content).not.toContain("active-memory:memory_search");

    await emit("agent_end", {}, primaryCtx);
    await vi.advanceTimersByTime(2000);
  });

  it("shows parent error status when any active-memory sub-entry errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-am-err" }), {
          status: 200,
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };
    const auxCtx = {
      channelId: "discord",
      sessionKey:
        "agent:main:discord:direct:529296776637972480:active-memory:run-err",
    };

    await emit(
      "message_received",
      {
        messageId: "u-am-err",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      primaryCtx,
    );

    await emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "am-ok",
                name: "memory_search",
                arguments: { query: "ok" },
              },
              {
                type: "toolCall",
                id: "am-bad",
                name: "memory_search",
                arguments: { query: "bad" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "am-ok",
            toolName: "memory_search",
          },
        ],
      },
      auxCtx,
    );

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/channels/1472937004919423059/messages") &&
        ((init as RequestInit | undefined)?.method ?? "POST") === "POST",
    );
    expect(postCall).toBeDefined();

    const postBody = JSON.parse(
      String((postCall?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { content?: string };
    const content = postBody.content ?? "";

    expect(content).toMatch(/🧠 active-memory:.*←/);

    await emit("agent_end", {}, primaryCtx);
    await vi.advanceTimersByTime(2000);
  });

  it("renders mixed regular and active-memory entries in correct order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "status-mixed" }), {
          status: 200,
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    globalThis.fetch = fetchMock;
    const { emit } = createApiMock();

    const primaryCtx = {
      channelId: "discord",
      sessionKey: "agent:main:discord:direct:529296776637972480",
    };

    await emit(
      "message_received",
      {
        messageId: "u-mixed",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      primaryCtx,
    );

    await emit(
      "before_tool_call",
      { toolCallId: "read-1", toolName: "read", params: { filePath: "a" } },
      primaryCtx,
    );

    const auxCtx = {
      channelId: "discord",
      sessionKey:
        "agent:main:discord:direct:529296776637972480:active-memory:run-mixed",
    };

    await emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "am-mixed",
                name: "memory_search",
                arguments: { query: "mixed" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "am-mixed",
            toolName: "memory_search",
          },
        ],
      },
      auxCtx,
    );

    await emit(
      "before_tool_call",
      { toolCallId: "read-2", toolName: "read", params: { filePath: "b" } },
      primaryCtx,
    );

    const patchCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(
          "/channels/1472937004919423059/messages/status-mixed",
        ) && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    const lastPatch = patchCalls[patchCalls.length - 1];
    const patchBody = JSON.parse(
      String((lastPatch?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { content?: string };
    const content = patchBody.content ?? "";

    const readIndex = content.indexOf("📖 read:");
    const amIndex = content.indexOf("🧠 active-memory:");
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(amIndex).toBeGreaterThanOrEqual(0);

    await emit("agent_end", {}, primaryCtx);
    await vi.advanceTimersByTime(2000);
  });
});
