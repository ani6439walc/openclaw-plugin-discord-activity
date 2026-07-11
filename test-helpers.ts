import { vi } from "vitest";
import type { Mock } from "vitest";
import type {
  SessionEntry,
  ChannelMeta,
  ToolEntry,
  OrphanEntry,
} from "./src/types.js";

export type Handler = (event: any, ctx: any) => Promise<any>;

export const mockLogger = {
  trace: vi.fn() as Mock<(message?: string, ...args: unknown[]) => void>,
  debug: vi.fn() as Mock<(message?: string, ...args: unknown[]) => void>,
  warn: vi.fn() as Mock<(message?: string, ...args: unknown[]) => void>,
};

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

export function getLastStatusContent(calls: any[], channelId: string): string {
  const relevant = calls.filter(([url, init]) => {
    const method = (init as RequestInit | undefined)?.method ?? "POST";
    return (
      String(url).includes(`/channels/${channelId}/messages`) &&
      (method === "POST" || method === "PATCH")
    );
  });
  const last = relevant[relevant.length - 1];
  if (!last) return "";
  const body = JSON.parse(
    String((last[1] as RequestInit | undefined)?.body ?? "{}"),
  ) as { content?: string };
  return body.content ?? "";
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

export function createMockChannelMeta(
  overrides?: Partial<ChannelMeta>,
): ChannelMeta {
  return {
    actualChannelId: "123456",
    userMessageId: "msg_001",
    senderId: "user_001",
    ...overrides,
  };
}

export function createMockDiscordApi(): {
  sendMessage: Mock<() => Promise<string>>;
  editMessage: Mock<() => Promise<boolean>>;
  deleteMessage: Mock<() => Promise<boolean>>;
  resolveDmChannel: Mock<() => Promise<string>>;
} {
  return {
    sendMessage: vi.fn().mockResolvedValue("msg_status_001"),
    editMessage: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    resolveDmChannel: vi.fn().mockResolvedValue("dm_channel_001"),
  };
}

export function createMockTokenResolver(
  token = "test-bot-token",
): Mock<() => string> {
  return vi.fn().mockReturnValue(token);
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
