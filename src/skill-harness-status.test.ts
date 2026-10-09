import { describe, expect, it } from "vitest";
import {
  finishPendingSkillHarness,
  getSkillHarnessPipelineSessionKey,
  mergeSkillHarnessPipelineEntry,
  parseSkillHarnessPipelineEntry,
  updateSkillHarnessEntry,
} from "./skill-harness-status.js";
import type { AgentPipelineEvent, ToolEntry } from "./types.js";

function makePipelineEvent(
  phase: string,
  state: string,
  data: Record<string, unknown> = {},
): AgentPipelineEvent {
  return {
    runId: "run-1",
    stream: "plugin:skill-harness",
    sessionKey: "agent:main:discord:direct:123",
    data: {
      kind: "skill-harness.pipeline",
      phase,
      state,
      ...data,
    },
  };
}

describe("skill-harness status lifecycle", () => {
  it("initializes to pending selecting skills on pipeline started", () => {
    const event = makePipelineEvent("pipeline", "started");
    const entry = updateSkillHarnessEntry(undefined, event, 1_000);

    expect(entry).toEqual({
      toolCallId: "skill-harness",
      toolName: "skill-harness",
      status: "pending",
      startedAtMs: 1_000,
      params: {
        status: "selecting skills",
      },
    });
  });

  describe("intermediate phase status (Option A: [0.xx] badges)", () => {
    it("formats name-match with matches, confidence, and skill name", () => {
      const initial = updateSkillHarnessEntry(
        undefined,
        makePipelineEvent("pipeline", "started"),
        1_000,
      );
      const event = makePipelineEvent("name-match", "completed", {
        candidateCount: 1,
        confidence: 0.95,
        result: ["weather"],
      });
      const updated = updateSkillHarnessEntry(initial, event, 1_100);

      expect(updated?.status).toBe("pending");
      expect(updated?.params.status).toBe(
        "name-match · 1 matched (.95) (weather)",
      );
    });

    it("formats name-match with 0 matches", () => {
      const event = makePipelineEvent("name-match", "completed", {
        candidateCount: 0,
        result: [],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_100);

      expect(updated?.params.status).toBe("name-match · 0 matched");
    });

    it("formats search with candidates, confidence, and clue", () => {
      const event = makePipelineEvent("search", "completed", {
        candidateCount: 5,
        confidence: 0.43,
        reason: ["#1 travel-day"],
        result: ["travel-day", "flight-tracker"],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_200);

      expect(updated?.params.status).toBe(
        "search · 5 candidates (.43) (#1 travel-day)",
      );
    });

    it("formats search with single candidate", () => {
      const event = makePipelineEvent("search", "completed", {
        candidateCount: 1,
        confidence: 0.43,
        reason: "#1 travel-day",
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_200);

      expect(updated?.params.status).toBe(
        "search · 1 candidate (.43) (#1 travel-day)",
      );
    });

    it("formats search with 0 candidates", () => {
      const event = makePipelineEvent("search", "completed", {
        candidateCount: 0,
        result: [],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_200);

      expect(updated?.params.status).toBe("search · 0 candidates");
    });

    it("formats search with RRF score normalized to uppercase RRF: format", () => {
      const event = makePipelineEvent("search", "completed", {
        candidateCount: 6,
        confidence: 0.69,
        reason: "#1 openclaw · RRF 0.0492",
        result: ["openclaw", "setup"],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_200);

      expect(updated?.params.status).toBe(
        "search · 6 candidates (.69) (#1 openclaw, RRF: 0.0492)",
      );
    });

    it("normalizes lowercase rrf input to uppercase RRF: format", () => {
      const event = makePipelineEvent("search", "completed", {
        candidateCount: 3,
        confidence: 0.45,
        reason: "#1 travel-day · rrf 0.0367",
        result: ["travel-day"],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_200);

      expect(updated?.params.status).toBe(
        "search · 3 candidates (.45) (#1 travel-day, RRF: 0.0367)",
      );
    });

    it("formats experience-search with candidate, confidence, and clue", () => {
      const event = makePipelineEvent("experience-search", "completed", {
        candidateCount: 1,
        confidence: 0.57,
        reason: ["#1 hindsight-docs"],
        result: ["hindsight-docs"],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_300);

      expect(updated?.params.status).toBe(
        "experience · 1 candidate (.57) (#1 hindsight-docs)",
      );
    });

    it("formats experience-search with RRF score normalized to uppercase RRF: format", () => {
      const event = makePipelineEvent("experience-search", "completed", {
        candidateCount: 1,
        confidence: 0.55,
        reason: "#1 openclaw-runtime-config-introspection · RRF 0.0367",
        result: [],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_300);

      expect(updated?.params.status).toBe(
        "experience · 1 candidate (.55) (#1 openclaw-runtime-config-introspection, RRF: 0.0367)",
      );
    });

    it("formats rerank with candidates, confidence, and sources", () => {
      const event = makePipelineEvent("rerank", "completed", {
        candidateCount: 2,
        confidence: 0.92,
        reason: ["search", "experience"],
        result: ["handoff", "hindsight-docs"],
        selectedSkills: ["handoff", "hindsight-docs"],
      });
      const updated = updateSkillHarnessEntry(undefined, event, 1_400);

      expect(updated?.params.status).toBe(
        "rerank · 2 candidates (.92) (search, experience)",
      );
    });
  });

  describe("pipeline completed result (with confidence)", () => {
    it("formats completed result with multiple selected skills and confidence", () => {
      let entry = updateSkillHarnessEntry(
        undefined,
        makePipelineEvent("pipeline", "started"),
        1_000,
      );
      entry = updateSkillHarnessEntry(
        entry,
        makePipelineEvent("rerank", "completed", {
          confidence: 0.92,
          selectedSkills: ["handoff", "hindsight-docs"],
        }),
        1_400,
      );
      const completed = updateSkillHarnessEntry(
        entry,
        makePipelineEvent("pipeline", "completed", {
          durationMs: 450,
        }),
        1_450,
      );

      expect(completed).toEqual({
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        status: "completed",
        startedAtMs: 1_000,
        durationMs: 450,
        params: {
          result: "2 skills selected: handoff, hindsight-docs (.92)",
        },
      });
    });

    it("formats completed result with 1 skill and confidence", () => {
      let entry = updateSkillHarnessEntry(
        undefined,
        makePipelineEvent("pipeline", "started"),
        1_000,
      );
      entry = updateSkillHarnessEntry(
        entry,
        makePipelineEvent("name-match", "completed", {
          confidence: 0.95,
          result: ["weather"],
        }),
        1_100,
      );
      const completed = updateSkillHarnessEntry(
        entry,
        makePipelineEvent("pipeline", "completed", {
          durationMs: 150,
        }),
        1_150,
      );

      expect(completed?.status).toBe("completed");
      expect(completed?.params).toEqual({
        result: "1 skill selected: weather (.95)",
      });
    });

    it("formats completed result without confidence when omitted", () => {
      let entry = updateSkillHarnessEntry(
        undefined,
        makePipelineEvent("pipeline", "started"),
        1_000,
      );
      entry = updateSkillHarnessEntry(
        entry,
        makePipelineEvent("rerank", "completed", {
          result: ["weather"],
        }),
        1_100,
      );
      const completed = updateSkillHarnessEntry(
        entry,
        makePipelineEvent("pipeline", "completed"),
        1_200,
      );

      expect(completed?.status).toBe("completed");
      expect(completed?.params).toEqual({
        result: "1 skill selected: weather",
      });
    });

    it("formats completed result as no relevant skills when empty", () => {
      let entry = updateSkillHarnessEntry(
        undefined,
        makePipelineEvent("pipeline", "started"),
        1_000,
      );
      const completed = updateSkillHarnessEntry(
        entry,
        makePipelineEvent("pipeline", "completed", {
          durationMs: 300,
        }),
        1_300,
      );

      expect(completed?.status).toBe("completed");
      expect(completed?.params).toEqual({
        result: "no relevant skills",
      });
    });

    it("formats completed result as skipped when skipped", () => {
      const event = makePipelineEvent("pipeline", "skipped", {
        durationMs: 50,
      });
      const completed = updateSkillHarnessEntry(undefined, event, 1_050);

      expect(completed?.status).toBe("completed");
      expect(completed?.params).toEqual({
        result: "skill selection skipped",
      });
    });
  });

  describe("pipeline failure and errors", () => {
    it("handles failed pipeline event with error message", () => {
      const event = makePipelineEvent("pipeline", "failed", {
        error: "pipeline timeout",
        durationMs: 5_000,
      });
      const entry = updateSkillHarnessEntry(undefined, event, 6_000);

      expect(entry).toEqual({
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        status: "error",
        startedAtMs: 6_000,
        durationMs: 5_000,
        error: "pipeline timeout",
        params: {},
      });
    });

    it("falls back to default failure message when error is omitted", () => {
      const event = makePipelineEvent("pipeline", "failed");
      const entry = updateSkillHarnessEntry(undefined, event, 1_000);

      expect(entry?.status).toBe("error");
      expect(entry?.error).toBe("skill selection failed");
      expect(entry?.params).toEqual({});
    });

    it("ignores late events once terminal completed", () => {
      const completed = updateSkillHarnessEntry(
        undefined,
        makePipelineEvent("pipeline", "completed", { result: ["weather"] }),
        1_000,
      );
      const lateEvent = makePipelineEvent("search", "completed", {
        result: ["foo"],
      });
      const afterLate = updateSkillHarnessEntry(completed, lateEvent, 1_100);

      expect(afterLate).toBe(completed);
    });
  });
});

describe("finishPendingSkillHarness", () => {
  it("marks pending skill-harness as unavailable error and clears params", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        status: "pending",
        params: { status: "selecting skills" },
      },
      {
        toolCallId: "bash_1",
        toolName: "bash",
        status: "pending",
        params: { command: "ls" },
      },
    ];

    finishPendingSkillHarness(history);

    expect(history[0]).toEqual({
      toolCallId: "skill-harness",
      toolName: "skill-harness",
      status: "error",
      error: "skill selection unavailable",
      params: {},
    });
    expect(history[1].status).toBe("pending");
  });

  it("leaves completed or errored skill-harness entries untouched", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        status: "completed",
        params: { result: "1 skill selected: weather" },
      },
    ];

    finishPendingSkillHarness(history);

    expect(history[0].status).toBe("completed");
    expect(history[0].params).toEqual({
      result: "1 skill selected: weather",
    });
  });
});

describe("backward compatibility helpers", () => {
  it("parses single pipeline entry via parseSkillHarnessPipelineEntry", () => {
    const entry = parseSkillHarnessPipelineEntry(
      makePipelineEvent("pipeline", "started"),
    );

    expect(entry?.toolCallId).toBe("skill-harness");
    expect(entry?.status).toBe("pending");
  });

  it("merges entries via mergeSkillHarnessPipelineEntry", () => {
    const entry1: ToolEntry = {
      toolCallId: "skill-harness",
      toolName: "skill-harness",
      status: "pending",
      params: { status: "selecting skills" },
    };
    const entry2: ToolEntry = {
      toolCallId: "skill-harness",
      toolName: "skill-harness",
      status: "completed",
      params: { result: "no relevant skills" },
    };

    const res = mergeSkillHarnessPipelineEntry([entry1], entry2, 2_000);
    expect(res.changed).toBe(true);
    expect(res.entries[0]).toBe(entry2);
  });

  it("extracts sessionKey via getSkillHarnessPipelineSessionKey", () => {
    expect(
      getSkillHarnessPipelineSessionKey(
        makePipelineEvent("pipeline", "started"),
      ),
    ).toBe("agent:main:discord:direct:123");
  });
});
