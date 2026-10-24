import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { OpenClawPluginApi } from "../api.js";

describe("plugin", () => {
  let mockApi: OpenClawPluginApi;

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mockApi = {
      on: vi.fn(),
      config: {
        channels: {
          discord: {
            token: "test-token",
          },
        },
      },
      pluginConfig: {},
      agent: {
        events: {
          registerAgentEventSubscription: vi.fn(),
        },
      },
    } as unknown as OpenClawPluginApi;
  });

  it("registers the default entry with the api passed to register", () => {
    expect(plugin.id).toBe("discord-activity");
    expect(typeof plugin.register).toBe("function");

    plugin.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledTimes(11);
    expect(mockApi.on).toHaveBeenCalledWith(
      "gateway_stop",
      expect.any(Function),
    );
    expect(mockApi.on).toHaveBeenCalledWith(
      "message_received",
      expect.any(Function),
    );
    expect(mockApi.on).toHaveBeenCalledWith(
      "before_tool_call",
      expect.any(Function),
    );
    expect(mockApi.on).toHaveBeenCalledWith(
      "after_tool_call",
      expect.any(Function),
    );
    expect(mockApi.on).toHaveBeenCalledWith(
      "message_sending",
      expect.any(Function),
    );
    expect(mockApi.on).toHaveBeenCalledWith(
      "message_sending",
      expect.any(Function),
      { timeoutMs: 60_000 },
    );
    expect(mockApi.on).toHaveBeenCalledWith(
      "before_agent_reply",
      expect.any(Function),
      { eligibleTriggers: ["user"] },
    );
    expect(mockApi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(mockApi.on).toHaveBeenCalledWith(
      "before_compaction",
      expect.any(Function),
    );
    expect(mockApi.on).toHaveBeenCalledWith(
      "after_compaction",
      expect.any(Function),
    );
    expect(
      mockApi.agent.events.registerAgentEventSubscription,
    ).toHaveBeenCalledWith({
      id: "discord-activity:lifecycle",
      streams: ["lifecycle"],
      handle: expect.any(Function),
    });
    expect(
      mockApi.agent.events.registerAgentEventSubscription,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "discord-activity:skill-harness-pipeline",
        streams: ["plugin:skill-harness"],
        handle: expect.any(Function),
      }),
    );
    expect(
      mockApi.agent.events.registerAgentEventSubscription,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "discord-activity:hindsight-memory-pipeline",
        streams: ["plugin:hindsight-memory"],
        handle: expect.any(Function),
      }),
    );
  });

  it("omits the reaction hook when explicitly disabled", () => {
    mockApi.pluginConfig = {
      messageReaction: { enabled: false },
    };
    plugin.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledTimes(9);
    expect(
      (mockApi.on as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([name]) => name === "message_received",
      ),
    ).toHaveLength(1);
    expect(mockApi.on).not.toHaveBeenCalledWith(
      "gateway_stop",
      expect.any(Function),
    );
  });

  it("uses the global Jev decision model for Discord channel messages", async () => {
    const evaluate = vi.fn(async () => ({
      status: "ok",
      result: {
        model: "jev-latest",
        answers: {
          reaction: { type: "choice", choice: "none", probabilities: {} },
        },
      },
      provenance: {
        providerId: "typesafe",
        rubricVersion: "1",
        runtimeGeneration: "test",
      },
    }));
    mockApi.config = {
      ...mockApi.config,
      agents: { defaults: { decisionModel: "typesafe/jev-latest" } },
    } as OpenClawPluginApi["config"];
    mockApi.pluginConfig = {
      messageReaction: { enabled: true, emojis: ["🎉"] },
    };
    mockApi.runtime = {
      agent: {
        session: { getSessionEntryAsync: vi.fn(async () => undefined) },
      },
      decisions: { evaluate },
    } as unknown as OpenClawPluginApi["runtime"];
    plugin.register(mockApi);

    const reactionHook = (
      mockApi.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([name]) => name === "message_received")?.[1] as (
      event: unknown,
      context: unknown,
    ) => void;
    reactionHook(
      { messageId: "234567890123456789", content: "Done!" },
      {
        channelId: "discord",
        conversationId: "channel:123456789012345678",
        sessionKey: "agent:main:discord:channel:123456789012345678",
      },
    );
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["secondary", "<a:hello:987654321098765432>"],
    ["secondary", ""],
    [undefined, "<a:hello:987654321098765432>"],
  ] as const)(
    "uses account %s ACK setting %s when replacing reactions",
    async (accountId, ackReaction) => {
      mockApi.config = {
        channels: {
          discord: {
            token: "default-token",
            ackReaction: "🌸",
            accounts: {
              [accountId ?? "default"]: { token: "account-token", ackReaction },
            },
          },
        },
        agents: { defaults: { decisionModel: "typesafe/jev-latest" } },
      } as OpenClawPluginApi["config"];
      mockApi.pluginConfig = { messageReaction: { emojis: ["🎉"] } };
      mockApi.runtime = {
        agent: {
          session: { getSessionEntryAsync: vi.fn(async () => undefined) },
        },
        decisions: {
          evaluate: vi.fn(async () => ({
            status: "ok",
            result: {
              answers: { reaction: { type: "choice", choice: "emoji_0" } },
            },
          })),
        },
      } as unknown as OpenClawPluginApi["runtime"];
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
        init.method === "GET"
          ? Response.json({
              reactions: [
                {
                  me: true,
                  emoji: { id: "987654321098765432", name: "hello" },
                },
              ],
            })
          : new Response(null, { status: 204 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      plugin.register(mockApi);
      const calls = (mockApi.on as ReturnType<typeof vi.fn>).mock.calls;
      const reactionHook = calls.find(
        ([name]) => name === "message_received",
      )?.[1] as (event: unknown, context: unknown) => void;
      const stop = calls.find(
        ([name]) => name === "gateway_stop",
      )?.[1] as () => void;
      reactionHook(
        { messageId: "234567890123456789", content: "Done!" },
        {
          accountId,
          channelId: "discord",
          conversationId: "channel:123456789012345678",
          sessionKey: "agent:main:discord:channel:123456789012345678",
        },
      );
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledTimes(ackReaction ? 3 : 1),
      );
      if (ackReaction) {
        expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
          "PUT",
          "GET",
          "DELETE",
        ]);
        expect(fetchMock).toHaveBeenLastCalledWith(
          `https://discord.com/api/v10/channels/123456789012345678/messages/234567890123456789/reactions/${encodeURIComponent("hello:987654321098765432")}/@me`,
          expect.objectContaining({
            method: "DELETE",
            headers: { Authorization: "Bot account-token" },
          }),
        );
      }
      stop();
    },
  );

  it("uses the plugin Jev fallback when OpenClaw has no decision model", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        answers: { reaction: { type: "choice", choice: "none" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const evaluate = vi.fn();
    mockApi.pluginConfig = {
      decisionModel: {
        baseUrl: "https://example.test/typesafe",
        apiKey: "test-key",
        model: "jev-latest",
      },
      messageReaction: { enabled: true, emojis: ["🎉"] },
    };
    mockApi.runtime = {
      agent: {
        session: { getSessionEntryAsync: vi.fn(async () => undefined) },
      },
      decisions: { evaluate },
    } as unknown as OpenClawPluginApi["runtime"];
    plugin.register(mockApi);

    const reactionHook = (
      mockApi.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([name]) => name === "message_received")?.[1] as (
      event: unknown,
      context: unknown,
    ) => void;
    reactionHook(
      { messageId: "234567890123456789", content: "Done!" },
      {
        channelId: "discord",
        conversationId: "user:123456789012345678",
        sessionKey: "agent:main:discord:direct:123456789012345678",
      },
    );
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("uses the global decision model when the agent value is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const evaluate = vi.fn(async () => ({
      status: "unavailable" as const,
      reason: "not-configured" as const,
    }));
    mockApi.config = {
      ...mockApi.config,
      agents: {
        defaults: { decisionModel: "typesafe/jev-latest" },
        entries: { main: {} },
      },
    } as OpenClawPluginApi["config"];
    mockApi.pluginConfig = {
      decisionModel: {
        baseUrl: "https://example.test/typesafe",
        apiKey: "test-key",
        model: "jev-latest",
      },
      messageReaction: { enabled: true, emojis: ["🎉"] },
    };
    mockApi.runtime = {
      agent: {
        session: { getSessionEntryAsync: vi.fn(async () => undefined) },
      },
      decisions: { evaluate },
    } as unknown as OpenClawPluginApi["runtime"];
    plugin.register(mockApi);

    const reactionHook = (
      mockApi.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([name]) => name === "message_received")?.[1] as (
      event: unknown,
      context: unknown,
    ) => void;
    reactionHook(
      { messageId: "234567890123456789", content: "Done!" },
      {
        channelId: "discord",
        conversationId: "user:123456789012345678",
        sessionKey: "agent:main:discord:direct:123456789012345678",
      },
    );
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    expect(evaluate.mock.calls[0]?.[1]).not.toHaveProperty("agentId");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the plugin fallback when the agent is empty, even with a global model", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        answers: { reaction: { type: "choice", choice: "none" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const evaluate = vi.fn();
    mockApi.config = {
      ...mockApi.config,
      agents: {
        defaults: { decisionModel: "typesafe/jev-latest" },
        entries: { main: { decisionModel: "" } },
      },
    } as OpenClawPluginApi["config"];
    mockApi.pluginConfig = {
      decisionModel: {
        baseUrl: "https://example.test/typesafe",
        apiKey: "test-key",
        model: "jev-latest",
      },
      messageReaction: { enabled: true, emojis: ["🎉"] },
    };
    mockApi.runtime = {
      agent: {
        session: { getSessionEntryAsync: vi.fn(async () => undefined) },
      },
      decisions: { evaluate },
    } as unknown as OpenClawPluginApi["runtime"];
    plugin.register(mockApi);

    const reactionHook = (
      mockApi.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([name]) => name === "message_received")?.[1] as (
      event: unknown,
      context: unknown,
    ) => void;
    reactionHook(
      { messageId: "234567890123456789", content: "Done!" },
      {
        channelId: "discord",
        conversationId: "user:123456789012345678",
        sessionKey: "agent:main:discord:direct:123456789012345678",
      },
    );
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails registration when agent event subscription is missing", () => {
    mockApi.agent = undefined as never;

    expect(() => plugin.register(mockApi)).toThrow(TypeError);
    expect(mockApi.on).toHaveBeenCalledWith(
      "before_agent_reply",
      expect.any(Function),
      { eligibleTriggers: ["user"] },
    );
  });
});
