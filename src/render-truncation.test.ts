import { afterEach, describe, expect, it, vi } from "vitest";
import { renderStatusContent, renderStatusContentWithState } from "./render.js";
import { defaultStore, updateStatusMessage } from "./session.js";
import { createMockSessionEntry, createToolEntry } from "../test-helpers.js";
import type { ToolEntry } from "./types.js";

const RESET = "\u001b[0m";
const LIGHT_GRAY = "\u001b[37m";

function entry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    toolCallId: "call_1",
    toolName: "bash",
    params: {},
    status: "completed",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stripAnsi(content: string): string {
  return content.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function containsOnlyCompleteAnsiSequences(content: string): boolean {
  return !content
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .includes("\u001b");
}

describe("bounded status rendering", () => {
  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.unstubAllGlobals();
  });

  it("keeps the default hard bound, semantic status headers, marker, and fence", () => {
    const huge = Array.from(
      { length: 80 },
      (_, index) => `detail ${index} ${"x".repeat(80)}`,
    ).join("\n");
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:memory",
          toolName: "active-memory:memory_search",
          params: { result: huge },
          status: "error",
          error: huge,
        }),
        entry({
          toolCallId: "skill-harness:phase",
          toolName: "skill-harness:topic-triage",
          params: { result: huge },
        }),
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
          error: huge,
        }),
        entry({
          toolCallId: "normal",
          toolName: "terminal",
          params: { command: huge },
        }),
        entry({
          toolCallId: "normal-2",
          toolName: "web_search",
          params: { result: huge },
        }),
        entry({
          toolCallId: "normal-3",
          toolName: "bash",
          params: { command: huge },
        }),
      ],
      true,
    );

    expect(result.length).toBeLessThanOrEqual(1700);
    const plain = stripAnsi(result);
    expect(plain).not.toContain("active-memory");
    expect(plain).not.toContain("skill-harness");
    expect(plain).toContain("💥 agent ✘");
    expect(plain).toContain("terminal ✔");
    expect(result).toMatch(/\(\+\d+ lines?\)/u);
    expect(result.startsWith("```ansi\n")).toBe(true);
    expect(result.endsWith("\n```")).toBe(true);
  });

  it("never exceeds the 1700-character hard bound when configured higher", () => {
    const result = renderStatusContent(
      [
        entry({
          toolName: "terminal",
          params: { command: "x".repeat(5_000) },
        }),
      ],
      true,
      4_000,
    );

    expect(result.length).toBeLessThanOrEqual(1_700);
    expect(result.endsWith("\n```")).toBe(true);
  });

  it("collapses active-memory before truncating its long result", () => {
    const text = `start-${"😀".repeat(1_500)}-end`;
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:result",
          toolName: "active-memory:result",
          params: { text },
        }),
      ],
      true,
    );
    const plain = stripAnsi(result);

    expect(result.length).toBeLessThanOrEqual(1_700);
    expect(plain).toContain("🧩 active-memory ▸ ✔");
    expect(plain).not.toContain("result:");
    expect(plain).not.toMatch(/\(\+\d+ chars?\)/u);
    expect(plain).not.toMatch(/\(\+\d+ lines?\)/u);
  });

  it("preserves the newest internal multiline owner before an older group", () => {
    const history = [
      entry({
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: `hint-${"h".repeat(1_000)}` },
      }),
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: `memory-${"m".repeat(800)}` },
      }),
    ];

    const result = renderStatusContentWithState(history, true);
    const plain = stripAnsi(result.content);

    expect(result.content.length).toBeLessThanOrEqual(1_700);
    expect(plain).toContain("💡 skill-harness ▸ ✔");
    expect(plain).toContain("🧩 active-memory ▾ ✔");
    expect(plain).toContain("memory-");
    expect(result.displayState).toEqual({
      activeMemory: "expanded",
      skillHarness: "collapsed",
    });
  });

  it("truncates an older normal multiline field before the newest internal owner", () => {
    const olderCommand = `older-${"o".repeat(900)}`;
    const history = [
      entry({
        toolCallId: "older",
        toolName: "terminal",
        params: { command: olderCommand },
      }),
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: `memory-${"m".repeat(700)}` },
      }),
    ];

    const result = renderStatusContentWithState(history, true, 1_200);
    const plain = stripAnsi(result.content);

    expect(plain).toContain("🧩 active-memory ▾ ✔");
    expect(plain).toContain("memory-");
    expect(plain).toMatch(/older-.+\(\+\d+ chars?\)/u);
    expect(result.displayState.activeMemory).toBe("expanded");
  });

  it("keeps an older main-agent error before a newer internal result", () => {
    const error = `provider-${"e".repeat(600)}`;
    const history = [
      entry({
        toolCallId: "agent",
        toolName: "agent",
        status: "error",
        error,
      }),
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: `memory-${"m".repeat(800)}` },
      }),
    ];

    const result = renderStatusContentWithState(history, true, 1_000);
    const plain = stripAnsi(result.content);

    expect(plain).toContain(error);
    expect(plain).toContain("🧩 active-memory ▸ ✔");
    expect(result.displayState.activeMemory).toBe("collapsed");
  });

  it("ignores an outer-budget-hidden internal multiline owner", () => {
    const history = [
      entry({
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: `hint-${"h".repeat(500)}` },
      }),
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: `hidden-newer-${"m".repeat(1_000)}` },
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        entry({
          toolCallId: `normal-${index}`,
          toolName: `normal_${index}`,
        }),
      ),
    ];

    const result = renderStatusContentWithState(history, true);
    const plain = stripAnsi(result.content);

    expect(plain).not.toContain("active-memory");
    expect(plain).toContain("💡 skill-harness ▾ ✔");
    expect(result.displayState).toEqual({
      activeMemory: "removed",
      skillHarness: "expanded",
    });
  });

  it("treats a newer main-agent failure as the multiline owner", () => {
    const history = [
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: `memory-${"m".repeat(900)}` },
      }),
      entry({
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: `hint-${"h".repeat(600)}` },
      }),
      entry({
        toolCallId: "agent",
        toolName: "agent",
        status: "error",
        error: `provider-${"e".repeat(300)}`,
      }),
    ];

    const result = renderStatusContentWithState(history, true, 1_300);
    const plain = stripAnsi(result.content);

    expect(plain).toContain("💥 agent ✘");
    expect(plain).toContain("provider-");
    expect(result.displayState.activeMemory).not.toBe("expanded");
    expect(result.displayState.skillHarness).toBe("expanded");
  });

  it("never resurrects a removed group in a later frame", () => {
    const firstHistory = [
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: `memory-${"m".repeat(800)}` },
      }),
      entry({
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: `hint-${"h".repeat(800)}` },
      }),
      entry({
        toolCallId: "normal",
        toolName: "terminal",
        params: { command: `command-${"c".repeat(500)}` },
      }),
    ];
    const first = renderStatusContentWithState(firstHistory, true, 400);
    expect(first.displayState.activeMemory).toBe("removed");

    const second = renderStatusContentWithState(
      firstHistory.slice(0, 2),
      true,
      1_700,
      first.displayState,
    );

    expect(stripAnsi(second.content)).not.toContain("active-memory");
    expect(second.displayState.activeMemory).toBe("removed");
  });

  it("reports outer-budget and emergency group removals", () => {
    const history = [
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "memory" },
      }),
      entry({
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "hint" },
      }),
      ...Array.from({ length: 6 }, (_, index) =>
        entry({
          toolCallId: `normal-${index}`,
          toolName: `normal_${index}`,
        }),
      ),
    ];

    const outerBounded = renderStatusContentWithState(history, true);
    expect(outerBounded.displayState).toEqual({
      activeMemory: "removed",
      skillHarness: "removed",
    });

    const emergency = renderStatusContentWithState(
      history.slice(0, 1),
      true,
      12,
    );
    expect(emergency.content).toBe("```ansi\n\n```");
    expect(emergency.displayState.activeMemory).toBe("removed");
  });

  it("reaches a fixed point for content and state", () => {
    const history = [
      entry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: `memory-${"m".repeat(800)}` },
      }),
      entry({
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: `hint-${"h".repeat(800)}` },
      }),
      entry({
        toolCallId: "normal",
        toolName: "terminal",
        params: { command: `latest-${"n".repeat(300)}` },
      }),
    ];
    const first = renderStatusContentWithState(history, true, 500);
    const second = renderStatusContentWithState(
      history,
      true,
      500,
      first.displayState,
    );

    expect(second).toEqual(first);
  });

  it("stays monotonic and fixed across deterministic state and length combinations", () => {
    const levels = ["expanded", "collapsed", "removed"] as const;
    const rank = { expanded: 0, collapsed: 1, removed: 2 } as const;

    for (let index = 0; index < 24; index += 1) {
      const priorState = {
        activeMemory: levels[index % levels.length],
        skillHarness: levels[Math.floor(index / levels.length) % levels.length],
      };
      const history = [
        ...(index % 2 === 0
          ? [
              createToolEntry({
                toolCallId: `active-memory:result:${index}`,
                toolName: "active-memory:result",
                params: { text: `memory-${"m".repeat(80 + index * 11)}` },
              }),
            ]
          : []),
        createToolEntry({
          toolCallId: `skill-harness:result:${index}`,
          toolName: "skill-harness:result",
          params: { text: `hint-${"h".repeat(60 + index * 13)}` },
        }),
        ...Array.from({ length: index % 7 }, (_, normalIndex) =>
          createToolEntry({
            toolCallId: `normal:${index}:${normalIndex}`,
            toolName: `normal_${normalIndex}`,
            params: {
              command: `command-${"c".repeat(40 + normalIndex * 29)}`,
            },
          }),
        ),
      ];
      const maxLength = 100 + ((index * 67) % 1_601);

      const first = renderStatusContentWithState(
        history,
        false,
        maxLength,
        priorState,
      );
      const second = renderStatusContentWithState(
        history,
        false,
        maxLength,
        first.displayState,
      );

      expect(second, `fixed point case ${index}`).toEqual(first);
      expect(rank[first.displayState.activeMemory]).toBeGreaterThanOrEqual(
        rank[priorState.activeMemory],
      );
      expect(rank[first.displayState.skillHarness]).toBeGreaterThanOrEqual(
        rank[priorState.skillHarness],
      );
    }
  });

  it("collapses active-memory before skill-harness to preserve a newer multiline field", () => {
    const latestCommand = `latest-${"n".repeat(240)}`;
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:result",
          toolName: "active-memory:result",
          params: { text: `memory-${"m".repeat(800)}` },
        }),
        entry({
          toolCallId: "skill-harness:result",
          toolName: "skill-harness:result",
          params: { text: `hint-${"h".repeat(160)}` },
        }),
        entry({
          toolCallId: "latest",
          toolName: "terminal",
          params: { command: latestCommand },
        }),
      ],
      true,
      800,
    );
    const plain = stripAnsi(result);

    expect(result.length).toBeLessThanOrEqual(800);
    expect(plain).toContain("🧩 active-memory ▸ ✔");
    expect(plain).toContain("💡 skill-harness ▾ ✔");
    expect(plain).toContain(latestCommand);
    expect(plain).not.toMatch(/latest-.+\(\+\d+ chars?\)/u);
  });

  it("collapses skill-harness after active-memory before truncating a newer multiline field", () => {
    const latestCommand = `latest-${"n".repeat(240)}`;
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:result",
          toolName: "active-memory:result",
          params: { text: `memory-${"m".repeat(800)}` },
        }),
        entry({
          toolCallId: "skill-harness:result",
          toolName: "skill-harness:result",
          params: { text: `hint-${"h".repeat(800)}` },
        }),
        entry({
          toolCallId: "latest",
          toolName: "terminal",
          params: { command: latestCommand },
        }),
      ],
      true,
      500,
    );
    const plain = stripAnsi(result);

    expect(result.length).toBeLessThanOrEqual(500);
    expect(plain).toContain("🧩 active-memory ▸ ✔");
    expect(plain).toContain("💡 skill-harness ▸ ✔");
    expect(plain).toContain(latestCommand);
  });

  it("keeps the latest skill-harness expanded until a normal tool appears", () => {
    const result = renderStatusContentWithState(
      [
        entry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          durationMs: 11_500,
        }),
        entry({
          toolCallId: "skill-harness",
          toolName: "skill-harness",
          durationMs: 24_200,
        }),
        entry({
          toolCallId: "skill-harness:run:topic-triage",
          toolName: "skill-harness:topic-triage",
          params: {
            basis: `Prior context: ${"health-tracking workflow ".repeat(100)}`,
            topic: "Review yesterday's activities.",
          },
        }),
      ],
      true,
      1_700,
      { activeMemory: "collapsed", skillHarness: "expanded" },
    );
    const plain = stripAnsi(result.content);

    expect(result.content.length).toBeLessThanOrEqual(1_700);
    expect(result.displayState).toEqual({
      activeMemory: "collapsed",
      skillHarness: "expanded",
    });
    expect(plain).toContain("🧩 active-memory ▸ ✔ [11.5s]");
    expect(plain).toContain("💡 skill-harness ▾ ✔ [24.2s]");
    expect(plain).toContain("topic-triage ✔");
    expect(plain).toMatch(/basis: .+\(\+\d+ chars?\)/u);
  });

  it("collapses skill-harness before omitting newer normal tool fields", () => {
    const history = [
      entry({
        toolCallId: "active-memory",
        toolName: "active-memory",
        durationMs: 9_680,
      }),
      entry({
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        durationMs: 21_700,
      }),
      entry({
        toolCallId: "skill-harness:run:topic-triage",
        toolName: "skill-harness:topic-triage",
        durationMs: 5_090,
        params: {
          domain: "memory",
          changed: true,
          confidence: 0.72,
          complexity: "low",
          keywords: ["昨天", "做了甚麼", "review", "activity", "check"],
          basis: `Prior context: ${"health-tracking workflow ".repeat(24)}`,
          reason: "shift",
          topic: "User requesting to review yesterday's activities or records.",
        },
      }),
      entry({
        toolCallId: "skill-harness:run:intent-classify",
        toolName: "skill-harness:intent-classify",
        durationMs: 4_340,
        params: {
          intent: "memory-recent",
          complexity: "low",
          confidence: 0.85,
          reason:
            "User requested recent records using yesterday as the temporal marker.",
        },
      }),
      entry({
        toolCallId: "skill-harness:run:hint-generate",
        toolName: "skill-harness:hint-generate",
        durationMs: 12_000,
        params: {
          result:
            "Check memory/2026-07-15.md for yesterday's diary entry and summarize it.",
        },
      }),
      entry({
        toolCallId: "read",
        toolName: "read",
        params: { path: "memory/2026-07-15.md" },
      }),
      entry({
        toolCallId: "memory-search",
        toolName: "memory_search",
        params: {
          corpus: "memory",
          maxResults: 5,
          query: "2026-07-15 PMLE Bifrost heartbeat",
        },
      }),
    ];

    const result = renderStatusContentWithState(history, true, 1_700, {
      activeMemory: "collapsed",
      skillHarness: "expanded",
    });
    const plain = stripAnsi(result.content);

    expect(result.content.length).toBeLessThanOrEqual(1_700);
    expect(result.displayState).toEqual({
      activeMemory: "collapsed",
      skillHarness: "collapsed",
    });
    expect(plain).toContain("💡 skill-harness ▸ ✔ [21.7s]");
    expect(plain).toContain("📄 read ✔");
    expect(plain).toContain("path: memory/2026-07-15.md");
    expect(plain).toContain("query: 2026-07-15 PMLE Bifrost heartbeat");
    expect(plain).not.toContain("(+1 line)");
  });

  it("removes collapsed internal groups before truncating normal multiline fields", () => {
    const olderCommand = `older-${"o".repeat(500)}`;
    const latestResult = `latest-${"n".repeat(500)}`;
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:result",
          toolName: "active-memory:result",
          params: { text: `memory-${"m".repeat(800)}` },
        }),
        entry({
          toolCallId: "skill-harness:result",
          toolName: "skill-harness:result",
          params: { text: `hint-${"h".repeat(800)}` },
        }),
        entry({
          toolCallId: "older",
          toolName: "terminal",
          params: { command: olderCommand },
        }),
        entry({
          toolCallId: "latest",
          toolName: "web_search",
          params: { result: latestResult },
        }),
      ],
      true,
      750,
    );
    const plain = stripAnsi(result);

    expect(result.length).toBeLessThanOrEqual(750);
    expect(plain).not.toContain("active-memory");
    expect(plain).not.toContain("skill-harness");
    expect(plain).toContain("terminal ✔");
    expect(plain).toContain("web_search ✔");
    expect(plain).toContain(latestResult);
    expect(plain).toMatch(/older-.+\(\+\d+ chars?\)/u);
    expect(plain).not.toMatch(/\(\+\d+ lines?\)/u);
  });

  it("removes active-memory before skill-harness after both groups collapse", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          durationMs: 100_000,
        }),
        entry({
          toolCallId: "active-memory:result",
          toolName: "active-memory:result",
          params: { text: `memory-${"m".repeat(800)}` },
        }),
        entry({
          toolCallId: "skill-harness",
          toolName: "skill-harness",
          durationMs: 100_000,
        }),
        entry({
          toolCallId: "skill-harness:result",
          toolName: "skill-harness:result",
          params: { text: `hint-${"h".repeat(800)}` },
        }),
      ],
      true,
      100,
    );
    const plain = stripAnsi(result);

    expect(result.length).toBeLessThanOrEqual(100);
    expect(plain).not.toContain("active-memory");
    expect(plain).toContain("💡 skill-harness ▸ ✔ [100s]");
    expect(plain).not.toMatch(/\(\+\d+ lines?\)/u);
  });

  it("truncates an oversized old header before dropping newer status headers", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "old",
          toolName: `old_${"x".repeat(500)}`,
        }),
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
          error: "provider timeout",
        }),
        entry({ toolCallId: "new", toolName: "web_search" }),
      ],
      true,
      120,
    );

    expect(result.length).toBeLessThanOrEqual(120);
    const plain = stripAnsi(result);
    expect(plain).toContain("💥 agent ✘");
    expect(plain).toContain("web_search ✔");
  });

  it("does not split surrogate pairs when truncating status headers", () => {
    const malformedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const history = [
      entry({
        toolCallId: "emoji",
        toolName: `emoji_${"😀".repeat(100)}`,
      }),
      entry({ toolCallId: "new", toolName: "web_search" }),
    ];

    for (let maxLength = 100; maxLength <= 130; maxLength += 1) {
      expect(renderStatusContent(history, true, maxLength)).not.toMatch(
        malformedSurrogate,
      );
    }
  });

  it("honors a custom limit without mutating session history", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({
      toolHistory: [
        createToolEntry({
          toolCallId: "one",
          toolName: "terminal",
          params: { command: "a".repeat(500) },
          status: "completed",
        }),
        createToolEntry({
          toolCallId: "two",
          toolName: "web_search",
          params: { query: "b".repeat(500) },
          status: "completed",
        }),
      ],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, undefined, 120);

    expect(session.toolHistory).toHaveLength(2);
    expect(session.lastRenderedContent?.length).toBeLessThanOrEqual(120);
    const plain = stripAnsi(session.lastRenderedContent ?? "");
    expect(plain).toContain("terminal ✔");
    expect(plain).toContain("web_search ✔");
    expect(session.lastRenderedContent).toMatch(/\(\+\d+ lines?\)/u);
    expect(session.lastRenderedContent?.endsWith("\n```")).toBe(true);
  });

  it("rejects limits too small to contain a complete ANSI fence", () => {
    expect(() => renderStatusContent([], true, 11)).toThrow(/at least 12/u);
  });

  it("sanitizes top-level and nested tool names before rendering", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:evil",
          toolName: "active-memory:evil\n```\n\u001b[31m",
        }),
        entry({
          toolCallId: "evil",
          toolName: "evil\n```\n\u001b[31m",
        }),
      ],
      true,
    );

    expect(result.match(/```/gu)).toHaveLength(2);
    expect(containsOnlyCompleteAnsiSequences(result)).toBe(true);
    expect(stripAnsi(result)).not.toContain("\nevil\n");
    expect(stripAnsi(result)).not.toContain("\n```\n");
  });

  it("keeps malicious parameter keys on one safe tree line", () => {
    const result = renderStatusContent(
      [
        entry({
          toolName: "bash",
          params: {
            "bad\n```\n\u009b31mkey": "value",
          },
        }),
      ],
      true,
    );
    const plain = stripAnsi(result);

    expect(result.match(/```/gu)).toHaveLength(2);
    expect(plain).toContain("bad\\nˋˋˋ\\n31mkey: value");
    expect(plain).not.toContain("\nbad\n");
  });

  it("removes an ordinary params.error before a real main-agent error", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "ordinary",
          toolName: "bash",
          params: { error: `not-a-failure-${"x".repeat(70)}` },
        }),
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
          error: "provider timeout",
        }),
      ],
      true,
      150,
    );
    const plain = stripAnsi(result);

    expect(plain).toContain("provider timeout");
    expect(plain).not.toContain("not-a-failure");
  });

  it("collapses a deduplicated error group to its failed header", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          status: "error",
          error: "memory failed",
        }),
        entry({
          toolCallId: "active-memory:child",
          toolName: "active-memory:memory_search",
          params: { query: "x".repeat(70) },
          status: "error",
          error: "memory failed",
        }),
      ],
      true,
      162,
    );
    const plain = stripAnsi(result);

    expect(result.length).toBeLessThanOrEqual(162);
    expect(plain).toContain("🧩 active-memory ▸ ✘");
    expect(plain).not.toContain("memory_search");
    expect(plain).not.toContain("memory failed");
    expect(plain).not.toMatch(/\(\+\d+ lines?\)/u);
  });

  it("removes compact and multiline nodes atomically with exact line counts", () => {
    const result = renderStatusContent(
      [
        entry({
          toolName: "bash",
          params: {
            one: 1,
            two: 2,
            three: 3,
            command: ["line 1", "line 2", "line 3"].join("\n"),
          },
          status: "error",
          error: "important failure",
        }),
      ],
      true,
      120,
    );
    const plain = stripAnsi(result);

    expect(result.length).toBeLessThanOrEqual(120);
    expect(plain).not.toContain("one:");
    expect(plain).not.toContain("two:");
    expect(plain).not.toContain("three:");
    expect(plain).not.toContain("command:");
    expect(plain).not.toContain("line 1");
    expect(plain).toContain("   └─ error: important failure");
    expect(result).toContain(`${LIGHT_GRAY}(+3 lines)${RESET}`);
  });

  it("collapses a subagent group before removing any of its details", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          durationMs: 26_800,
        }),
        entry({
          toolCallId: "active-memory:search",
          toolName: "active-memory:memory_search",
          params: {
            limit: 5,
            query: "project notes ".repeat(8),
          },
        }),
        entry({
          toolCallId: "active-memory:result",
          toolName: "active-memory:result",
          params: { text: "Relevant memory found" },
        }),
        entry({
          toolCallId: "normal",
          toolName: "skill_view",
          params: { name: "gcp-cert-exam" },
        }),
      ],
      true,
      180,
    );
    const plain = stripAnsi(result);

    expect(plain).toContain("🧩 active-memory ▸ ✔ [26.8s]");
    expect(result).toContain(`${LIGHT_GRAY}▸${RESET}`);
    expect(plain).not.toContain("memory_search");
    expect(plain).not.toContain("Relevant memory found");
    expect(plain).toContain("🔧 skill_view ✔");
    expect(plain).toContain("name: gcp-cert-exam");
    expect(plain).not.toMatch(/\(\+\d+ lines?\)/u);
  });

  it("collapses multiple subagent groups without counting their details", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory",
          toolName: "active-memory",
        }),
        entry({
          toolCallId: "active-memory:search",
          toolName: "active-memory:memory_search",
          params: { query: "a".repeat(70) },
        }),
        entry({
          toolCallId: "skill-harness",
          toolName: "skill-harness",
        }),
        entry({
          toolCallId: "skill-harness:triage",
          toolName: "skill-harness:topic-triage",
          params: { topic: "t".repeat(70) },
        }),
        entry({
          toolCallId: "normal",
          toolName: "skill_view",
          params: { name: "gcp-cert-exam" },
        }),
      ],
      true,
      200,
    );
    const plain = stripAnsi(result);

    expect(plain).toContain("🧩 active-memory ▸ ✔");
    expect(plain).toContain("💡 skill-harness ▸ ✔");
    expect(result.split(`${LIGHT_GRAY}▸${RESET}`)).toHaveLength(3);
    expect(plain).not.toContain("memory_search");
    expect(plain).not.toContain("topic-triage");
    expect(plain).toContain("name: gcp-cert-exam");
    expect(plain).not.toMatch(/\(\+\d+ lines?\)/u);
  });

  it("counts an omitted detail but not a removed complete block", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory",
          toolName: "active-memory",
        }),
        entry({
          toolCallId: "active-memory:search",
          toolName: "active-memory:memory_search",
          params: {
            limit: 5,
            query: "project notes ".repeat(8),
          },
        }),
        entry({
          toolCallId: "normal",
          toolName: "bash",
          params: {
            older: `old-${"o".repeat(60)}`,
            newer: `new-${"n".repeat(60)}`,
          },
        }),
      ],
      true,
      220,
    );
    const plain = stripAnsi(result);

    expect(plain).not.toContain("active-memory");
    expect(plain).not.toContain("memory_search");
    expect(plain).not.toContain("old-");
    expect(plain).toContain("new-");
    expect(result).toContain(`${LIGHT_GRAY}(+1 line)${RESET}`);
  });

  it("does not report an outer-budget internal group as an omitted line", () => {
    const result = renderStatusContentWithState(
      [
        entry({
          toolCallId: "active-memory",
          toolName: "active-memory",
        }),
        entry({
          toolCallId: "skill-harness",
          toolName: "skill-harness",
          status: "error",
        }),
        ...Array.from({ length: 5 }, (_, index) =>
          entry({
            toolCallId: `normal-${index}`,
            toolName: `normal_${index}`,
          }),
        ),
      ],
      true,
      1_700,
      { activeMemory: "expanded", skillHarness: "collapsed" },
    );
    const plain = stripAnsi(result.content);

    expect(result.displayState).toEqual({
      activeMemory: "removed",
      skillHarness: "collapsed",
    });
    expect(plain).not.toContain("active-memory");
    expect(plain).toContain("skill-harness");
    expect(plain).toContain("normal_0");
    expect(plain).toContain("normal_4");
    expect(plain).not.toMatch(/\(\+\d+ lines?\)/u);
  });

  it("removes older equal-priority details before newer details", () => {
    const result = renderStatusContent(
      [
        entry({
          toolName: "bash",
          params: {
            older: `old-${"o".repeat(60)}`,
            newer: `new-${"n".repeat(60)}`,
          },
        }),
      ],
      true,
      180,
    );
    const plain = stripAnsi(result);

    expect(plain).not.toContain("old-");
    expect(plain).toContain("new-");
  });

  it("keeps six outer entries plus the protected main-agent failure", () => {
    const history = [
      ...Array.from({ length: 7 }, (_, index) =>
        entry({
          toolCallId: `normal-${index}`,
          toolName: `tool_${index}`,
        }),
      ),
      entry({
        toolCallId: "agent",
        toolName: "agent",
        status: "error",
        error: "provider timeout",
      }),
    ];
    const plain = stripAnsi(renderStatusContent(history, true));

    expect(plain).toContain("💥 agent ✘");
    expect(plain).not.toContain("tool_0");
    for (let index = 1; index < 7; index += 1) {
      expect(plain).toContain(`tool_${index}`);
    }
  });

  it("keeps fences, ANSI sequences, and surrogate pairs valid at tiny limits", () => {
    const history = [
      entry({
        toolName: `old_${"😀".repeat(50)}`,
        durationMs: 1234,
        params: { command: "x".repeat(500) },
      }),
    ];

    for (let limit = 12; limit < 100; limit += 1) {
      const result = renderStatusContent(history, true, limit);
      expect(result.length).toBeLessThanOrEqual(limit);
      expect(result.startsWith("```ansi\n")).toBe(true);
      expect(result.endsWith("\n```")).toBe(true);
      expect(containsOnlyCompleteAnsiSequences(result)).toBe(true);
      expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
      expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  });

  it("bounds large semantic inputs without unbounded iterative rendering", () => {
    const params = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`field_${index}`, index]),
    );
    const result = renderStatusContent(
      [entry({ toolName: "bulk", params })],
      true,
    );

    expect(result.length).toBeLessThanOrEqual(1700);
    expect(result).toMatch(/\(\+\d+ lines?\)/u);
  });

  it("renders deep-frozen history deterministically without mutation", () => {
    const history = Object.freeze([
      Object.freeze(
        entry({
          toolName: "bash",
          params: Object.freeze({ command: "x".repeat(500) }),
        }),
      ),
    ]);

    const first = renderStatusContent(history, true, 120);
    const second = renderStatusContent(history, true, 120);

    expect(second).toBe(first);
    expect(history[0].params).toEqual({ command: "x".repeat(500) });
  });
});
