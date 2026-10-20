import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { OpenClawPluginApi } from "../api.js";

describe("plugin", () => {
  let mockApi: OpenClawPluginApi;

  beforeEach(() => {
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

    expect(mockApi.on).toHaveBeenCalledTimes(9);
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
