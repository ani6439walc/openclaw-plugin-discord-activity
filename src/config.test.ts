import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_SECONDS,
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  DEFAULT_ORPHAN_TTL_SECONDS,
  resolveConfig,
  THINKING_LEVELS,
} from "./config.js";

const DEFAULT_CONFIG = {
  maxToolHistoryLength: DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  maxStatusMessageLength: DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  orphanTtlSeconds: DEFAULT_ORPHAN_TTL_SECONDS,
  maxDisplaySeconds: DEFAULT_MAX_DISPLAY_SECONDS,
  replyMode: "all",
};

describe("resolveConfig", () => {
  it("accepts a top-level Jev fallback with an environment SecretRef", () => {
    const decisionModel = {
      baseUrl: "https://bifrost.home-infra.weii.cloud/typesafe",
      apiKey: {
        source: "env",
        provider: "default",
        id: "BIFROST_VIRTUAL_KEY_OPENCLAW",
      },
      model: "jev-latest",
    };
    expect(resolveConfig({ decisionModel }).decisionModel).toEqual(
      decisionModel,
    );
    expect(
      resolveConfig({ decisionModel: { model: "jev-latest" } }).decisionModel,
    ).toBeUndefined();
  });

  it("keeps semantic reactions disabled unless explicitly enabled", () => {
    expect(resolveConfig({}).messageReaction).toBeUndefined();
    expect(
      resolveConfig({ messageReaction: {} }).messageReaction?.enabled,
    ).toBe(false);
    expect(
      resolveConfig({ messageReaction: { enabled: true } }).messageReaction,
    ).toEqual({ enabled: true });
  });

  it("distinguishes an omitted emoji list from an empty override", () => {
    expect(
      resolveConfig({ messageReaction: { enabled: true } }).messageReaction
        ?.emojis,
    ).toBeUndefined();
    expect(
      resolveConfig({ messageReaction: { enabled: true, emojis: [] } })
        .messageReaction?.emojis,
    ).toEqual([]);
  });

  it("accepts Unicode emoji entries and drops invalid candidates", () => {
    expect(
      resolveConfig({
        messageReaction: {
          enabled: true,
          emojis: ["👍", { emoji: "🧑‍💻", meaning: "coding" }, "hello", "😀😀"],
        },
      }).messageReaction?.emojis,
    ).toEqual(["👍", { emoji: "🧑‍💻", meaning: "coding" }]);
  });

  it("returns defaults for an empty config object", () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("uses seconds configuration and ignores retired millisecond fields", () => {
    expect(
      resolveConfig({
        orphanTtlSeconds: 90,
        maxDisplaySeconds: 45,
        orphanTtlMs: 90_000,
        maxDisplayMs: 45_000,
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      orphanTtlSeconds: 90,
      maxDisplaySeconds: 45,
    });
  });

  it("does not accept retired millisecond configuration fields", () => {
    expect(
      resolveConfig({
        orphanTtlMs: 90_000,
        maxDisplayMs: 45_000,
      }),
    ).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults for non-object config values", () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig("invalid")).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig(0)).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig([])).toEqual(DEFAULT_CONFIG);
  });

  it("fills missing fields with defaults", () => {
    expect(resolveConfig({ maxToolHistoryLength: 12 })).toEqual({
      ...DEFAULT_CONFIG,
      maxToolHistoryLength: 12,
    });
  });

  it("falls back field-by-field for invalid primitive values", () => {
    expect(
      resolveConfig({
        maxToolHistoryLength: 0,
        maxStatusMessageLength: "1700",
        orphanTtlSeconds: null,
        maxDisplaySeconds: 0,
      }),
    ).toEqual(DEFAULT_CONFIG);
  });

  it("preserves valid partial overrides", () => {
    expect(
      resolveConfig({
        maxToolHistoryLength: 25,
        maxDisplaySeconds: 30,
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      maxToolHistoryLength: 25,
      maxDisplaySeconds: 30,
    });
  });

  it("accepts valid reply modes and falls back per-field for invalid values", () => {
    expect(resolveConfig({ replyMode: "all", maxDisplaySeconds: 30 })).toEqual({
      ...DEFAULT_CONFIG,
      maxDisplaySeconds: 30,
    });

    expect(
      resolveConfig({ replyMode: "direct", maxDisplaySeconds: 30 }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      replyMode: "direct",
      maxDisplaySeconds: 30,
    });

    expect(resolveConfig({ replyMode: 42, maxDisplaySeconds: 30 })).toEqual({
      ...DEFAULT_CONFIG,
      maxDisplaySeconds: 30,
    });

    expect(
      resolveConfig({ replyMode: "unsupported", maxDisplaySeconds: 30 }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      maxDisplaySeconds: 30,
    });
  });

  it("parses skillLearnedNotice model and promptAppend", () => {
    expect(
      resolveConfig({
        skillLearnedNotice: {
          model: " bifrost/gpt-6-luna ",
          promptAppend: " 用中文寫摘要 ",
        },
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      skillLearnedNotice: {
        model: "bifrost/gpt-6-luna",
        promptAppend: "用中文寫摘要",
      },
    });
    expect(resolveConfig({}).skillLearnedNotice).toBeUndefined();
  });

  it("accepts each thinking level and drops anything else", () => {
    for (const level of THINKING_LEVELS) {
      expect(
        resolveConfig({ skillLearnedNotice: { thinking: level } }),
      ).toEqual({ ...DEFAULT_CONFIG, skillLearnedNotice: { thinking: level } });
    }
    for (const bad of ["Low", "extreme", "", 3, null]) {
      expect(
        resolveConfig({
          skillLearnedNotice: { thinking: bad, model: "bifrost/gpt-6-luna" },
        }).skillLearnedNotice,
      ).toEqual({ model: "bifrost/gpt-6-luna" });
    }
  });

  it("drops invalid skillLearnedNotice fields one by one", () => {
    expect(
      resolveConfig({
        skillLearnedNotice: { model: 42, promptAppend: "  " },
        maxDisplaySeconds: 30,
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      maxDisplaySeconds: 30,
      skillLearnedNotice: {},
    });
    expect(
      resolveConfig({ skillLearnedNotice: "bifrost/gpt-6-luna" })
        .skillLearnedNotice,
    ).toBeUndefined();
  });

  it("accepts boundary-valid numeric values", () => {
    expect(
      resolveConfig({
        maxToolHistoryLength: 1,
        maxStatusMessageLength: 100,
        orphanTtlSeconds: 1,
        maxDisplaySeconds: 1,
      }),
    ).toEqual({
      maxToolHistoryLength: 1,
      maxStatusMessageLength: 100,
      orphanTtlSeconds: 1,
      maxDisplaySeconds: 1,
      replyMode: "all",
    });

    expect(
      resolveConfig({
        maxToolHistoryLength: 50,
        maxStatusMessageLength: DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      maxToolHistoryLength: 50,
      maxStatusMessageLength: DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
    });

    expect(resolveConfig({ maxStatusMessageLength: 1701 })).toEqual(
      DEFAULT_CONFIG,
    );
  });
});
