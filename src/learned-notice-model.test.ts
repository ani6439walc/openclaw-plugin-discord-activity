import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveLearnedNoticeModel } from "./learned-notice-model.js";

function config(defaultsUtility?: unknown): OpenClawConfig {
  return {
    agents: { defaults: { utilityModel: defaultsUtility } },
  } as unknown as OpenClawConfig;
}

describe("resolveLearnedNoticeModel", () => {
  const agentUtility = (value: unknown) =>
    vi.fn(() => (value === undefined ? {} : { utilityModel: value }));

  it("prefers the plugin's configured model", () => {
    const resolveAgentConfig = agentUtility("bifrost/agent-utility");
    expect(
      resolveLearnedNoticeModel({
        configured: "bifrost/gpt-6-luna",
        cfg: config("bifrost/default-utility"),
        agentId: "main",
        resolveAgentConfig,
      }),
    ).toBe("bifrost/gpt-6-luna");
    expect(resolveAgentConfig).not.toHaveBeenCalled();
  });

  it("falls back to the agent's utility model, then the default one", () => {
    expect(
      resolveLearnedNoticeModel({
        cfg: config("bifrost/default-utility"),
        agentId: "main",
        resolveAgentConfig: agentUtility(" bifrost/agent-utility "),
      }),
    ).toBe("bifrost/agent-utility");
    expect(
      resolveLearnedNoticeModel({
        cfg: config("bifrost/default-utility"),
        agentId: "main",
        resolveAgentConfig: agentUtility(undefined),
      }),
    ).toBe("bifrost/default-utility");
    expect(
      resolveLearnedNoticeModel({
        cfg: config("bifrost/default-utility"),
        resolveAgentConfig: agentUtility("bifrost/agent-utility"),
      }),
    ).toBe("bifrost/default-utility");
  });

  it("uses the host default when utility routing is disabled or automatic", () => {
    // An agent's empty utility model disables routing and wins over the default.
    expect(
      resolveLearnedNoticeModel({
        cfg: config("bifrost/default-utility"),
        agentId: "main",
        resolveAgentConfig: agentUtility(""),
      }),
    ).toBeUndefined();
    expect(
      resolveLearnedNoticeModel({
        cfg: config("  "),
        agentId: "main",
        resolveAgentConfig: agentUtility(undefined),
      }),
    ).toBeUndefined();
    expect(
      resolveLearnedNoticeModel({
        cfg: config(undefined),
        agentId: "main",
        resolveAgentConfig: agentUtility(undefined),
      }),
    ).toBeUndefined();
  });
});
