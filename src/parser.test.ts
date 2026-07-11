import { describe, expect, it } from "vitest";
import { parseActiveMemoryToolEntries } from "./parser.js";

describe("parseActiveMemoryToolEntries", () => {
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
