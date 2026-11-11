import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { resetApiLogger, type OpenClawPluginApi } from "../api.js";
import { defaultStore } from "./session.js";
import { recentReactionEmojis } from "./message-reaction.js";

describe("plugin", () => {
  let mockApi: OpenClawPluginApi;

  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    recentReactionEmojis().splice(0);
    resetApiLogger();
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

  it.each([
    [{}, "medium"],
    [{ skillLearnedNotice: {} }, "medium"],
    [{ skillLearnedNotice: { thinking: "off" } }, "off"],
    [{ skillLearnedNotice: { thinking: "high" } }, "high"],
  ])(
    "passes learned-notice thinking from config %j as reasoning %s",
    async (pluginConfig, expectedThinking) => {
      const complete = vi.fn(async () => ({
        text: "🔧 Updated `alpha` to check results.",
      }));
      mockApi.pluginConfig = pluginConfig;
      mockApi.runtime = {
        llm: { complete },
      } as unknown as OpenClawPluginApi["runtime"];
      plugin.register(mockApi);
      const learnedHook = (
        mockApi.on as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        ([name, , options]) =>
          name === "message_sending" && options?.timeoutMs === 60_000,
      )?.[1];
      expect(learnedHook).toBeTypeOf("function");

      await learnedHook(
        {
          to: "channel:123",
          content:
            '💾 Learned: updated `alpha` (tweak). Say "undo" to revert this skill change.',
        },
        { channelId: "discord" },
      );

      expect(complete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ reasoning: expectedThinking }),
      );
    },
  );

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

  describe("current host config snapshots", () => {
    it("reads runtime.config.current() once per reaction, notice, and status operation", async () => {
      const logMessages: string[] = [];
      let publishedConfig = {
        channels: {
          discord: {
            token: "synthetic-token-v1",
            ackReaction: "👀",
          },
        },
        agents: {
          defaults: {
            decisionModel: "typesafe/jev-v1",
            utilityModel: "bifrost/utility-v1",
          },
          entries: {
            main: {},
          },
        },
      } as unknown as OpenClawPluginApi["config"];

      const current = vi.fn(() => publishedConfig);
      const evaluate = vi.fn(async () => ({
        status: "ok" as const,
        result: {
          model: "jev",
          answers: {
            reaction: {
              type: "choice" as const,
              choice: "emoji_0",
              probabilities: {},
            },
          },
        },
      }));
      const complete = vi.fn(async () => ({
        text: "🔧 Updated `alpha` to use the current utility model.",
      }));
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Response.json({ id: "900000000000000001" });
        }
        if (init?.method === "GET") {
          return Response.json({
            reactions: [
              { me: true, emoji: { id: null, name: "👀" } },
              { me: true, emoji: { id: null, name: "✅" } },
            ],
          });
        }
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal("fetch", fetchMock);

      mockApi.logger = {
        trace: (msg) => logMessages.push(msg),
        debug: (msg) => logMessages.push(msg),
        info: (msg) => logMessages.push(msg),
        warn: (msg) => logMessages.push(msg),
      };
      mockApi.config = {
        channels: { discord: { token: "stale-registration-token" } },
      } as OpenClawPluginApi["config"];
      mockApi.pluginConfig = {
        messageReaction: { enabled: true, emojis: ["🎉"] },
      };
      mockApi.runtime = {
        config: { current },
        agent: {
          session: { getSessionEntryAsync: vi.fn(async () => undefined) },
        },
        decisions: { evaluate },
        llm: { complete },
      } as unknown as OpenClawPluginApi["runtime"];

      plugin.register(mockApi);
      expect(current).not.toHaveBeenCalled();

      const calls = (mockApi.on as ReturnType<typeof vi.fn>).mock.calls;
      const [reactionHook, activityReceivedHook] = calls
        .filter(([name]) => name === "message_received")
        .map(([, fn]) => fn as (event: unknown, ctx: unknown) => unknown);
      const beforeToolHook = calls.find(
        ([name]) => name === "before_tool_call",
      )?.[1] as (event: unknown, ctx: unknown) => Promise<void>;
      const learnedHook = calls.find(
        ([name, , opts]) =>
          name === "message_sending" && opts?.timeoutMs === 60_000,
      )?.[1] as (
        event: unknown,
        ctx: unknown,
      ) => Promise<{ content: string } | undefined>;

      const sessionCtx = {
        channelId: "discord",
        conversationId: "channel:123456789012345678",
        sessionKey: "agent:main:discord:channel:123456789012345678",
      };

      // 1. Reaction operation: mutate published config mid-delay and verify single captured snapshot.
      reactionHook!(
        { messageId: "234567890123456789", content: "First message" },
        sessionCtx,
      );
      expect(current).toHaveBeenCalledTimes(1);

      publishedConfig = {
        channels: {
          discord: {
            token: "synthetic-token-v2",
            ackReaction: "✅",
          },
        },
        agents: {
          defaults: {
            decisionModel: "",
            utilityModel: "bifrost/utility-v2",
          },
          entries: {
            main: {
              decisionModel: "typesafe/agent-jev-v2",
              utilityModel: "bifrost/agent-utility-v2",
            },
          },
        },
      } as unknown as OpenClawPluginApi["config"];

      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      // Still 1 snapshot read for the entire first reaction operation, using v1 token and 👀 ACK.
      expect(current).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0]?.[1]).not.toHaveProperty("agentId");
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
        Authorization: "Bot synthetic-token-v1",
      });
      expect(fetchMock.mock.calls[2]?.[0]).toContain(encodeURIComponent("👀"));

      // 2. Next reaction operation sees newly published v2 config (agent decisionModel + v2 token + ✅ ACK).
      fetchMock.mockClear();
      reactionHook!(
        { messageId: "234567890123456790", content: "Second message" },
        sessionCtx,
      );
      expect(current).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(current).toHaveBeenCalledTimes(2);
      expect(evaluate.mock.calls[1]?.[1]).toMatchObject({ agentId: "main" });
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
        Authorization: "Bot synthetic-token-v2",
      });
      expect(fetchMock.mock.calls[2]?.[0]).toContain(encodeURIComponent("✅"));

      // 3. Learned notice operation picks up v2 per-agent utility model in one snapshot read.
      await learnedHook(
        {
          to: "channel:123456789012345678",
          content:
            '💾 Learned: updated `alpha` (tweak). Say "undo" to revert this skill change.',
        },
        sessionCtx,
      );
      expect(current).toHaveBeenCalledTimes(3);
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ model: "bifrost/agent-utility-v2" }),
      );

      // 4. Status operations follow credential rotation -> loss -> recovery without logging secrets.
      fetchMock.mockClear();
      await activityReceivedHook!(
        { messageId: "234567890123456791", content: "Run tool" },
        sessionCtx,
      );
      await beforeToolHook(
        {
          toolName: "web_search",
          toolCallId: "call-1",
          params: { query: "alpha" },
        },
        { sessionKey: sessionCtx.sessionKey },
      );
      await vi.waitFor(() =>
        expect(
          defaultStore.sessions.get("discord:channel:123456789012345678")
            ?.pendingOp,
        ).toBeUndefined(),
      );
      expect(current).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bot synthetic-token-v2" }),
      );

      // Credential loss fails open without throwing or logging secrets.
      publishedConfig = {
        ...publishedConfig,
        channels: { discord: { token: "" } },
      } as OpenClawPluginApi["config"];
      fetchMock.mockClear();
      await beforeToolHook(
        {
          toolName: "read",
          toolCallId: "call-2",
          params: { path: "README.md" },
        },
        { sessionKey: sessionCtx.sessionKey },
      );
      await vi.waitFor(() =>
        expect(
          defaultStore.sessions.get("discord:channel:123456789012345678")
            ?.pendingOp,
        ).toBeUndefined(),
      );
      expect(current).toHaveBeenCalledTimes(5);
      expect(fetchMock).not.toHaveBeenCalled();

      // Credential recovery resumes status edits with v3 token.
      publishedConfig = {
        ...publishedConfig,
        channels: { discord: { token: "synthetic-token-v3" } },
      } as OpenClawPluginApi["config"];
      await beforeToolHook(
        {
          toolName: "exec",
          toolCallId: "call-3",
          params: { command: "pnpm test" },
        },
        { sessionKey: sessionCtx.sessionKey },
      );
      await vi.waitFor(() =>
        expect(
          defaultStore.sessions.get("discord:channel:123456789012345678")
            ?.pendingOp,
        ).toBeUndefined(),
      );
      expect(current).toHaveBeenCalledTimes(6);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bot synthetic-token-v3" }),
      );

      for (const secret of [
        "synthetic-token-v1",
        "synthetic-token-v2",
        "synthetic-token-v3",
        "stale-registration-token",
      ]) {
        expect(logMessages.join("\n")).not.toContain(secret);
      }
    });

    it("keeps a single captured snapshot across async Learned-notice diff loading and preserves no-cascade Decision failures", async () => {
      vi.useRealTimers();
      const agentDirV1 = await fs.mkdtemp(
        path.join(os.tmpdir(), "notice-cfg-v1-"),
      );
      const agentDirV2 = await fs.mkdtemp(
        path.join(os.tmpdir(), "notice-cfg-v2-"),
      );
      try {
        await fs.mkdir(path.join(agentDirV1, "workshop-skills", "alpha"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(agentDirV1, "workshop-skills", "alpha", "SKILL.md"),
          "v1 skill body\n",
        );

        let publishedConfig = {
          channels: { discord: { token: "synthetic-token" } },
          agents: {
            defaults: { utilityModel: "bifrost/utility-v1" },
            entries: {
              main: {
                agentDir: agentDirV1,
                decisionModel: "typesafe/agent-jev",
              },
            },
          },
        } as unknown as OpenClawPluginApi["config"];

        const current = vi.fn(() => publishedConfig);
        const fallbackFetch = vi.fn();
        vi.stubGlobal("fetch", fallbackFetch);

        const complete = vi.fn(async () => ({
          text: "🔧 Created `alpha` from v1 snapshot.",
        }));
        const evaluate = vi.fn(async () => {
          throw new Error("provider failure");
        });

        // Swap published config as soon as diff reading opens the v1 directory.
        const realLstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (String(args[0]).startsWith(agentDirV1)) {
            publishedConfig = {
              channels: { discord: { token: "synthetic-token" } },
              agents: {
                defaults: { utilityModel: "bifrost/utility-v2" },
                entries: {
                  main: {
                    agentDir: agentDirV2,
                    decisionModel: "",
                  },
                },
              },
            } as unknown as OpenClawPluginApi["config"];
          }
          return realLstat(...args);
        });

        mockApi.pluginConfig = {
          decisionModel: {
            baseUrl: "https://example.test/typesafe",
            apiKey: "synthetic-fallback-key",
            model: "jev-fallback",
          },
          messageReaction: { enabled: true, emojis: ["🎉"] },
        };
        mockApi.runtime = {
          config: { current },
          agent: {
            session: { getSessionEntryAsync: vi.fn(async () => undefined) },
          },
          decisions: { evaluate },
          llm: { complete },
        } as unknown as OpenClawPluginApi["runtime"];

        plugin.register(mockApi);
        const calls = (mockApi.on as ReturnType<typeof vi.fn>).mock.calls;
        const learnedHook = calls.find(
          ([name, , opts]) =>
            name === "message_sending" && opts?.timeoutMs === 60_000,
        )?.[1] as (
          event: unknown,
          ctx: unknown,
        ) => Promise<{ content: string } | undefined>;

        await learnedHook(
          {
            to: "channel:123",
            content:
              '💾 Learned: created `alpha` (new). Say "undo" to revert this skill change.',
          },
          {
            channelId: "discord",
            sessionKey: "agent:main:discord:channel:123",
          },
        );
        // Even though publishedConfig changed to utility-v2 during collectDiffs,
        // resolveModel still uses the single v1 snapshot captured at notice start.
        expect(current).toHaveBeenCalledTimes(1);
        expect(complete).toHaveBeenCalledWith(
          expect.objectContaining({ model: "bifrost/utility-v1" }),
        );

        // Reset publishedConfig to agent decisionModel and verify provider failure does not cascade to fallback.
        vi.useFakeTimers();
        publishedConfig = {
          channels: { discord: { token: "synthetic-token" } },
          agents: {
            entries: { main: { decisionModel: "typesafe/agent-jev" } },
          },
        } as unknown as OpenClawPluginApi["config"];
        const reactionHook = calls.find(
          ([name]) => name === "message_received",
        )?.[1] as (event: unknown, ctx: unknown) => void;
        reactionHook(
          { messageId: "234567890123456799", content: "Check cascade" },
          {
            channelId: "discord",
            conversationId: "channel:123456789012345678",
            sessionKey: "agent:main:discord:channel:123456789012345678",
          },
        );
        await vi.advanceTimersByTimeAsync(5000);
        await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
        expect(fallbackFetch).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        await fs.rm(agentDirV1, { recursive: true, force: true });
        await fs.rm(agentDirV2, { recursive: true, force: true });
      }
    });
  });

  describe("instance lifecycle background context", () => {
    function createMockLifecycle(
      instanceStore: AsyncLocalStorage<string>,
      instanceId: string,
    ) {
      const controller = new AbortController();
      const disposers: Array<() => void | Promise<void>> = [];
      let retired = false;
      const lifecycle: NonNullable<OpenClawPluginApi["lifecycle"]> = {
        signal: controller.signal,
        onDispose(dispose) {
          disposers.push(dispose);
          return () => {
            const idx = disposers.indexOf(dispose);
            if (idx >= 0) disposers.splice(idx, 1);
          };
        },
        runInBackgroundContext<T>(run: () => T): T {
          if (retired) {
            const err = new Error(`Instance ${instanceId} is retired`);
            err.name = "PluginInstanceUnavailableError";
            throw err;
          }
          return instanceStore.run(instanceId, run);
        },
      };
      return {
        lifecycle,
        async dispose() {
          retired = true;
          controller.abort();
          for (const dispose of [...disposers]) {
            await dispose();
          }
        },
      };
    }

    it("cancels deferred reactions on instance disposal during delay or in-flight HTTP without borrowing a successor instance", async () => {
      const instanceStore = new AsyncLocalStorage<string>();
      const instance1 = createMockLifecycle(instanceStore, "gen-1");
      const instance2 = createMockLifecycle(instanceStore, "gen-2");

      const observedEvaluateInstances: Array<string | undefined> = [];
      const evaluate1 = vi.fn(async () => {
        observedEvaluateInstances.push(instanceStore.getStore());
        return {
          status: "ok" as const,
          result: {
            model: "jev",
            answers: {
              reaction: {
                type: "choice" as const,
                choice: "emoji_0",
                probabilities: {},
              },
            },
          },
          provenance: {
            providerId: "typesafe",
            rubricVersion: "1",
            runtimeGeneration: "gen-1",
          },
        };
      });
      const evaluate2 = vi.fn(async () => {
        throw new Error("successor instance must not be borrowed");
      });

      let inFlightReactionSignal: AbortSignal | undefined;
      let startedInFlightPut = false;
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit): Promise<Response> => {
          if (init?.method === "PUT") {
            startedInFlightPut = true;
            inFlightReactionSignal = init.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener(
                "abort",
                () =>
                  reject(
                    new DOMException(
                      "The operation was aborted.",
                      "AbortError",
                    ),
                  ),
                { once: true },
              );
            });
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const api1 = {
        ...mockApi,
        on: vi.fn(),
        lifecycle: instance1.lifecycle,
        config: {
          channels: {
            discord: { token: "synthetic-token", ackReaction: "👀" },
          },
          agents: { defaults: { decisionModel: "typesafe/jev-latest" } },
        },
        pluginConfig: {
          messageReaction: { enabled: true, emojis: ["🎉"] },
        },
        runtime: {
          agent: {
            session: { getSessionEntryAsync: vi.fn(async () => undefined) },
          },
          decisions: { evaluate: evaluate1 },
          llm: { complete: vi.fn() },
        },
      } as unknown as OpenClawPluginApi;

      const api2 = {
        ...api1,
        on: vi.fn(),
        lifecycle: instance2.lifecycle,
        runtime: {
          agent: {
            session: { getSessionEntryAsync: vi.fn(async () => undefined) },
          },
          decisions: { evaluate: evaluate2 },
          llm: { complete: vi.fn() },
        },
      } as unknown as OpenClawPluginApi;

      plugin.register(api1);
      plugin.register(api2);

      const reactionHook1 = (
        api1.on as ReturnType<typeof vi.fn>
      ).mock.calls.find(([name]) => name === "message_received")?.[1] as (
        event: unknown,
        ctx: unknown,
      ) => void;

      const sessionCtx = {
        channelId: "discord",
        conversationId: "channel:123456789012345678",
        sessionKey: "agent:main:discord:channel:123456789012345678",
      };

      // Case 1: Start message 1, reach in-flight PUT HTTP request under gen-1 context, then reload/dispose gen-1.
      reactionHook1(
        { messageId: "434567890123456781", content: "In-flight HTTP reload" },
        sessionCtx,
      );
      // Queue a second message that is still inside its 3-5s human delay when disposal fires.
      await vi.advanceTimersByTimeAsync(2000);
      reactionHook1(
        { messageId: "434567890123456782", content: "Mid-delay reload" },
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(3500);
      await vi.waitFor(() => expect(startedInFlightPut).toBe(true));
      expect(observedEvaluateInstances).toEqual(["gen-1"]);
      expect(inFlightReactionSignal?.aborted).toBe(false);

      // Dispose gen-1 while message 1 is mid-HTTP PUT and message 2 is mid-delay.
      await instance1.dispose();
      expect(inFlightReactionSignal?.aborted).toBe(true);

      // Advance past all remaining delays/deadlines: neither message 2 nor ACK cleanup runs, and gen-2 is untouched.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(evaluate1).toHaveBeenCalledTimes(1);
      expect(evaluate2).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Any stray hook call on disposed gen-1 is ignored without touching gen-2.
      reactionHook1(
        { messageId: "434567890123456783", content: "After disposal" },
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(6000);
      expect(evaluate1).toHaveBeenCalledTimes(1);
      expect(evaluate2).not.toHaveBeenCalled();

      await instance2.dispose();
    });
  });
});
