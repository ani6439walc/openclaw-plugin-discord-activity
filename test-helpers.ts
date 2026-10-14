import type { SessionEntry, ToolEntry, OrphanEntry } from "./src/types.js";

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
