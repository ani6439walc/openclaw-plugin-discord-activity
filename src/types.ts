export type ChannelMeta = {
  actualChannelId: string;
  userMessageId?: string;
  senderId?: string;
  accountId?: string;
  sourceSessionKey?: string;
};

export type ToolEntry = {
  toolCallId: string;
  toolName: string;
  params: any;
  status: "pending" | "completed" | "error" | "orphan-completed";
  durationMs?: number;
};

export type AgentMessageContentItem = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

export type AgentEventMessage = {
  role?: string;
  content?: AgentMessageContentItem[];
  toolCallId?: string;
  toolName?: string;
};

export type OrphanEntry = {
  toolCallId: string;
  toolName: string;
  params: any;
  createdAt: number;
};

export type SessionEntry = {
  contextKey: string;
  channelId: string;
  userMessageId?: string;
  senderId?: string;
  accountId?: string;
  ownerSessionKey: string;
  generation: number;
  statusMessageId?: string;
  toolHistory: ToolEntry[];
  pendingOp?: Promise<void>;
  clearTimer?: ReturnType<typeof setTimeout>;
};

import type { PluginConfig } from "./config.js";

export type GetTokenFn = (accountId?: string) => string;

export type SessionStore = {
  readonly sessions: Map<string, SessionEntry>;
  readonly contexts: Map<string, ChannelMeta>;
  isCurrentSession(session: SessionEntry): boolean;
  hasVisibleStatusState(session: SessionEntry): boolean;
  getOrCreateSession(
    contextKey: string,
    requestSessionKey?: string,
  ): SessionEntry | undefined;
  resolveSession(
    contextKey: string,
    requestSessionKey?: string,
  ): Promise<SessionEntry | undefined>;
  clearSessionState(
    contextKey: string,
    session?: SessionEntry,
    expectedGeneration?: number,
    expectedOwner?: string,
  ): void;
  waitForPendingOp(session: SessionEntry, hookName: string): Promise<void>;
};

export type OrphanToolManager = {
  add(entry: OrphanEntry): void;
  get(toolCallId: string): OrphanEntry | undefined;
  remove(toolCallId: string): boolean;
  pruneStale(): void;
};

export type HookDeps = {
  store: SessionStore;
  orphans: OrphanToolManager;
  getToken: GetTokenFn;
  config: PluginConfig;
  isActiveMemoryEnabled: (agentId: string) => boolean;
};

export type StatusRenderResult = {
  content: string;
  trimmed: boolean;
};

export type MessageReceivedEvent = {
  metadata?: Record<string, unknown>;
  messageId?: string;
};

export type MessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  messageId?: string;
  senderId?: string;
  messageProvider?: string;
};

export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
};

export type ToolContext = {
  sessionKey?: string;
  toolName: string;
  toolCallId?: string;
};

export type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  error?: string;
  durationMs?: number;
};

export type MessageSendingEvent = {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type BeforeAgentReplyEvent = {
  cleanedBody: string;
};

export type AgentContext = {
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  messageProvider?: string;
};

export type AgentEndEvent = {
  messages?: unknown[];
  success?: boolean;
  error?: string;
  durationMs?: number;
};
