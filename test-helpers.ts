import type { SessionEntry, ToolEntry, OrphanEntry } from "./src/types.js";
import type { AgentContext, AgentEndEvent } from "./src/types.js";
import type { createHookHandlers } from "./src/hooks.js";
import { defaultStore } from "./src/session.js";
import { getDiscordContextKey } from "./src/parser.js";

/** Deliver logical completion separately from attempt and outbound hooks. */
export async function settleRun(
  handlers: ReturnType<typeof createHookHandlers>,
  event: AgentEndEvent,
  ctx: AgentContext,
): Promise<void> {
  const key = getDiscordContextKey(ctx.sessionKey);
  const session = key ? defaultStore.sessions.get(key) : undefined;
  const runId = ctx.runId ?? session?.runId ?? "fixture-run";
  if (session && !session.runId && session.ownerSessionKey === ctx.sessionKey) {
    await handlers.onBeforeAgentReply({ cleanedBody: "" }, { ...ctx, runId });
  }
  await handlers.onAgentLifecycleEvent({
    sessionKey: ctx.sessionKey,
    runId,
    stream: "lifecycle",
    data: {
      phase: event.success === false || event.error ? "error" : "end",
      executionSettled: true,
      error: event.error,
    },
  });
}

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createMockSessionEntry(
  overrides?: Partial<SessionEntry>,
): SessionEntry {
  return {
    contextKey: "discord:channel:123456",
    channelId: "123456",
    userMessageId: "msg_001",
    senderId: "user_001",
    accountId: undefined,
    ownerSessionKey: "discord:channel:123456:agent:abc",
    generation: 1,
    statusMessageId: undefined,
    lastRenderedContent: undefined,
    finalized: false,
    toolHistory: [],
    pendingOp: undefined,
    clearTimer: undefined,
    maxDisplayTimer: undefined,
    ...overrides,
  };
}

export function createToolEntry(overrides?: Partial<ToolEntry>): ToolEntry {
  return {
    toolCallId: "call_001",
    toolName: "bash",
    params: { command: "ls" },
    status: "completed",
    durationMs: 150,
    ...overrides,
  };
}

export function createOrphanEntry(
  overrides?: Partial<OrphanEntry>,
): OrphanEntry {
  return {
    toolCallId: "call_orphan_001",
    toolName: "mcp_tool",
    params: { query: "test" },
    createdAt: Date.now(),
    ...overrides,
  };
}
