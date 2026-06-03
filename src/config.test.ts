import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_MS,
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  DEFAULT_ORPHAN_TTL_MS,
  resolveConfig,
} from "./config.js";

const DEFAULT_CONFIG = {
  maxToolHistoryLength: DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  maxStatusMessageLength: DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  orphanTtlMs: DEFAULT_ORPHAN_TTL_MS,
  maxDisplayMs: DEFAULT_MAX_DISPLAY_MS,
};

describe("resolveConfig", () => {
  it("returns defaults for an empty config object", () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
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
        orphanTtlMs: null,
        maxDisplayMs: 999,
      }),
    ).toEqual(DEFAULT_CONFIG);
  });

  it("preserves valid partial overrides", () => {
    expect(
      resolveConfig({
        maxToolHistoryLength: 25,
        maxDisplayMs: 30_000,
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      maxToolHistoryLength: 25,
      maxDisplayMs: 30_000,
    });
  });

  it("accepts boundary-valid numeric values", () => {
    expect(
      resolveConfig({
        maxToolHistoryLength: 1,
        maxStatusMessageLength: 100,
        orphanTtlMs: 1,
        maxDisplayMs: 1000,
      }),
    ).toEqual({
      maxToolHistoryLength: 1,
      maxStatusMessageLength: 100,
      orphanTtlMs: 1,
      maxDisplayMs: 1000,
    });

    expect(
      resolveConfig({
        maxToolHistoryLength: 50,
        maxStatusMessageLength: 4000,
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      maxToolHistoryLength: 50,
      maxStatusMessageLength: 4000,
    });
  });
});
