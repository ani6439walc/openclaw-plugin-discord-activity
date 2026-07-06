import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPlugin } from "./plugin.js";
import type { OpenClawPluginApi } from "../api.js";

describe("plugin", () => {
  let mockApi: OpenClawPluginApi;
  let consoleSpy: any;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockApi = {
      on: vi.fn(),
      config: {
        channels: {
          discord: {
            token: "test-token",
          },
        },
        plugins: {
          entries: {
            "active-memory": {
              enabled: true,
              config: { agents: ["test-agent"] },
            },
            "skill-harness": {
              enabled: true,
              config: { agents: ["test-agent"] },
            },
          },
        },
      },
      pluginConfig: {},
      agent: {
        events: {
          registerAgentEventSubscription: vi.fn(),
        },
      },
    };
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("should create plugin successfully", () => {
    const plugin = createPlugin(mockApi);
    expect(plugin).toBeDefined();
    expect(plugin.id).toBe("discord-tool-status");
    expect(typeof plugin.register).toBe("function");
  });

  it("should register event handlers", () => {
    const plugin = createPlugin(mockApi);
    plugin.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledTimes(6);
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
      "before_agent_reply",
      expect.any(Function),
    );
    expect(mockApi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(
      mockApi.agent.events.registerAgentEventSubscription,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "discord-tool-status:skill-harness-pipeline",
        streams: ["plugin:skill-harness"],
        handle: expect.any(Function),
      }),
    );
  });

  it("registers core handlers without agent event subscriptions", () => {
    mockApi.agent = undefined as never;
    const plugin = createPlugin(mockApi);

    expect(() => plugin.register(mockApi)).not.toThrow();
    expect(mockApi.on).toHaveBeenCalledTimes(6);
  });
});
