import { logger } from "../api.js";
import type {
  SessionEntry,
  ToolEntry,
  HookDeps,
  MessageReceivedEvent,
  MessageContext,
  BeforeToolCallEvent,
  ToolContext,
  AfterToolCallEvent,
  MessageSendingEvent,
  BeforeAgentReplyEvent,
  AgentContext,
  AgentEndEvent,
  AgentPipelineEvent,
} from "./types.js";
import { clearSessionTimer } from "./helpers.js";
import {
  getDiscordContextKey,
  isActiveMemorySessionKey,
  isIntentionHintSessionKey,
  isSubagentSessionKey,
  getActiveMemorySourceSessionKey,
  extractIdFromMetadata,
  extractSenderId,
  extractAgentIdFromSessionKey,
  parseActiveMemoryToolEntries,
} from "./parser.js";
import {
  retireSession,
  scheduleSessionCleanup,
  updateStatusMessage,
} from "./session.js";
import { AGENT_END_DELAY_MS } from "./constants.js";
import { ToolHistoryManager } from "./tool-history-manager.js";

const INTENTION_HINT_EVENT_STREAM = "plugin:intention-hint";
const INTENTION_HINT_EVENT_KIND = "intention-hint.pipeline";

function mapPipelineState(value: unknown): ToolEntry["status"] | undefined {
  if (value === "started") return "pending";
  if (value === "completed" || value === "skipped") return "completed";
  if (value === "failed") return "error";
  return undefined;
}

function parseIntentionHintPipelineEntry(
  event: AgentPipelineEvent,
): ToolEntry | undefined {
  if (event.stream !== INTENTION_HINT_EVENT_STREAM) return;
  const data = event.data;
  if (data?.kind !== INTENTION_HINT_EVENT_KIND) return;
  if (typeof data.phase !== "string" || !data.phase.trim()) return;

  const status = mapPipelineState(data.state);
  if (!status) return;

  const params = Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) =>
        !["kind", "phase", "state"].includes(key) && value !== undefined,
    ),
  );

  return {
    toolCallId: `intention-hint:${event.runId}:${data.phase}`,
    toolName: `intention-hint:${data.phase}`,
    params,
    status,
    error: status === "error" ? String(data.reason ?? "failed") : undefined,
  };
}

function buildPendingSubagentEntries(
  agentId: string | undefined,
  isActiveMemoryEnabled: (agentId: string) => boolean,
  isIntentionHintEnabled: (agentId: string) => boolean,
): ToolEntry[] {
  const entries: ToolEntry[] = [];

  if (agentId === undefined || isActiveMemoryEnabled(agentId)) {
    entries.push({
      toolCallId: "active-memory",
      toolName: "active-memory",
      params: {},
      status: "pending",
    });
  }

  if (agentId === undefined || isIntentionHintEnabled(agentId)) {
    entries.push({
      toolCallId: "intention-hint",
      toolName: "intention-hint",
      params: {},
      status: "pending",
    });
  }

  return entries;
}

export function createHookHandlers(deps: HookDeps) {
  const {
    store,
    orphans,
    getToken,
    config,
    isActiveMemoryEnabled,
    isIntentionHintEnabled,
  } = deps;

  // Initialize the ToolHistoryManager
  const toolHistoryManager = new ToolHistoryManager(config);

  function logHookEvent(
    hookName: string,
    _event: unknown,
    ctx: { sessionKey?: string },
  ) {
    logger.debug(`${hookName} ctx: ${JSON.stringify(ctx)}`, {
      sessionKey: ctx.sessionKey,
    });
  }

  function isDiscordContext(ctx: MessageContext): boolean {
    if (ctx.trigger && ctx.trigger !== "user") return false;
    return (
      ctx.channelId === "discord" ||
      ctx.messageProvider === "discord" ||
      /^\d{17,20}$/.test(String(ctx.channelId))
    );
  }

  async function updateSessionStatus(
    session: SessionEntry,
    isFinal: boolean,
  ): Promise<void> {
    await updateStatusMessage(
      session,
      getToken,
      isFinal,
      config.maxDisplayMs,
      config.maxStatusMessageLength,
    );
  }

  async function showPendingSubagentEntries(
    session: SessionEntry,
    ownerSessionKey: string | undefined,
  ): Promise<void> {
    const agentId = extractAgentIdFromSessionKey(ownerSessionKey);
    const pendingEntries = buildPendingSubagentEntries(
      agentId,
      isActiveMemoryEnabled,
      isIntentionHintEnabled,
    );
    if (pendingEntries.length === 0) return;

    toolHistoryManager.addEntries(session.toolHistory, pendingEntries);
    await updateSessionStatus(session, false);
  }

  function shouldSkipSession(
    ctx: { sessionKey?: string },
    hookName: string,
  ): boolean {
    if (
      isActiveMemorySessionKey(ctx.sessionKey) ||
      isIntentionHintSessionKey(ctx.sessionKey) ||
      isSubagentSessionKey(ctx.sessionKey)
    ) {
      logger.trace(
        `${hookName}: skip (active-memory/intention-hint/subagent) session.`,
        {
          sessionKey: ctx.sessionKey,
        },
      );
      return true;
    }
    return false;
  }

  async function resolveAndFinalize(
    ctx: AgentContext,
    delayMs: number,
    hookName: string,
    requireVisibleState = false,
  ) {
    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (!contextKey) return;
    const session = await store.resolveSession(contextKey, ctx.sessionKey);
    if (!session) return;
    if (requireVisibleState && !store.hasVisibleStatusState(session)) return;
    session.finalized = true;
    await updateSessionStatus(session, true);
    scheduleSessionCleanup(
      contextKey,
      session,
      ctx.sessionKey,
      delayMs,
      `${hookName}_delayed`,
      getToken,
    );
  }

  async function onMessageReceived(
    event: MessageReceivedEvent,
    ctx: MessageContext,
  ) {
    if (!isDiscordContext(ctx)) return;
    if (shouldSkipSession(ctx, "message_received")) return;
    logHookEvent("message_received", event, ctx);

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (!contextKey) return;

    let actualChannelId = extractIdFromMetadata(event.metadata?.to as string);
    if (!actualChannelId && ctx.conversationId) {
      actualChannelId = extractIdFromMetadata(ctx.conversationId as string);
    }
    if (!actualChannelId && /^\d{17,20}$/.test(String(ctx.channelId))) {
      actualChannelId = String(ctx.channelId);
    }
    if (!actualChannelId) return;

    store.contexts.set(contextKey, {
      actualChannelId,
      userMessageId: event.messageId,
      senderId: extractSenderId(event.metadata),
      accountId: ctx.accountId,
      sourceSessionKey: ctx.sessionKey,
    });

    const activeSession = store.sessions.get(contextKey);
    if (activeSession) {
      if (
        activeSession.finalized ||
        (ctx.sessionKey && activeSession.ownerSessionKey !== ctx.sessionKey)
      ) {
        const nextOwnerSessionKey =
          ctx.sessionKey ?? activeSession.ownerSessionKey;
        clearSessionTimer(activeSession);
        const replacement: SessionEntry = {
          contextKey,
          channelId: actualChannelId,
          userMessageId: event.messageId,
          senderId: extractSenderId(event.metadata),
          accountId: ctx.accountId,
          ownerSessionKey: nextOwnerSessionKey,
          generation: activeSession.generation + 1,
          finalized: false,
          toolHistory: [],
        };
        store.sessions.set(contextKey, replacement);
        retireSession(
          activeSession,
          "message_received_owner_switch",
          getToken,
        ).catch((err) => {
          logger.warn("failed to retire old session on owner switch.", {
            contextKey,
            error: String(err),
          });
        });

        await showPendingSubagentEntries(replacement, nextOwnerSessionKey);
        return;
      }

      activeSession.channelId = actualChannelId;
      activeSession.userMessageId = event.messageId;
      activeSession.senderId = extractSenderId(event.metadata);
      activeSession.accountId = ctx.accountId;
    }

    const session = store.getOrCreateSession(contextKey, ctx.sessionKey);
    if (session && session.toolHistory.length === 0) {
      await showPendingSubagentEntries(session, ctx.sessionKey);
    }
  }

  async function onBeforeToolCall(
    event: BeforeToolCallEvent,
    ctx: ToolContext,
  ) {
    if (shouldSkipSession(ctx, "before_tool_call")) return;
    logHookEvent("before_tool_call", event, ctx);
    orphans.pruneStale();

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    const session = contextKey
      ? await store.resolveSession(contextKey, ctx.sessionKey)
      : undefined;

    if (!session) {
      if (event.toolCallId && event.toolName) {
        orphans.add({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          params: event.params ?? {},
          createdAt: Date.now(),
        });
        logger.debug(
          `before_tool_call: orphaned tool call (no sessionKey). id=${event.toolCallId}`,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        );
      }
      return;
    }

    if (session.finalized) {
      logger.debug("before_tool_call: skip finalized session.", {
        sessionKey: ctx.sessionKey,
        toolCallId: event.toolCallId,
      });
      return;
    }

    if (!event.toolCallId) return;
    toolHistoryManager.addEntry(session.toolHistory, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      params: event.params,
      status: "pending",
    });

    await updateSessionStatus(session, false);
  }

  async function onAfterToolCall(event: AfterToolCallEvent, ctx: ToolContext) {
    if (shouldSkipSession(ctx, "after_tool_call")) return;
    logHookEvent("after_tool_call", event, ctx);
    orphans.pruneStale();

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    const session = contextKey
      ? await store.resolveSession(contextKey, ctx.sessionKey)
      : undefined;

    if (!session) return;

    if (session.finalized) {
      logger.debug("after_tool_call: skip finalized session.", {
        sessionKey: ctx.sessionKey,
        toolCallId: event.toolCallId,
      });
      return;
    }

    if (!event.toolCallId) return;

    let toolEntry = session.toolHistory.find(
      (t) => t.toolCallId === event.toolCallId,
    );
    let isOrphanReconcile = false;
    if (!toolEntry) {
      const orphan = orphans.get(event.toolCallId as string);
      logger.debug(
        `after_tool_call: lookup orphan id=${event.toolCallId} found=${orphan ? "yes" : "no"}`,
        { toolCallId: event.toolCallId },
      );
      if (orphan) {
        if (Date.now() - orphan.createdAt <= config.orphanTtlMs) {
          toolEntry = {
            toolCallId: orphan.toolCallId,
            toolName: orphan.toolName,
            params: orphan.params,
            status: "pending",
          };
          isOrphanReconcile = true;
          toolHistoryManager.addEntry(session.toolHistory, toolEntry);
          logger.debug(`after_tool_call: reconciled orphan tool entry.`, {
            toolCallId: event.toolCallId,
          });
        }
        orphans.remove(event.toolCallId as string);
      }
    }
    if (toolEntry) {
      if (event.error) {
        toolHistoryManager.updateEntry(session.toolHistory, event.toolCallId, {
          status: "error",
          error: event.error,
          durationMs: event.durationMs,
        });
      } else if (isOrphanReconcile) {
        toolHistoryManager.updateEntry(session.toolHistory, event.toolCallId, {
          status: "orphan-completed",
          error: undefined,
          durationMs: event.durationMs,
        });
      } else {
        toolHistoryManager.updateEntry(session.toolHistory, event.toolCallId, {
          status: "completed",
          error: undefined,
          durationMs: event.durationMs,
        });
      }
      await updateSessionStatus(session, false);
    }
  }

  async function onMessageSending(
    event: MessageSendingEvent,
    ctx: MessageContext,
  ) {
    if (!isDiscordContext(ctx)) return undefined;
    if (shouldSkipSession(ctx, "message_sending")) return undefined;
    logHookEvent("message_sending", event, ctx);

    let sessionKey = ctx.sessionKey;
    if (!sessionKey && ctx.conversationId) {
      const convId = extractIdFromMetadata(ctx.conversationId as string);
      if (convId) {
        for (const [_, session] of store.sessions) {
          if (session.channelId === convId) {
            sessionKey = session.ownerSessionKey;
            break;
          }
        }
      }
    }
    if (!sessionKey) return undefined;

    const contextKey = getDiscordContextKey(sessionKey);
    if (!contextKey) return undefined;
    const session = await store.resolveSession(contextKey, sessionKey);
    if (!session) return undefined;
    if (session.finalized) return undefined;
    session.finalized = true;
    await updateSessionStatus(session, true);
    return undefined;
  }

  async function onBeforeAgentReply(
    event: BeforeAgentReplyEvent,
    ctx: AgentContext,
  ) {
    if (shouldSkipSession(ctx, "before_agent_reply")) return { handled: false };
    logHookEvent("before_agent_reply", event, ctx);

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (!contextKey) return { handled: false };
    const session = await store.resolveSession(contextKey, ctx.sessionKey);
    if (!session) return { handled: false };
    if (!store.hasVisibleStatusState(session)) return { handled: false };
    if (session.finalized) return { handled: false };

    session.finalized = true;
    await updateSessionStatus(session, true);
    return { handled: false };
  }

  async function onAgentEnd(event: AgentEndEvent, ctx: AgentContext) {
    if (isSubagentSessionKey(ctx.sessionKey)) {
      logger.trace("agent_end: skip subagent session.", {
        sessionKey: ctx.sessionKey,
      });
      return;
    }
    logHookEvent("agent_end", event, ctx);

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (contextKey) {
      if (isActiveMemorySessionKey(ctx.sessionKey)) {
        const sourceSessionKey = getActiveMemorySourceSessionKey(
          ctx.sessionKey,
        );
        const session = sourceSessionKey
          ? store.getOrCreateSession(contextKey, sourceSessionKey)
          : undefined;
        if (session) {
          clearSessionTimer(session);
          const entries = parseActiveMemoryToolEntries(event);
          const preservedPlaceholder = session.toolHistory.find(
            (t) => t.toolCallId === "active-memory",
          );

          if (entries.length > 0) {
            const newEntries = toolHistoryManager.upsertEntries(
              session.toolHistory,
              entries,
            );
            toolHistoryManager.replaceSubagentGroup(
              session.toolHistory,
              "active-memory",
              toolHistoryManager
                .findSubagentChildEntries(session.toolHistory, "active-memory")
                .concat(newEntries),
            );
            toolHistoryManager.trim(session.toolHistory);
          } else if (event.error || event.success === false) {
            toolHistoryManager.replaceSubagentGroup(
              session.toolHistory,
              "active-memory",
              [
                {
                  toolCallId: "active-memory",
                  toolName: "active-memory",
                  params: preservedPlaceholder?.params ?? {},
                  status: "error",
                  durationMs: event.durationMs,
                  error: event.error,
                },
              ],
            );
          }
          await updateSessionStatus(session, true);
        }
        return;
      }

      if (isIntentionHintSessionKey(ctx.sessionKey)) {
        return;
      }

      await resolveAndFinalize(ctx, AGENT_END_DELAY_MS, "agent_end");
    }
  }

  async function onIntentionHintPipelineEvent(event: AgentPipelineEvent) {
    if (!event.sessionKey) return;
    const entry = parseIntentionHintPipelineEntry(event);
    if (!entry) return;

    const contextKey = getDiscordContextKey(event.sessionKey);
    const session = contextKey
      ? await store.resolveSession(contextKey, event.sessionKey)
      : undefined;
    if (!session) return;

    clearSessionTimer(session);
    const existingEntries = toolHistoryManager
      .findSubagentChildEntries(session.toolHistory, "intention-hint")
      .filter((tool) => tool.toolCallId !== entry.toolCallId);
    toolHistoryManager.replaceSubagentGroup(
      session.toolHistory,
      "intention-hint",
      [...existingEntries, entry].slice(-8),
    );
    toolHistoryManager.trim(session.toolHistory);
    await updateSessionStatus(session, false);
  }

  return Object.freeze({
    onMessageReceived,
    onBeforeToolCall,
    onAfterToolCall,
    onMessageSending,
    onBeforeAgentReply,
    onAgentEnd,
    onIntentionHintPipelineEvent,
  });
}
