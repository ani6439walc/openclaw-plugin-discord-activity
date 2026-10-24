import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
import { createFallbackDecisionEvaluator } from "./decision-model.js";
import type { ReactionDecisionBatch } from "./message-reaction.js";

const batch: ReactionDecisionBatch = {
  state: { previousRecap: "Preparing a release", latestMessage: "Done!" },
  questions: {
    reaction: {
      type: "choice",
      instructions: "Choose a reaction",
      criteria: { none: "No reaction", emoji_0: "🎉" },
    },
  },
};

const hostConfig = {} as OpenClawPluginApi["config"];

function fallbackConfig(apiKey: unknown) {
  return resolveConfig({
    decisionModel: {
      baseUrl: "https://example.test/typesafe/v1",
      apiKey,
      model: "jev-latest",
    },
  }).decisionModel!;
}

describe("plugin decision model fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the same choice batch to the configured TypeSafe endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        model: "jev-latest",
        answers: {
          reaction: { type: "choice", choice: "emoji_0", probabilities: {} },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const evaluate = createFallbackDecisionEvaluator(
      fallbackConfig("test-key"),
      hostConfig,
    );

    expect(await evaluate(batch, new AbortController().signal)).toBe("emoji_0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/typesafe/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(options.body)).toMatchObject({
      ...batch,
      model: "jev-latest",
    });
  });

  it("resolves an allowed environment SecretRef at call time", async () => {
    vi.stubEnv("TEST_DISCORD_ACTIVITY_DECISION_KEY", "test-env-key");
    const fetchMock = vi.fn(async () =>
      Response.json({
        answers: { reaction: { type: "choice", choice: "none" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const evaluate = createFallbackDecisionEvaluator(
      fallbackConfig({
        source: "env",
        provider: "default",
        id: "TEST_DISCORD_ACTIVITY_DECISION_KEY",
      }),
      hostConfig,
    );

    expect(await evaluate(batch, new AbortController().signal)).toBe("none");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send a request when the SecretRef cannot be resolved", async () => {
    vi.stubEnv("TEST_DISCORD_ACTIVITY_DECISION_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const evaluate = createFallbackDecisionEvaluator(
      fallbackConfig({
        source: "env",
        provider: "default",
        id: "TEST_DISCORD_ACTIVITY_DECISION_KEY",
      }),
      hostConfig,
    );

    expect(await evaluate(batch, new AbortController().signal)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
