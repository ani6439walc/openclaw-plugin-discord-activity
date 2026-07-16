import { describe, expect, it } from "vitest";
import { renderStatusContent, renderStatusContentWithState } from "./render.js";
import type { StatusDisplayState, ToolEntry } from "./types.js";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const stripAnsi = (value: string) => value.replaceAll(ANSI_PATTERN, "");

function makeEntry(
  toolCallId: string,
  params: Record<string, unknown> = {},
  overrides: Partial<ToolEntry> = {},
): ToolEntry {
  return {
    toolCallId,
    displayId: toolCallId,
    toolName: `tool_${toolCallId}`,
    params,
    status: "completed",
    ...overrides,
  };
}

function makeFailure(error = "provider timeout"): ToolEntry {
  return makeEntry(
    "agent",
    {},
    {
      toolCallId: "agent",
      displayId: "agent",
      toolName: "agent",
      status: "error",
      error,
    },
  );
}

function assertNoGlobalOmissionMarker(content: string): void {
  expect(content).not.toMatch(/\(\+\d+ (?:items?|lines?)\)/u);
}

describe("bounded status rendering", () => {
  it("collapses expanded blocks from top to bottom until the content fits", () => {
    const history = [
      makeEntry("first", { detail: "a".repeat(70) }),
      makeEntry("second", { detail: "b".repeat(70) }),
      makeEntry("third", { detail: "c".repeat(70) }),
    ];
    const expanded = renderStatusContent(history, false);
    const result = renderStatusContentWithState(
      history,
      false,
      expanded.length - 1,
    );
    const plain = stripAnsi(result.content);

    expect(result.content.length).toBeLessThanOrEqual(expanded.length - 1);
    expect(result.displayState).toEqual({ "tool:first": "collapsed" });
    expect(plain).toContain("tool_first ▸ ✔");
    expect(plain).toContain("tool_second ▾ ✔");
    expect(plain).toContain("tool_third ▾ ✔");
    expect(plain).not.toContain("detail: a");
    expect(plain).toContain("detail: b");
    assertNoGlobalOmissionMarker(result.content);
  });

  it("keeps concurrent pending headers while collapsing them from top to bottom", () => {
    const history = [
      makeEntry("first", { detail: "a".repeat(70) }, { status: "pending" }),
      makeEntry("second", { detail: "b".repeat(70) }, { status: "pending" }),
      makeEntry("third", { detail: "c".repeat(70) }, { status: "pending" }),
    ];
    const expanded = renderStatusContent(history, false);
    const result = renderStatusContentWithState(
      history,
      false,
      expanded.length - 1,
    );
    const plain = stripAnsi(result.content);

    expect(result.displayState).toEqual({ "tool:first": "collapsed" });
    expect(plain).toContain("tool_first ▸ ←");
    expect(plain).toContain("tool_second ▾ ←");
    expect(plain).toContain("tool_third ▾ ←");
    expect(plain).not.toContain("detail: a");
    expect(plain).toContain("detail: b");
  });

  it("collapses every block before removing the oldest block", () => {
    const history = [
      makeEntry("first", { detail: "a".repeat(70) }),
      makeEntry("second", { detail: "b".repeat(70) }),
    ];
    const collapsedState: StatusDisplayState = {
      "tool:first": "collapsed",
      "tool:second": "collapsed",
    };
    const allCollapsed = renderStatusContentWithState(
      history,
      false,
      1_700,
      collapsedState,
    ).content;
    const result = renderStatusContentWithState(
      history,
      false,
      allCollapsed.length - 1,
    );
    const plain = stripAnsi(result.content);

    expect(result.displayState).toEqual({
      "tool:first": "removed",
      "tool:second": "collapsed",
    });
    expect(plain).not.toContain("tool_first");
    expect(plain).toContain("tool_second ▸ ✔");
    assertNoGlobalOmissionMarker(result.content);
  });

  it("does not resurrect collapsed or removed blocks in later frames", () => {
    const history = [
      makeEntry("first", { detail: "a".repeat(70) }),
      makeEntry("second", { detail: "b".repeat(70) }),
    ];
    const collapsed = renderStatusContentWithState(history, false, 120);
    const nextCollapsed = renderStatusContentWithState(
      [makeEntry("first"), makeEntry("second")],
      false,
      1_700,
      collapsed.displayState,
    );
    expect(nextCollapsed.displayState["tool:first"]).toBe("collapsed");
    expect(stripAnsi(nextCollapsed.content)).toContain("tool_first ▸ ✔");

    const removed = renderStatusContentWithState(history, false, 45);
    const nextRemoved = renderStatusContentWithState(
      [makeEntry("first"), makeEntry("second")],
      false,
      1_700,
      removed.displayState,
    );
    expect(nextRemoved.displayState["tool:first"]).toBe("removed");
    expect(stripAnsi(nextRemoved.content)).not.toContain("tool_first");
  });

  it("reaches a fixed point and does not mutate the prior state", () => {
    const history = [
      makeEntry("first", { detail: "a".repeat(70) }),
      makeEntry("second", { detail: "b".repeat(70) }),
    ];
    const prior = Object.freeze<StatusDisplayState>({
      "tool:first": "collapsed",
    });
    const first = renderStatusContentWithState(history, false, 100, prior);
    const second = renderStatusContentWithState(
      history,
      false,
      100,
      first.displayState,
    );

    expect(second).toEqual(first);
    expect(prior).toEqual({ "tool:first": "collapsed" });
  });

  it("uses one shared six-block budget without a main-agent failure", () => {
    const history = Array.from({ length: 7 }, (_, index) =>
      makeEntry(String(index)),
    );
    const result = renderStatusContentWithState(history, false);
    const plain = stripAnsi(result.content);

    expect(plain).not.toContain("tool_0");
    for (let index = 1; index < 7; index += 1) {
      expect(plain).toContain(`tool_${index}`);
    }
    expect(result.displayState["tool:0"]).toBe("removed");
  });

  it("counts the protected main-agent failure in the shared six-block budget", () => {
    const history = [
      ...Array.from({ length: 7 }, (_, index) => makeEntry(String(index))),
      makeFailure(),
    ];
    const result = renderStatusContentWithState(history, true);
    const plain = stripAnsi(result.content);

    expect(plain).not.toContain("tool_0");
    expect(plain).not.toContain("tool_1");
    for (let index = 2; index < 7; index += 1) {
      expect(plain).toContain(`tool_${index}`);
    }
    expect(plain).toMatch(/tool_6[\s\S]*💥 agent ✘/u);
    expect(plain).not.toContain("provider timeout");
  });

  it("keeps the main-agent failure after ordinary blocks are removed", () => {
    const failureOnlyLength = renderStatusContent([makeFailure()], true).length;
    const result = renderStatusContentWithState(
      [makeEntry("first", { detail: "x".repeat(70) }), makeFailure()],
      true,
      failureOnlyLength,
    );
    const plain = stripAnsi(result.content);

    expect(plain).not.toContain("tool_first");
    expect(plain).toContain("💥 agent ✘");
    expect(result.displayState["tool:first"]).toBe("removed");
  });

  it("falls back to an empty ANSI fence when the protected header cannot fit", () => {
    expect(renderStatusContent([makeFailure()], true, 12)).toBe(
      "```ansi\n\n```",
    );
  });

  it("rejects invalid direct limits", () => {
    expect(() => renderStatusContent([], false, 11)).toThrow(RangeError);
    expect(() => renderStatusContent([], false, 12.5)).toThrow(RangeError);
  });

  it("marks outer-budget-hidden internal groups as removed without a marker", () => {
    const history: ToolEntry[] = [
      makeEntry("memory-parent", {}, { toolName: "active-memory" }),
      makeEntry(
        "memory-child",
        {},
        {
          toolName: "active-memory:memory_search",
        },
      ),
      makeEntry("harness-parent", {}, { toolName: "skill-harness" }),
      makeEntry(
        "harness-child",
        {},
        {
          toolName: "skill-harness:phase_1",
        },
      ),
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`normal-${index}`)),
    ];
    const result = renderStatusContentWithState(history, false);
    const plain = stripAnsi(result.content);

    expect(plain).not.toContain("active-memory");
    expect(plain).toContain("skill-harness");
    expect(result.displayState["group:active-memory"]).toBe("removed");
    assertNoGlobalOmissionMarker(result.content);
  });

  it("bounds large field sets with one block-level collapse", () => {
    const params = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [
        `field_${index}`,
        `value_${index}_${"x".repeat(100)}`,
      ]),
    );
    const result = renderStatusContentWithState(
      [makeEntry("bulk", params)],
      false,
    );

    expect(result.content.length).toBeLessThanOrEqual(1_700);
    expect(result.displayState["tool:bulk"]).toBe("collapsed");
    expect(stripAnsi(result.content)).toContain("tool_bulk ▸ ✔");
    assertNoGlobalOmissionMarker(result.content);
  });
});
