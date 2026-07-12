import { describe, expect, it } from "vitest";
import { parseSkillHarnessPipelineEntry } from "./skill-harness-status.js";
import type { AgentPipelineEvent } from "./types.js";

function makePipelineEvent(data: Record<string, unknown>): AgentPipelineEvent {
  return {
    runId: "run-1",
    stream: "plugin:skill-harness",
    sessionKey: "agent:main:discord:direct:123",
    data: {
      kind: "skill-harness.pipeline",
      phase: "intent-classify",
      state: "failed",
      ...data,
    },
  };
}

describe("parseSkillHarnessPipelineEntry", () => {
  it.each([
    ["reason", { reason: "legacy reason" }, "legacy reason"],
    ["result", { result: "legacy result" }, "legacy result"],
  ])("normalizes legacy failed-event %s as error", (_field, data, error) => {
    const entry = parseSkillHarnessPipelineEntry(makePipelineEvent(data));

    expect(entry).toEqual(
      expect.objectContaining({
        status: "error",
        error,
        params: { error },
      }),
    );
    expect(entry?.params).not.toHaveProperty("reason");
    expect(entry?.params).not.toHaveProperty("result");
  });

  it("prefers error over legacy failure fields", () => {
    const entry = parseSkillHarnessPipelineEntry(
      makePipelineEvent({
        error: "canonical error",
        reason: "legacy reason",
        result: "legacy result",
      }),
    );

    expect(entry?.error).toBe("canonical error");
    expect(entry?.params).toEqual({ error: "canonical error" });
  });

  it("uses the next non-empty legacy failure field", () => {
    const entry = parseSkillHarnessPipelineEntry(
      makePipelineEvent({
        error: "   ",
        reason: "  legacy reason  ",
        result: "legacy result",
      }),
    );

    expect(entry?.error).toBe("legacy reason");
    expect(entry?.params).toEqual({ error: "legacy reason" });
  });

  it("does not invent an error for failed events without detail", () => {
    const entry = parseSkillHarnessPipelineEntry(makePipelineEvent({}));

    expect(entry).toEqual(
      expect.objectContaining({
        status: "error",
        params: {},
      }),
    );
    expect(entry?.error).toBeUndefined();
  });

  it("preserves completed reason, basis, and result fields", () => {
    const entry = parseSkillHarnessPipelineEntry(
      makePipelineEvent({
        state: "completed",
        reason: "classification matched",
        basis: "explicit request",
        result: "generated hint",
        error: "stale failure",
      }),
    );

    expect(entry).toEqual(
      expect.objectContaining({
        status: "completed",
        params: {
          reason: "classification matched",
          basis: "explicit request",
          result: "generated hint",
        },
      }),
    );
    expect(entry?.error).toBeUndefined();
  });
});
