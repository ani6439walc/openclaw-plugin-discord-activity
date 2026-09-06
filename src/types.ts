export type ChannelMeta = {
  actualChannelId: string;
  userMessageId?: string;
  senderId?: string;
  accountId?: string;
  sourceSessionKey?: string;
  runId?: string;
};

export type ToolEntry = {
  toolCallId: string;
  displayId?: string;
  toolName: string;
  params: any;
  status: "pending" | "completed" | "error" | "orphan-completed";
  startedAtMs?: number;
  durationMs?: number;
  error?: string;
};

export type SubagentToolName = "active-memory" | "skill-harness";

export type StatusBlockDisplayLevel = "expanded" | "collapsed" | "removed";

export type StatusDisplayState = Record<string, StatusBlockDisplayLevel>;

export type AgentMessageContentItem = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  text?: string;
};

export type AgentEventMessage = {
  role?: string;
  content?: string | AgentMessageContentItem[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  error?: string;
  durationMs?: number;
  details?: unknown;
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
  runId?: string;
  supersededRunIds?: Set<string>;
  statusMessageId?: string;
  statusCreateNonce?: string;
  lastRenderedContent?: string;
  contentDeliveryUncertain?: boolean;
  confirmedDisplayState?: StatusDisplayState;
  monotonicSafetyFloor?: StatusDisplayState;
  finalized?: boolean;
  compactionActive?: boolean;
  compactionEpoch?: number;
  toolHistory: ToolEntry[];
  pendingOp?: Promise<void>;
  clearTimer?: ReturnType<typeof setTimeout>;
  maxDisplayTimer?: ReturnType<typeof setTimeout>;
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
  isSkillHarnessEnabled: (agentId: string) => boolean;
};

export type StatusRenderResult = {
  content: string;
  trimmed: boolean;
};

export type StatefulStatusRenderResult = {
  content: string;
  displayState: StatusDisplayState;
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
  runId?: string;
  messageId?: string;
  senderId?: string;
  messageProvider?: string;
  trigger?: string;
};

export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

export type ToolContext = {
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

export type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  error?: string;
  durationMs?: number;
};

export type MessageSendingEvent = {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type BeforeAgentRunEvent = {
  prompt: string;
  messages: unknown[];
};

export type BeforeAgentReplyEvent = {
  cleanedBody: string;
};

export type AgentContext = {
  sessionKey?: string;
  runId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  messageProvider?: string;
};

export type LlmInputEvent = {
  prompt?: unknown;
  runId?: string;
};

export type AgentEndEvent = {
  messages?: unknown[];
  success?: boolean;
  error?: string;
  durationMs?: number;
};

export type BeforeCompactionEvent = {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
  messages?: unknown[];
  sessionFile?: string;
};

export type AfterCompactionEvent = {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  sessionFile?: string;
  previousSessionId?: string;
};

export type AgentPipelineEvent = {
  runId: string;
  stream: string;
  sessionKey?: string;
  data: Record<string, unknown>;
};
