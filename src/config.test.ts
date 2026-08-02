import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_SECONDS,
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  DEFAULT_ORPHAN_TTL_SECONDS,
  resolveConfig,
} from "./config.js";

const DEFAULT_CONFIG = {
  maxToolHistoryLength: DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  maxStatusMessageLength: DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  orphanTtlSeconds: DEFAULT_ORPHAN_TTL_SECONDS,
  maxDisplaySeconds: DEFAULT_MAX_DISPLAY_SECONDS,
};

describe("resolveConfig", () => {
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
