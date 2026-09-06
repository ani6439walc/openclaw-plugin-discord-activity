import { describe, expect, it } from "vitest";
import {
  isCanonicalDirectSessionKey,
  parseActiveMemoryPromptContext,
  parseActiveMemoryToolEntries,
} from "./parser.js";

describe("isCanonicalDirectSessionKey", () => {
  it.each([
    "discord:direct:123",
    "DISCORD:DIRECT:123",
    "agent:main:discord:direct:123",
  ])("accepts canonical direct session key %s", (sessionKey) => {
    expect(isCanonicalDirectSessionKey(sessionKey)).toBe(true);
  });

  it.each([
    undefined,
    "discord:channel:123",
    "discord:group:123",
    "discord:dm:123",
    "discord:chat:123",
    "discord:direct:",
    "discord:direct:user-123",
    "discord:direct:+123",
    "discord:direct:1.2",
    "discord:direct:123:extra",
    "discord:direct:123\n",
    "discord:direct:123 ",
    "notdiscord:direct:123",
  ])("rejects non-canonical session key %s", (sessionKey) => {
    expect(isCanonicalDirectSessionKey(sessionKey)).toBe(false);
  });
});

describe("parseActiveMemoryToolEntries", () => {
  it("normalizes JSON-string tool arguments", () => {
    const entries = parseActiveMemoryToolEntries({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "functions.memory_search:0",
              name: "memory_search",
              arguments:
                '{"query":"你好","corpus":"memory","maxResults":5,"minScore":0.2}',
            },
          ],
        },
      ],
    });

    expect(entries[0]?.params).toEqual({
      query: "你好",
      corpus: "memory",
      maxResults: 5,
      minScore: 0.2,
    });
  });

  it("keeps an earlier transcript failure sticky across duplicate success results", () => {
    const entries = parseActiveMemoryToolEntries({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "memory_search",
              arguments: { query: "hello" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "memory_search",
          content: [{ type: "text", text: "database unavailable" }],
          isError: true,
          durationMs: 42,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "memory_search",
          content: [{ type: "text", text: "late duplicate success" }],
          isError: false,
          durationMs: 99,
        },
      ],
    });

    expect(entries).toContainEqual(
      expect.objectContaining({
        toolCallId: "active-memory:call_1",
        status: "error",
        error: "database unavailable",
        durationMs: 42,
      }),
    );
  });
});

describe("active-memory prompt context", () => {
  it("extracts and decodes the first complete memory block", () => {
    const result = parseActiveMemoryPromptContext(
      [
        "Context:",
        "<active_memory_plugin>",
        "- A &amp; B &lt; C &gt; D &quot;quoted&quot; &apos;single&apos;.",
        "- Second memory. (Source: MEMORY.md#L12)",
        "</active_memory_plugin>",
        "<active_memory_plugin>ignored</active_memory_plugin>",
        "User request",
      ].join("\n"),
    );

    expect(result).toEqual({
      kind: "memory",
      text: [
        "- A & B < C > D \"quoted\" 'single'.",
        "- Second memory. (Source: MEMORY.md#L12)",
      ].join("\n"),
    });
  });

  it.each([
    undefined,
    null,
    42,
    "no active memory context",
    "<active_memory_plugin>missing close",
    "missing open</active_memory_plugin>",
    "<active_memory_plugin>   </active_memory_plugin>",
  ])("rejects missing, malformed, or empty context %#", (prompt) => {
    expect(parseActiveMemoryPromptContext(prompt)).toBeUndefined();
  });

  it.each([
    [
      "Active Memory intentionally skipped deep recall because this turn did not ask for past context.",
      "skipped",
    ],
    [
      "Active Memory could not retrieve memory for this turn. Do not assume that no relevant memory exists.",
      "unavailable",
    ],
  ] as const)("classifies fixed outcome %s", (text, outcome) => {
    expect(
      parseActiveMemoryPromptContext(
        `<active_memory_plugin>${text}</active_memory_plugin>`,
      ),
    ).toEqual({ kind: "outcome", outcome });
  });

  it("sanitizes control sequences and bounds lines by Unicode code point", () => {
    const longLine = `😀${"x".repeat(240)}`;
    const result = parseActiveMemoryPromptContext(
      `<active_memory_plugin>\u001b[31m${longLine}\u0000\nsecond\nthird\nfourth</active_memory_plugin>`,
    );

    expect(result?.kind).toBe("memory");
    if (result?.kind !== "memory") return;
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(3);
    expect([...lines[0]].length).toBe(220);
    expect(lines[0]?.startsWith("😀")).toBe(true);
    expect(result.text).not.toContain("\u001b");
    expect(result.text).not.toContain("\u0000");
    expect([...result.text].length).toBeLessThanOrEqual(660);
  });
});
