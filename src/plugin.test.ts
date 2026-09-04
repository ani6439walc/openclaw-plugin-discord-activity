import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { buildIsPluginEnabledForAgent } from "./plugin.js";

function createConfig(
  plugins: NonNullable<OpenClawConfig["plugins"]>,
): OpenClawConfig {
  return { plugins } as OpenClawConfig;
}

describe("buildIsPluginEnabledForAgent", () => {
  it("requires enabled plugin entry with matching agent config", () => {
    const isEnabled = buildIsPluginEnabledForAgent(
      createConfig({
        entries: {
          "active-memory": {
            enabled: true,
            config: { agents: ["main"] },
          },
        },
      }),
      "active-memory",
    );

    expect(isEnabled("main")).toBe(true);
    expect(isEnabled("other")).toBe(false);
  });

  it("respects deny and allow lists", () => {
    const denied = buildIsPluginEnabledForAgent(
      createConfig({
        deny: ["active-memory"],
        entries: {
          "active-memory": {
            enabled: true,
            config: { agents: ["main"] },
          },
        },
      }),
      "active-memory",
    );
    const notAllowed = buildIsPluginEnabledForAgent(
      createConfig({
        allow: ["discord-activity"],
        entries: {
          "active-memory": {
            enabled: true,
            config: { agents: ["main"] },
          },
        },
      }),
      "active-memory",
    );

    expect(denied("main")).toBe(false);
    expect(notAllowed("main")).toBe(false);
  });

  it("resolves agents from scope.agents when configured", () => {
    const isEnabled = buildIsPluginEnabledForAgent(
      createConfig({
        entries: {
          "skill-harness": {
            enabled: true,
            config: { scope: { agents: ["main", "lite"] } },
          },
        },
      }),
      "skill-harness",
    );

    expect(isEnabled("main")).toBe(true);
    expect(isEnabled("lite")).toBe(true);
    expect(isEnabled("other")).toBe(false);
  });

  it("defaults to main agent for skill-harness when agent scope is omitted", () => {
    const isEnabled = buildIsPluginEnabledForAgent(
      createConfig({
        entries: {
          "skill-harness": {
            enabled: true,
            config: {},
          },
        },
      }),
      "skill-harness",
    );

    expect(isEnabled("main")).toBe(true);
    expect(isEnabled("other")).toBe(false);
  });
});
