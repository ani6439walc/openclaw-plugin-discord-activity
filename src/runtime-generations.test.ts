import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";

async function loadGeneration() {
  vi.resetModules();
  const { createHookHandlers } = await import("./hooks.js");
  const { defaultStore, defaultOrphans } = await import("./session.js");
  return {
    store: defaultStore,
    handlers: createHookHandlers({
      store: defaultStore,
      orphans: defaultOrphans,
      getToken: () => "test-token",
      config: resolveConfig({}),
      isSkillHarnessEnabled: () => false,
    }),
  };
}

describe("activity across plugin generations", () => {
  const sessionKey = "agent:main:discord:channel:123456789012345678";
  const contextKey = "discord:channel:123456789012345678";
  const generations: Awaited<ReturnType<typeof loadGeneration>>[] = [];

  afterEach(() => {
    for (const { store } of generations) {
      for (const session of store.sessions.values()) {
        clearTimeout(session.clearTimer);
        clearTimeout(session.maxDisplayTimer);
      }
      store.sessions.clear();
      store.contexts.clear();
    }
    generations.length = 0;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("updates the inbound status when tools start and finish in other module generations", async () => {
    const contents: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        if (typeof body.content === "string") contents.push(body.content);
        return new Response(JSON.stringify({ id: "status-1" }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const inbound = await loadGeneration();
    const tools = await loadGeneration();
    const agent = await loadGeneration();
    generations.push(inbound, tools, agent);
    await inbound.handlers.onMessageReceived(
      { messageId: "message-1" },
      {
        channelId: "discord",
        sessionKey,
        conversationId: "channel:123456789012345678",
        runId: "main-run",
      },
    );
    await tools.handlers.onBeforeToolCall(
      {
        toolName: "exec",
        toolCallId: "main-tool",
        params: { command: "pwd" },
        runId: "main-run",
      },
      { sessionKey, runId: "main-run", toolName: "exec" },
    );
    await agent.handlers.onAfterToolCall(
      {
        toolName: "exec",
        toolCallId: "main-tool",
        params: { command: "pwd" },
        runId: "main-run",
        durationMs: 50,
      },
      { sessionKey, runId: "main-run", toolName: "exec" },
    );

    expect(inbound.store.sessions.get(contextKey)?.toolHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "main-tool",
          status: "completed",
        }),
      ]),
    );
    expect(contents.at(-1)).toContain("exec");
  });
});
