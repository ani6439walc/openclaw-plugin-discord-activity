import { describe, it, expect, beforeEach } from "vitest";
import { ToolHistoryManager } from "./tool-history-manager.js";
import type { ToolEntry } from "./types.js";
import { DEFAULT_MAX_TOOL_HISTORY_LENGTH } from "./constants.js";

describe("ToolHistoryManager", () => {
  let manager: ToolHistoryManager;
  const config = {
    maxToolHistoryLength: DEFAULT_MAX_TOOL_HISTORY_LENGTH,
    maxStatusMessageLength: 1700,
    orphanTtlMs: 300000,
    maxDisplayMs: 600000,
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

  it("should find a tool entry by toolCallId", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call123",
        toolName: "web_search",
        params: { query: "hello world" },
        status: "pending",
      },
      {
        toolCallId: "call456",
        toolName: "bash",
        params: { command: "ls" },
        status: "completed",
      },
    ];

    const found = manager.findByToolCallId(history, "call123");

    expect(found).toEqual(history[0]);
  });

  it("should return undefined when tool entry is not found", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call123",
        toolName: "web_search",
        params: { query: "hello world" },
        status: "pending",
      },
    ];

    const found = manager.findByToolCallId(history, "nonexistent");

    expect(found).toBeUndefined();
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
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "pending",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
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
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "completed",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "processed result" },
        status: "completed",
      },
    ];

    manager.replaceSubagentGroup(history, "active-memory", replacements);

    // Should replace the active-memory group while keeping other entries
    expect(history).toHaveLength(4);
    expect(history[0].toolName).toBe("normal_tool");
    expect(history[1].toolName).toBe("active-memory");
    expect(history[1].status).toBe("completed");
    expect(history[2].toolName).toBe("active-memory:result");
    expect(history[2].params).toEqual({ text: "processed result" });
    expect(history[3].toolName).toBe("another_tool");
  });

  it("should find subagent entries", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call1",
        toolName: "normal_tool",
        params: {},
        status: "completed",
      },
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "pending",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "result data" },
        status: "pending",
      },
      {
        toolCallId: "intention-hint",
        toolName: "intention-hint",
        params: {},
        status: "pending",
      },
    ];

    const subagentEntries = manager.findSubagentEntries(history, "active-memory");

    expect(subagentEntries).toHaveLength(2);
    expect(subagentEntries[0].toolName).toBe("active-memory");
    expect(subagentEntries[1].toolName).toBe("active-memory:result");
  });

  it("should find subagent child entries", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call1",
        toolName: "normal_tool",
        params: {},
        status: "completed",
      },
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "pending",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "result data" },
        status: "pending",
      },
      {
        toolCallId: "active-memory:query",
        toolName: "active-memory:query",
        params: { text: "query data" },
        status: "pending",
      },
    ];

    const childEntries = manager.findSubagentChildEntries(history, "active-memory");

    expect(childEntries).toHaveLength(2);
    expect(childEntries[0].toolName).toBe("active-memory:result");
    expect(childEntries[1].toolName).toBe("active-memory:query");
  });

  it("should count pending entries correctly", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call1",
        toolName: "web_search",
        params: { query: "hello" },
        status: "pending",
      },
      {
        toolCallId: "call2",
        toolName: "bash",
        params: { command: "ls" },
        status: "completed",
      },
      {
        toolCallId: "call3",
        toolName: "web_fetch",
        params: { url: "http://example.com" },
        status: "pending",
      },
    ];

    const pendingCount = manager.getPendingCount(history);

    expect(pendingCount).toBe(2);
  });

  it("should count completed entries correctly", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call1",
        toolName: "web_search",
        params: { query: "hello" },
        status: "completed",
      },
      {
        toolCallId: "call2",
        toolName: "bash",
        params: { command: "ls" },
        status: "pending",
      },
      {
        toolCallId: "call3",
        toolName: "web_fetch",
        params: { url: "http://example.com" },
        status: "orphan-completed",
      },
    ];

    const completedCount = manager.getCompletedCount(history);

    expect(completedCount).toBe(2);
  });

  it("should count error entries correctly", () => {
    const history: ToolEntry[] = [
      {
        toolCallId: "call1",
        toolName: "web_search",
        params: { query: "hello" },
        status: "completed",
      },
      {
        toolCallId: "call2",
        toolName: "bash",
        params: { command: "ls" },
        status: "error",
        error: "Command failed",
      },
      {
        toolCallId: "call3",
        toolName: "web_fetch",
        params: { url: "http://example.com" },
        status: "error",
        error: "Network error",
      },
    ];

    const errorCount = manager.getErrorCount(history);

    expect(errorCount).toBe(2);
  });
});