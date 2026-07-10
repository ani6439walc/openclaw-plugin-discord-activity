import { describe, it, expect } from "vitest";
import { renderStatusContent, isContentTooLong } from "./render.js";
import type { ToolEntry } from "./types.js";

function makeEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    toolCallId: "call_001",
    toolName: "bash",
    params: { command: "ls" },
    status: "pending",
    ...overrides,
  };
}

describe("renderStatusContent", () => {
  it("renders a single pending tool", () => {
    const result = renderStatusContent([makeEntry()], false);
    expect(result).toContain("bash");
    expect(result).toContain("←");
    expect(result).toContain("```yaml");
  });

  it("renders completed tool with checkmark when final", () => {
    const result = renderStatusContent(
      [makeEntry({ status: "completed" })],
      true,
    );
    expect(result).toContain("bash");
    expect(result).toContain("✔");
  });

  it("renders error tool with x mark", () => {
    const result = renderStatusContent([makeEntry({ status: "error" })], false);
    expect(result).toContain("✘");
  });

  it("renders normal tool error with error message detail", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          status: "error",
          error: "permission denied",
        }),
      ],
      false,
    );
    expect(result).toContain("bash: ✘");
    expect(result).toContain("error: permission denied");
  });

  it("quotes single-line string params containing colons", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          params: { query: "site:example.com status:open" },
          status: "completed",
        }),
      ],
      true,
    );

    expect(result).toContain('query: "site:example.com status:open"');
  });

  it("quotes error messages containing colons", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          status: "error",
          error: "failed: timeout",
        }),
      ],
      true,
    );

    expect(result).toContain('   - error: "failed: timeout"');
  });

  it("quotes strings that begin with YAML indicators or numeric literal syntax", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          params: {
            quoted: '"already quoted"',
            dash: "- item",
            question: "? key",
            hex: "0x1A",
            octal: "0o77",
          },
          status: "completed",
        }),
      ],
      true,
    );

    expect(result).toContain('quoted: "\\\"already quoted\\\""');
    expect(result).toContain('dash: "- item"');
    expect(result).toContain('question: "? key"');
    expect(result).toContain('hex: "0x1A"');
    expect(result).toContain('octal: "0o77"');
  });

  it("renders orphan-completed with recycle mark", () => {
    const result = renderStatusContent(
      [makeEntry({ status: "orphan-completed" })],
      false,
    );
    expect(result).toContain("♻︎");
  });

  it("renders active-memory group with completed suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "am1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "am2",
        toolName: "active-memory:memory_read",
        params: { id: "123" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(result).toContain("🧩 active-memory: ✔");
    expect(result).toContain("memory_search");
    expect(result).toContain("memory_read");
  });

  it("renders active-memory result as the last nested item", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "am1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "每日早報重跑已觸發" },
        status: "completed",
      },
    ];

    const result = renderStatusContent(entries, true);
    expect(result).toContain("memory_search");
    expect(result).toContain("- result: 每日早報重跑已觸發");
    expect(result.indexOf("memory_search")).toBeLessThan(
      result.indexOf("- result: 每日早報重跑已觸發"),
    );
  });

  it("renders subagent result entries after other nested tools regardless of history order", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "NONE" },
        status: "completed",
      },
      {
        toolCallId: "active-memory:mem1",
        toolName: "active-memory:memory_search",
        params: { query: "7-11 賣貨便 出貨" },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: JSON.stringify({ intent: "answer-question" }) },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:topic-triage",
        params: { domain: "tools" },
        status: "completed",
      },
    ];

    const result = renderStatusContent(entries, true);

    expect(result.indexOf("memory_search")).toBeLessThan(
      result.indexOf("- result: NONE"),
    );
    expect(result.indexOf("topic-triage")).toBeLessThan(
      result.indexOf("- intent: answer-question"),
    );
  });

  it("limits normal entries separately from subagent child entries", () => {
    const normalEntries = Array.from({ length: 7 }, (_, index) =>
      makeEntry({
        toolCallId: `normal_${index}`,
        toolName: `normal_tool_${index}`,
        status: "completed",
      }),
    );
    const activeMemoryEntries: ToolEntry[] = Array.from(
      { length: 7 },
      (_, index) => ({
        toolCallId: `active-memory:mem_${index}`,
        toolName: `active-memory:memory_search_${index}`,
        params: { query: `memory ${index}` },
        status: "completed",
      }),
    );
    const skillHarnessEntries: ToolEntry[] = Array.from(
      { length: 7 },
      (_, index) => ({
        toolCallId: `skill-harness:phase_${index}`,
        toolName: `skill-harness:phase_${index}`,
        params: { result: `hint ${index}` },
        status: "completed",
      }),
    );

    const result = renderStatusContent(
      [...activeMemoryEntries, ...skillHarnessEntries, ...normalEntries],
      true,
    );

    expect(result).not.toContain("normal_tool_0");
    expect(result).toContain("normal_tool_1");
    expect(result).not.toContain("memory_search_0");
    expect(result).toContain("memory_search_1");
    expect(result).not.toContain("phase_0");
    expect(result).toContain("phase_1");
  });

  it("keeps subagent result entries at the end when limiting child entries", () => {
    const entries: ToolEntry[] = [
      ...Array.from({ length: 7 }, (_, index) => ({
        toolCallId: `active-memory:mem_${index}`,
        toolName: `active-memory:memory_search_${index}`,
        params: { query: `memory ${index}` },
        status: "completed" as const,
      })),
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "final result" },
        status: "completed",
      },
    ];

    const result = renderStatusContent(entries, true);

    expect(result).not.toContain("memory_search_0");
    expect(result).not.toContain("memory_search_1");
    expect(result).toContain("memory_search_2");
    expect(result.indexOf("memory_search_6")).toBeLessThan(
      result.indexOf("- result: final result"),
    );
  });

  it("renders active-memory group with pending suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "pending",
      },
    ];
    const result = renderStatusContent(entries, false);
    expect(result).toContain("🧩 active-memory: ←");
  });

  it("renders skill-harness group with pending suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        params: {},
        status: "pending",
      },
    ];
    const result = renderStatusContent(entries, false);
    expect(result).toContain("💡 skill-harness: ←");
  });

  it("renders skill-harness plain text result with a result label", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "INTENT:RESEARCH | GOAL: docs" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(result).toContain("💡 skill-harness: ✔");
    expect(result).toContain('- result: "INTENT:RESEARCH | GOAL: docs"');
  });

  it("quotes skill-harness JSON object string fields containing colons", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({
            intent: "skill-lifecycle",
            reason: "User said: keep templates separate",
          }),
        },
        status: "completed",
      },
    ];

    const result = renderStatusContent(entries, true);
    expect(result).toContain("- intent: skill-lifecycle");
    expect(result).toContain(
      '     reason: "User said: keep templates separate"',
    );
  });

  it("renders skill-harness result as key-value when JSON object", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({ intent: "RESEARCH", confidence: 0.9 }),
        },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(result).toContain("💡 skill-harness: ✔");
    expect(result).toContain("- intent: RESEARCH");
    expect(result).toContain("     confidence: 0.9");
  });

  it("renders multiple skill-harness JSON results without result wrappers", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result:1",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({
            keywords: ["收巡", "codex"],
            topic: "user requesting to check or review codex",
            topicChanged: true,
            topicChangeReason: "keyword_delta",
            complexity: "low",
          }),
        },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result:2",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({
            intent: "code-review",
            reason: "User is asking to check or review codex.",
            confidence: 0.75,
            complexity: "low",
          }),
        },
        status: "completed",
      },
    ];

    const result = renderStatusContent(entries, true);
    expect(result).toContain("💡 skill-harness: ✔");
    expect(result).toContain('- keywords: ["收巡","codex"]');
    expect(result).toContain(
      "     topic: user requesting to check or review codex",
    );
    expect(result).toContain("- intent: code-review");
    expect(result).toContain("     confidence: 0.75");
    expect(result).not.toContain("- result:");
  });

  it("renders string array skill-harness fields inline", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:topic-continuity-check",
        params: {
          domain: "follow-up",
          keywords: ["再看", "一次"],
          topic: "User is asking to view something again.",
        },
        status: "completed",
      },
    ];

    const result = renderStatusContent(entries, true);
    expect(result).toContain('       keywords: ["再看","一次"]');
    expect(result).not.toContain("keywords: |");
  });

  it("indents multiline phase result under the result key", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:instruction-hint-generation",
        params: {
          result: "Intent: memory-recent\n\nSuggested workflow",
        },
        status: "completed",
      },
    ];

    const result = renderStatusContent(entries, true);
    expect(result).toContain(
      [
        "     - result: |",
        "         Intent： memory-recent",
        "         ",
        "         Suggested workflow",
      ].join("\n"),
    );
  });

  it("renders active-memory group with error suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "error",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(result).toContain("🧩 active-memory: ✘");
  });

  it("renders active-memory error with error message detail", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "error",
        error: "timed out after 15000ms",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(result).toContain("🧩 active-memory: ✘");
    expect(result).toContain("error: timed out after 15000ms");
  });

  it("renders mixed normal and active-memory entries", () => {
    const entries: ToolEntry[] = [
      makeEntry({ toolName: "web_search", status: "completed" }),
      {
        toolCallId: "am1",
        toolName: "active-memory:search",
        params: {},
        status: "completed",
      },
      makeEntry({ toolName: "read", status: "pending" }),
    ];
    const result = renderStatusContent(entries, false);
    expect(result).toContain("web_search");
    expect(result).toContain("active-memory");
    expect(result).toContain("read");
  });

  it("renders subagent groups first sorted by ascending name", () => {
    const entries: ToolEntry[] = [
      makeEntry({ toolName: "read", status: "pending" }),
      {
        toolCallId: "active-memory:mem1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "result" },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "INTENT:RESEARCH" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    const amPos = result.indexOf("active-memory");
    const ihPos = result.indexOf("skill-harness");
    const readPos = result.indexOf("read");
    expect(amPos).toBeLessThan(ihPos);
    expect(ihPos).toBeLessThan(readPos);
    expect(amPos).toBeGreaterThanOrEqual(0);
    expect(ihPos).toBeGreaterThanOrEqual(0);
    expect(readPos).toBeGreaterThanOrEqual(0);
  });

  it("renders subagent groups first sorted by ascending name regardless of input order", () => {
    const entries: ToolEntry[] = [
      makeEntry({ toolName: "bash", status: "completed" }),
      {
        toolCallId: "active-memory:mem1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "INTENT:RESEARCH" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    const amPos = result.indexOf("active-memory");
    const ihPos = result.indexOf("skill-harness");
    const bashPos = result.indexOf("bash");
    expect(amPos).toBeLessThan(ihPos);
    expect(ihPos).toBeLessThan(bashPos);
    expect(amPos).toBeGreaterThanOrEqual(0);
    expect(ihPos).toBeGreaterThanOrEqual(0);
    expect(bashPos).toBeGreaterThanOrEqual(0);
  });
});

describe("isContentTooLong", () => {
  it("returns true when content exceeds max length", () => {
    expect(isContentTooLong("x".repeat(1701), 1)).toBe(true);
  });

  it("does not use aggregate entry count for content length checks", () => {
    expect(isContentTooLong("short", 7)).toBe(false);
  });

  it("returns false when within limits", () => {
    expect(isContentTooLong("short", 1)).toBe(false);
  });
});
