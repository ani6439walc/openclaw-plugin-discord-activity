import { describe, expect, it } from "vitest";
import { renderStatusContent, renderStatusContentWithState } from "./render.js";
import type { StatusDisplayState, ToolEntry } from "./types.js";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const stripAnsi = (value: string) => value.replaceAll(ANSI_PATTERN, "");

function entry(
  id: string,
  params: Record<string, unknown> = {},
  overrides: Partial<ToolEntry> = {},
): ToolEntry {
  return {
    toolCallId: id,
    displayId: id,
    toolName: `tool_${id}`,
    params,
    status: "completed",
    ...overrides,
  };
}

function largeParams(count = 30): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `detail_${index}`,
      `visible detail ${index} ${"x".repeat(35)}`,
    ]),
  );
}

function decision(state: unknown = null): ToolEntry {
  return entry(
    "latest",
    {
      state,
      questions: {
        reply: {
          type: "boolean",
          instructions: "Should we reply?",
          criteria: { true: "Direct question", false: "No reply needed" },
        },
      },
    },
    {
      toolName: "decision_evaluate",
      result: {
        status: "ok",
        result: {
          answers: { reply: { type: "boolean", probabilityTrue: 0.82 } },
        },
      },
    },
  );
}

function expectBounded(content: string, limit: number): void {
  expect(content.length).toBeLessThanOrEqual(limit);
  expect(content.startsWith("```ansi\n")).toBe(true);
  expect(content.endsWith("\n```")).toBe(true);
}

describe("latest ordinary tool detail budget", () => {
  it("retains a partial expanded ordinary tool instead of collapsing its entire body", () => {
    const title =
      "Inspect current target sections and pre-existing baseline differences";
    const latest = entry("latest", { title, ...largeParams() });
    const result = renderStatusContentWithState([latest], false, 500);
    const plain = stripAnsi(result.content);

    expectBounded(result.content, 500);
    expect(plain).toContain("tool_latest ▾ ✔");
    expect(plain).toContain(`    │› ${title.slice(0, 32)}...`);
    expect(plain).toContain("detail_0");
    expect(plain).toContain("visible detail 0");
    expect(plain).toMatch(/…|\.\.\./u);
    expect(plain).not.toContain("detail_29");
    expect(result.displayState["tool:latest"] ?? "expanded").toBe("expanded");
  });

  it.each([
    { toolName: "steer", prefix: "\n    \u001b[33m» " },
    { toolName: "message", prefix: "\n    │› \u001b[33m" },
    { toolName: "openclaw.steer", prefix: "\n    \u001b[33m» " },
    { toolName: "openclaw.message", prefix: "\n    │› \u001b[33m" },
  ])(
    "keeps the correct summary marker and color for a compact $toolName preview",
    ({ toolName, prefix }) => {
      const title =
        "Inspect current target sections and pre-existing baseline differences";
      const latest = entry("latest", { title, ...largeParams() }, { toolName });
      const result = renderStatusContentWithState([latest], false, 500);
      expectBounded(result.content, 500);
      expect(result.content).toContain(
        `${prefix}${title.slice(0, 32)}...\u001b[0m`,
      );
      expect(stripAnsi(result.content)).toContain("detail_0");
      expect(result.displayState["tool:latest"] ?? "expanded").toBe("expanded");
    },
  );

  it("keeps a decision question and probabilities ahead of oversized state", () => {
    const essential = decision();
    const limit = renderStatusContent([essential], false).length + 100;
    const latest = decision(largeParams());
    const result = renderStatusContentWithState([latest], false, limit);
    const plain = stripAnsi(result.content);

    expectBounded(result.content, limit);
    expect(plain).toContain("decision_evaluate ▾ ✔");
    expect(plain).toContain("Should we reply?");
    expect(plain).toContain("82.0%");
    expect(plain).toContain("18.0%");
    expect(plain).toMatch(/…|\.\.\./u);
    expect(plain).not.toContain("detail_29");
    expect(result.displayState["tool:latest"] ?? "expanded").toBe("expanded");
  });

  it.each(["hindsight-memory", "skill-harness"] as const)(
    "removes special groups one at a time in display order when %s comes first",
    (firstGroup) => {
      const secondGroup =
        firstGroup === "hindsight-memory"
          ? "skill-harness"
          : "hindsight-memory";
      const latest = decision(largeParams(5));
      const history = [
        entry("group-first", {}, { toolName: firstGroup }),
        entry(
          "group-first-child",
          { phase: "discovery" },
          {
            toolName: `${firstGroup}:inspect`,
          },
        ),
        entry("group-second", {}, { toolName: secondGroup }),
        entry(
          "group-second-child",
          { phase: "implementation" },
          {
            toolName: `${secondGroup}:inspect`,
          },
        ),
        entry("old-first", largeParams(2)),
        entry("old-second", largeParams(2)),
        latest,
      ];
      const allOthersCollapsed: StatusDisplayState = {
        [`group:${firstGroup}`]: "collapsed",
        [`group:${secondGroup}`]: "collapsed",
        "tool:old-first": "collapsed",
        "tool:old-second": "collapsed",
      };
      const collapsed = renderStatusContentWithState(
        history,
        false,
        1_700,
        allOthersCollapsed,
      );
      expect(collapsed.displayState).toEqual(allOthersCollapsed);
      const firstLimit = collapsed.content.length - 1;
      const first = renderStatusContentWithState(history, false, firstLimit);

      expectBounded(first.content, firstLimit);
      expect(first.displayState).toEqual({
        ...allOthersCollapsed,
        [`group:${firstGroup}`]: "removed",
      });
      expect(stripAnsi(first.content)).not.toContain(firstGroup);
      expect(stripAnsi(first.content)).toContain(`${secondGroup} ▸ ✔`);
      expect(stripAnsi(first.content)).toContain("detail_4:");
      expect(stripAnsi(first.content)).toContain("82.0%");

      const secondLimit = first.content.length - 1;
      const second = renderStatusContentWithState(history, false, secondLimit);
      expectBounded(second.content, secondLimit);
      expect(second.displayState).toEqual({
        ...allOthersCollapsed,
        [`group:${firstGroup}`]: "removed",
        [`group:${secondGroup}`]: "removed",
      });
      expect(stripAnsi(second.content)).not.toContain(secondGroup);
      expect(stripAnsi(second.content)).toContain("detail_4:");
      expect(stripAnsi(second.content)).toContain("82.0%");

      const trimLimit = second.content.length - 1;
      const trimmed = renderStatusContentWithState(history, false, trimLimit);
      expectBounded(trimmed.content, trimLimit);
      expect(trimmed.displayState).toEqual(second.displayState);
      expect(stripAnsi(trimmed.content)).toContain("decision_evaluate ▾ ✔");
      expect(stripAnsi(trimmed.content)).toContain("Should we reply?");
      expect(stripAnsi(trimmed.content)).toContain("82.0%");
      expect(stripAnsi(trimmed.content)).toMatch(/…|\.\.\./u);
    },
  );

  it.each([
    {
      type: "choice",
      question: {
        type: "choice",
        instructions: "Which route?",
        criteria: { direct: "Direct route", queued: "Queue request" },
      },
      answer: {
        type: "choice",
        choice: "queued",
        probabilities: { direct: 0.2, queued: 0.8 },
      },
      expected: "Which route? → queued",
    },
    {
      type: "score",
      question: {
        type: "score",
        instructions: "How urgent?",
        criteria: ["Normal", "Urgent"],
      },
      answer: { type: "score", score: 0.8, probabilities: [0.2, 0.8] },
      expected: "How urgent? → score 0.80 / 1",
    },
  ])(
    "preserves $type answer and probabilities before state",
    ({ question, answer, expected }) => {
      const latest = entry(
        "latest",
        { questions: { q: question } },
        {
          toolName: "decision_evaluate",
          result: { status: "ok", result: { answers: { q: answer } } },
        },
      );
      const limit = renderStatusContent([latest], false).length + 100;
      const result = renderStatusContentWithState(
        [{ ...latest, params: { ...latest.params, state: largeParams() } }],
        false,
        limit,
      );
      const plain = stripAnsi(result.content);

      expectBounded(result.content, limit);
      expect(plain).toContain(expected);
      expect(plain).toContain("20.0%");
      expect(plain).toContain("80.0%");
      expect(plain).toMatch(/…|\.\.\./u);
    },
  );

  it("lets a partial preview expand in a roomier frame without persisting a trim cap", () => {
    const latest = entry("latest", largeParams(10));
    const partial = renderStatusContentWithState([latest], false, 500);
    const roomier = renderStatusContentWithState(
      [latest],
      false,
      1_700,
      Object.freeze(partial.displayState),
    );

    expect(partial.displayState).toEqual({});
    expect(roomier.displayState).toEqual({});
    expect(roomier.content.length).toBeGreaterThan(partial.content.length);
    expect(stripAnsi(roomier.content)).toContain("detail_9");
    expect(stripAnsi(roomier.content)).toContain("tool_latest ▾ ✔");
  });

  it("keeps the selected choice and its probability when the selected option is last", () => {
    const criteria = Object.fromEntries([
      ...Array.from({ length: 12 }, (_, index) => [
        `other_${index}`,
        `Other destination ${index} ${"x".repeat(50)}`,
      ]),
      ["selected", "Selected destination"],
    ]);
    const probabilities = Object.fromEntries(
      Object.keys(criteria).map((key) => [
        key,
        key === "selected" ? 0.8 : 0.2 / 12,
      ]),
    );
    const latest = entry(
      "latest",
      {
        questions: {
          destination: {
            type: "choice",
            instructions: "Which destination?",
            criteria,
          },
        },
      },
      {
        toolName: "decision_evaluate",
        result: {
          status: "ok",
          result: {
            answers: {
              destination: {
                type: "choice",
                choice: "selected",
                probabilities,
              },
            },
          },
        },
      },
    );
    const limit = 450;
    const result = renderStatusContentWithState([latest], false, limit);
    const plain = stripAnsi(result.content);

    expectBounded(result.content, limit);
    expect(plain).toContain("Which destination? → selected");
    expect(plain).toMatch(/selected[^\n]*→ 80\.0%/u);
    expect(plain).toMatch(/…|\.\.\./u);
    expect(plain).not.toContain("other_11");
  });

  it("keeps multiline descriptions and their probabilities together or uses compact answer rows", () => {
    const latest = decision();
    latest.params.questions.reply.criteria = {
      true: `Acceptable\n${"Detailed supporting context\n".repeat(20)}Final reason`,
      false: `Decline\n${"Detailed opposing context\n".repeat(20)}Final reason`,
    };
    const limit = renderStatusContent([decision()], false).length + 100;
    const result = renderStatusContentWithState([latest], false, limit);
    const plain = stripAnsi(result.content);

    expect(renderStatusContent([latest], false).length).toBeGreaterThan(limit);
    expectBounded(result.content, limit);
    expect(plain).toContain("Should we reply?");
    const trueIndex = plain.indexOf("true");
    const falseIndex = plain.indexOf("false");
    expect(trueIndex).toBeGreaterThan(0);
    expect(falseIndex).toBeGreaterThan(trueIndex);
    expect(plain.slice(trueIndex, falseIndex)).toContain("→ 82.0%");
    expect(plain.slice(falseIndex)).toContain("→ 18.0%");
    expect(plain).toMatch(/…|\.\.\./u);
  });

  it("reaches a fixed point when rendering the same bounded frame repeatedly", () => {
    const history = [
      entry("memory", {}, { toolName: "hindsight-memory" }),
      entry(
        "memory-child",
        { context: "Memory context" },
        {
          toolName: "hindsight-memory:inspect",
        },
      ),
      entry("old", largeParams(2)),
      decision(largeParams()),
    ];
    const first = renderStatusContentWithState(history, false, 600);
    const second = renderStatusContentWithState(
      history,
      false,
      600,
      Object.freeze(first.displayState),
    );
    const third = renderStatusContentWithState(
      history,
      false,
      600,
      second.displayState,
    );

    expectBounded(first.content, 600);
    expect(stripAnsi(first.content)).toContain("Should we reply?");
    expect(first.displayState["group:hindsight-memory"]).toBe("removed");
    expect(first.displayState["tool:old"]).toBe("collapsed");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("uses the stable display key when tool names and call IDs are reused", () => {
    const history = [
      entry(
        "older",
        { oldDetail: "Old visible detail" },
        {
          toolCallId: "reused-call",
          toolName: "exec",
        },
      ),
      entry("latest", largeParams(), {
        toolCallId: "reused-call",
        toolName: "exec",
      }),
    ];
    const result = renderStatusContentWithState(history, false, 500);
    const plain = stripAnsi(result.content);

    expectBounded(result.content, 500);
    expect(result.displayState).toEqual({ "tool:older": "collapsed" });
    expect(plain).toContain("exec ▸ ✔");
    expect(plain).toContain("exec ▾ ✔");
    expect(plain).not.toContain("Old visible detail");
    expect(plain).toContain("visible detail 0");
  });

  it("collapses the previous preview when a new ordinary tool arrives and never reopens saved levels", () => {
    const previous = entry("previous", largeParams());
    const first = renderStatusContentWithState([previous], false, 500);
    expect(stripAnsi(first.content)).toContain("detail_0");

    const latest = entry("latest", { detail: "Newest important detail" });
    const second = renderStatusContentWithState(
      [previous, latest],
      false,
      500,
      first.displayState,
    );
    expect(second.displayState["tool:previous"]).toBe("collapsed");
    expect(stripAnsi(second.content)).toContain("tool_previous ▸ ✔");
    expect(stripAnsi(second.content)).toContain("Newest important detail");

    const saved: StatusDisplayState = Object.freeze({
      ...second.displayState,
      "tool:gone": "removed",
      "tool:latest": "collapsed",
    });
    const later = renderStatusContentWithState(
      [entry("gone", { detail: "Never resurrect" }), previous, latest],
      false,
      1_700,
      saved,
    );
    expect(later.displayState).toEqual(saved);
    expect(stripAnsi(later.content)).not.toContain("tool_gone");
    expect(stripAnsi(later.content)).toContain("tool_latest ▸ ✔");
    expect(stripAnsi(later.content)).not.toContain("Newest important detail");
  });

  it("preserves progress and main failure while previewing the latest ordinary tool before them", () => {
    const progress = entry(
      "progress",
      {
        markdown: "Keep the objective",
        plan: [{ step: "Pinned implementation step", status: "in_progress" }],
      },
      { toolName: "progress_card" },
    );
    const failure = entry(
      "agent",
      {},
      {
        toolName: "agent",
        status: "error",
        error: "Provider failure must remain visible",
      },
    );
    const history = [entry("latest", largeParams()), progress, failure];
    const protectedLength = renderStatusContent(
      [progress, failure],
      true,
    ).length;
    const limit = protectedLength + 450;
    const result = renderStatusContentWithState(history, true, limit);
    const plain = stripAnsi(result.content);

    expectBounded(result.content, limit);
    expect(plain).toContain("Pinned implementation step");
    expect(plain).toContain("Keep the objective");
    expect(plain).toContain("Provider failure must remain visible");
    expect(plain).toContain("tool_latest ▾ ✔");
    expect(plain).toContain("detail_0");
    expect(plain).toMatch(/tool_latest[\s\S]*💥 agent ✘/u);
  });

  it("trims Unicode details at complete characters and ANSI sequences within the UTF-16 budget", () => {
    const latest = entry("latest", {
      detail: `${"🔭漢字🧑‍💻".repeat(40)}\n${"🌈".repeat(80)}`,
    });
    const limit = 230;
    const result = renderStatusContentWithState([latest], false, limit);
    const plain = stripAnsi(result.content);

    expectBounded(result.content, limit);
    expect(plain).toContain("tool_latest ▾ ✔");
    expect(plain).toContain("🔭");
    expect(plain).toMatch(/…|\.\.\./u);
    expect(plain).not.toContain("\u001b");
    expect(plain.isWellFormed()).toBe(true);
  });

  it("falls back to a collapsed latest header or empty fence when no useful detail fits", () => {
    const latest = entry("latest", largeParams());
    const collapsed = renderStatusContentWithState([latest], false, 1_700, {
      "tool:latest": "collapsed",
    });
    const headerOnly = renderStatusContentWithState(
      [latest],
      false,
      collapsed.content.length,
    );

    expect(headerOnly).toEqual(collapsed);
    const tiny = renderStatusContentWithState([latest], false, 12);
    expect(tiny.content).toBe("```ansi\n\n```");
    expect(tiny.displayState["tool:latest"]).toBe("removed");
  });
});
