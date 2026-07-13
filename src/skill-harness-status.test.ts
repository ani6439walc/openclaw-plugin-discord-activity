import { describe, expect, it } from "vitest";
import {
  mergeSkillHarnessPipelineEntry,
  parseSkillHarnessPipelineEntry,
} from "./skill-harness-status.js";
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

  it("maps pipeline lifecycle events to the parent entry with producer duration", () => {
    const entry = parseSkillHarnessPipelineEntry(
      makePipelineEvent({
        phase: "pipeline",
        state: "completed",
        durationMs: 1_250,
      }),
    );

    expect(entry).toEqual(
      expect.objectContaining({
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        status: "completed",
        durationMs: 1_250,
      }),
    );
    expect(entry?.params).toEqual({});
  });

  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])(
    "ignores invalid producer duration %s",
    (durationMs) => {
      const entry = parseSkillHarnessPipelineEntry(
        makePipelineEvent({
          phase: "pipeline",
          state: "completed",
          durationMs,
        }),
      );

      expect(entry?.durationMs).toBeUndefined();
    },
  );
});

describe("mergeSkillHarnessPipelineEntry timing", () => {
  it("derives child duration from observed start and completion", () => {
    const started = parseSkillHarnessPipelineEntry(
      makePipelineEvent({ state: "started" }),
    )!;
    const afterStarted = mergeSkillHarnessPipelineEntry([], started, 1_000);
    const completed = parseSkillHarnessPipelineEntry(
      makePipelineEvent({ state: "completed" }),
    )!;
    const afterCompleted = mergeSkillHarnessPipelineEntry(
      afterStarted.entries,
      completed,
      2_100,
    );

    expect(afterCompleted.entries[0]).toEqual(
      expect.objectContaining({
        startedAtMs: 1_000,
        durationMs: 1_100,
      }),
    );
  });

  it("does not invent timing for completion-only child events", () => {
    const completed = parseSkillHarnessPipelineEntry(
      makePipelineEvent({ state: "completed" }),
    )!;
    const merged = mergeSkillHarnessPipelineEntry([], completed, 2_100);

    expect(merged.entries[0].startedAtMs).toBeUndefined();
    expect(merged.entries[0].durationMs).toBeUndefined();
  });

  it("prefers producer duration for the pipeline parent", () => {
    const started = parseSkillHarnessPipelineEntry(
      makePipelineEvent({ phase: "pipeline", state: "started" }),
    )!;
    const afterStarted = mergeSkillHarnessPipelineEntry([], started, 1_000);
    const completed = parseSkillHarnessPipelineEntry(
      makePipelineEvent({
        phase: "pipeline",
        state: "completed",
        durationMs: 900,
      }),
    )!;
    const afterCompleted = mergeSkillHarnessPipelineEntry(
      afterStarted.entries,
      completed,
      2_100,
    );

    expect(afterCompleted.entries[0]).toEqual(
      expect.objectContaining({
        toolCallId: "skill-harness",
        status: "completed",
        startedAtMs: 1_000,
        durationMs: 900,
      }),
    );
  });

  it("preserves the lifecycle parent while bounding child phases", () => {
    const parent = parseSkillHarnessPipelineEntry(
      makePipelineEvent({ phase: "pipeline", state: "started" }),
    )!;
    let entries = mergeSkillHarnessPipelineEntry([], parent, 1_000).entries;

    for (let index = 0; index < 7; index += 1) {
      const child = parseSkillHarnessPipelineEntry(
        makePipelineEvent({
          phase: `phase-${index}`,
          state: "completed",
        }),
      )!;
      entries = mergeSkillHarnessPipelineEntry(
        entries,
        child,
        1_100 + index,
      ).entries;
    }

    expect(entries).toHaveLength(6);
    expect(entries[0].toolCallId).toBe("skill-harness");
    expect(entries.slice(1).map((entry) => entry.toolName)).toEqual([
      "skill-harness:phase-2",
      "skill-harness:phase-3",
      "skill-harness:phase-4",
      "skill-harness:phase-5",
      "skill-harness:phase-6",
    ]);
  });
});
