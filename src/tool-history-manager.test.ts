import { describe, it, expect, beforeEach } from "vitest";
import { ToolHistoryManager } from "./tool-history-manager.js";
import type { ToolEntry } from "./types.js";
import { DEFAULT_MAX_TOOL_HISTORY_LENGTH } from "./constants.js";

describe("ToolHistoryManager", () => {
  let manager: ToolHistoryManager;
  const config = {
    maxToolHistoryLength: DEFAULT_MAX_TOOL_HISTORY_LENGTH,
    maxStatusMessageLength: 1700,
    orphanTtlSeconds: 300,
    maxDisplaySeconds: 180,
  };

  beforeEach(() => {
    manager = new ToolHistoryManager(config);
  });

  it("should add a new tool entry", () => {
    const history: ToolEntry[] = [];
    const entry: ToolEntry = {
      toolCallId: "call123",
      toolName: "web_search",
      params: { query: "hello world" },
      status: "pending",
    };

    manager.addEntry(history, entry);

    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(entry);
    expect(history[0].displayId).toBe("call123");
  });

  it("preserves display identity when a provider call id changes", () => {
    const history: ToolEntry[] = [];
    manager.addEntry(history, {
      toolCallId: "before-call",
      toolName: "web_search",
      params: {},
      status: "pending",
    });

    manager.updateEntry(history, "before-call", {
      toolCallId: "after-call",
      status: "completed",
    });

    expect(history[0]).toMatchObject({
      displayId: "before-call",
      toolCallId: "after-call",
    });
  });

  it("should update an existing tool entry", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call123",
        toolName: "web_search",
        params: { query: "hello world" },
        status: "pending",
      },
    ];

    const updated = manager.updateEntry(history, "call123", {
      status: "completed",
      durationMs: 100,
    });

    expect(updated).toBe(true);
    expect(history[0].status).toBe("completed");
    expect(history[0].durationMs).toBe(100);
  });

  it("should return false when updating a non-existent entry", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call123",
        toolName: "web_search",
        params: { query: "hello world" },
        status: "pending",
      },
    ];

    const updated = manager.updateEntry(history, "nonexistent", {
      status: "completed",
    });

    expect(updated).toBe(false);
    expect(history[0].status).toBe("pending"); // Should remain unchanged
  });

  it("should trim history to max length", () => {
    const history: ToolEntry[] = [];
    for (let i = 0; i < 15; i++) {
      history.push({
        toolCallId: `call${i}`,
        toolName: "web_search",
        params: { query: `query ${i}` },
        status: "pending",
      });
    }

    // Set max length to 5
    const managerWithLimit = new ToolHistoryManager({
      ...config,
      maxToolHistoryLength: 5,
    });
    managerWithLimit.trim(history);

    expect(history).toHaveLength(5);
    // The oldest entries should be removed, keeping the newest
    expect(history[0].toolCallId).toBe("call10");
    expect(history[4].toolCallId).toBe("call14");
  });

  it("should replace subagent group", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call1",
        toolName: "normal_tool",
        params: {},
        status: "completed",
      },
      {
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        params: {},
        status: "pending",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "result data" },
        status: "pending",
      },
      {
        toolCallId: "call2",
        toolName: "another_tool",
        params: {},
        status: "pending",
      },
    ];

    const replacements: ToolEntry[] = [
      {
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        params: {},
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "processed result" },
        status: "completed",
      },
    ];

    manager.replaceSubagentGroup(history, "skill-harness", replacements);

    // Should replace the skill-harness group while keeping other entries
    expect(history).toHaveLength(4);
    expect(history[0].toolName).toBe("normal_tool");
    expect(history[1].toolName).toBe("skill-harness");
    expect(history[1].status).toBe("completed");
    expect(history[2].toolName).toBe("skill-harness:result");
    expect(history[2].params).toEqual({ text: "processed result" });
    expect(history[3].toolName).toBe("another_tool");
  });

  it("replaces non-contiguous subagent entries without leaving duplicates", () => {
    const memorySearch: ToolEntry = {
      toolCallId: "skill-harness:memory_search",
      toolName: "skill-harness:memory_search",
      params: { query: "hello" },
      status: "completed",
    };
    const wikiSearch: ToolEntry = {
      toolCallId: "skill-harness:wiki_search",
      toolName: "skill-harness:wiki_search",
      params: { query: "hello" },
      status: "completed",
    };
    const history: ToolEntry[] = [
      {
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        params: {},
        status: "pending",
      },
      {
        toolCallId: "hindsight-memory",
        toolName: "hindsight-memory",
        params: {},
        status: "pending",
      },
      memorySearch,
      wikiSearch,
    ];

    manager.replaceSubagentGroup(history, "skill-harness", [
      memorySearch,
      wikiSearch,
    ]);

    expect(history.map((entry) => entry.toolName)).toEqual([
      "skill-harness:memory_search",
      "skill-harness:wiki_search",
      "hindsight-memory",
    ]);
  });
});
