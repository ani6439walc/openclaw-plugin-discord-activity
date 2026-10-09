import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { createOrphanManager } from "./orphans.js";
import { renderStatusContent } from "./render.js";
import { defaultStore } from "./session.js";
import type { ToolEntry } from "./types.js";

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

describe("main agent failure rendering", () => {
  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders internal groups, normal tools, then an agent failure with its error", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "active-memory:mem_1",
          toolName: "active-memory:memory_search",
        }),
        entry({
          toolCallId: "skill-harness:phase_1",
          toolName: "skill-harness:phase_1",
        }),
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
          error: "provider timeout",
        }),
        entry({
          toolCallId: "call_2",
          toolName: "bash",
          status: "error",
          error: "permission denied",
        }),
      ],
      true,
    );

    const plain = stripAnsi(result);
    expect(plain).toContain("💥 agent ✘");
    expect(plain).toContain("error: provider timeout");
    expect(plain).toContain("bash ▾ ✘");
    expect(plain).toContain("error: permission denied");
    expect(result.indexOf("active-memory")).toBeLessThan(
      result.indexOf("skill-harness"),
    );
    expect(result.indexOf("skill-harness")).toBeLessThan(
      result.indexOf("bash"),
    );
    expect(result.indexOf("bash")).toBeLessThan(result.indexOf("💥 agent"));
  });

  it("does not invent an error detail when the failure has none", () => {
    const result = renderStatusContent(
      [
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
        }),
      ],
      true,
    );

    expect(stripAnsi(result)).toContain("💥 agent ✘");
    expect(stripAnsi(result)).not.toContain("error:");
  });

  it("counts the protected agent failure in the shared six-block limit", () => {
    const normalEntries = Array.from({ length: 7 }, (_, index) =>
      entry({
        toolCallId: `call_${index}`,
        toolName: `normal_${index}`,
      }),
    );
    const result = renderStatusContent(
      [
        ...normalEntries,
        entry({
          toolCallId: "agent",
          toolName: "agent",
          status: "error",
        }),
      ],
      true,
    );

    expect(stripAnsi(result)).toContain("💥 agent ✘");
    expect(result).not.toContain("normal_0");
    expect(result).not.toContain("normal_1");
    for (let index = 2; index < 7; index += 1) {
      expect(result).toContain(`normal_${index}`);
    }
  });

  it("records and displays a failure-only main agent run", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const handlers = createHookHandlers({
      store: defaultStore,
      orphans: createOrphanManager(),
      getToken: () => "token",
      config: resolveConfig({}),
      isActiveMemoryEnabled: () => false,
      isSkillHarnessEnabled: () => false,
    });
    const sessionKey = "discord:channel:123";

    await handlers.onMessageReceived(
      { messageId: "user_1", metadata: { to: "channel:123" } },
      { channelId: "discord", sessionKey },
    );
    await handlers.onAgentEnd(
      { success: false, error: "provider timeout", messages: [] },
      { sessionKey },
    );

    const session = defaultStore.sessions.get("discord:channel:123");
    expect(session?.toolHistory).toContainEqual(
      expect.objectContaining({
        toolCallId: "agent",
        toolName: "agent",
        status: "error",
        error: "provider timeout",
      }),
    );
    const plainContent = stripAnsi(session?.lastRenderedContent ?? "");
    expect(plainContent).toContain("💥 agent ✘");
    expect(plainContent).toContain("error: provider timeout");
    expect(session?.clearTimer).toBeDefined();
  });

  it("ignores a late agent_end from a replaced run", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : jsonResponse({ id: "status_1" }),
      ),
    );
    const handlers = createHookHandlers({
      store: defaultStore,
      orphans: createOrphanManager(),
      getToken: () => "token",
      config: resolveConfig({}),
      isActiveMemoryEnabled: () => false,
      isSkillHarnessEnabled: () => false,
    });
    const sessionKey = "discord:channel:123";

    await handlers.onMessageReceived(
      { messageId: "user_old", metadata: { to: "channel:123" } },
      { channelId: "discord", sessionKey, runId: "run_old" },
    );
    const oldSession = defaultStore.sessions.get("discord:channel:123")!;
    oldSession.toolHistory.push(entry({ status: "completed" }));
    await handlers.onMessageSending(
      { to: "channel:123", content: "old reply" },
      { channelId: "discord", sessionKey, runId: "run_old" },
    );

    await handlers.onMessageReceived(
      { messageId: "user_new", metadata: { to: "channel:123" } },
      { channelId: "discord", sessionKey },
    );
    const replacement = defaultStore.sessions.get("discord:channel:123")!;
    expect(replacement).not.toBe(oldSession);

    await handlers.onAgentEnd(
      { success: false, error: "old provider timeout" },
      { sessionKey, runId: "run_old" },
    );

    expect(replacement.finalized).toBe(false);
    expect(replacement.clearTimer).toBeUndefined();
    expect(replacement.toolHistory).not.toContainEqual(
      expect.objectContaining({ toolCallId: "agent" }),
    );
  });
});
