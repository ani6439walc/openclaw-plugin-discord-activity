import { createSubsystemLogger } from "../api.js";
import type {
  SessionEntry,
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
} from "./types.js";
import {
  getDiscordContextKey,
  isActiveMemorySessionKey,
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

const logger = createSubsystemLogger("plugins");

export function createHookHandlers(deps: HookDeps) {
  const { store, orphans, getToken, config, isActiveMemoryEnabled } = deps;

  function logHookEvent(
    hookName: string,
    _event: unknown,
    ctx: { sessionKey?: string },
  ) {
    logger.debug(
      `discord-tool-status: ${hookName} ctx: ${JSON.stringify(ctx)}`,
      {
        subsystem: "plugins",
        sessionKey: ctx.sessionKey,
      },
    );
  }

  function isDiscordContext(ctx: MessageContext): boolean {
    return (
      ctx.channelId === "discord" ||
      ctx.messageProvider === "discord" ||
      /^\d{17,20}$/.test(String(ctx.channelId))
    );
  }

  function shouldSkipSession(
    ctx: { sessionKey?: string },
    hookName: string,
  ): boolean {
    if (
      isActiveMemorySessionKey(ctx.sessionKey) ||
      isSubagentSessionKey(ctx.sessionKey)
    ) {
      logger.trace(
        `discord-tool-status: ${hookName}: skip (active-memory/subagent) session.`,
        {
          subsystem: "plugins",
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
    await updateStatusMessage(session, getToken, true);
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
      if (ctx.sessionKey && activeSession.ownerSessionKey !== ctx.sessionKey) {
        if (activeSession.clearTimer) {
          clearTimeout(activeSession.clearTimer);
          activeSession.clearTimer = undefined;
        }
        const replacement: SessionEntry = {
          contextKey,
          channelId: actualChannelId,
          userMessageId: event.messageId,
          senderId: extractSenderId(event.metadata),
          accountId: ctx.accountId,
          ownerSessionKey: ctx.sessionKey,
          generation: activeSession.generation + 1,
          toolHistory: [],
        };
        store.sessions.set(contextKey, replacement);
        retireSession(
          activeSession,
          "message_received_owner_switch",
          getToken,
        ).catch((err) => {
          logger.warn(
            "discord-tool-status: failed to retire old session on owner switch",
            {
              subsystem: "plugins",
              contextKey,
              error: String(err),
            },
          );
        });

        const replacementAgentId = extractAgentIdFromSessionKey(ctx.sessionKey);
        if (
          replacementAgentId === undefined ||
          isActiveMemoryEnabled(replacementAgentId)
        ) {
          replacement.toolHistory.push({
            toolCallId: "active-memory",
            toolName: "active-memory",
            params: {},
            status: "pending",
          });
          await updateStatusMessage(replacement, getToken);
        }
        return;
      }

      activeSession.channelId = actualChannelId;
      activeSession.userMessageId = event.messageId;
      activeSession.senderId = extractSenderId(event.metadata);
      activeSession.accountId = ctx.accountId;
    }

    const session = store.getOrCreateSession(contextKey, ctx.sessionKey);
    if (session && session.toolHistory.length === 0) {
      const agentId = extractAgentIdFromSessionKey(ctx.sessionKey);
      if (agentId === undefined || isActiveMemoryEnabled(agentId)) {
        session.toolHistory.push({
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "pending",
        });
        await updateStatusMessage(session, getToken);
      }
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
          `discord-tool-status: before_tool_call: orphaned tool call (no sessionKey). id=${event.toolCallId}`,
          {
            subsystem: "plugins",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        );
      }
      return;
    }

    if (!event.toolCallId) return;
    session.toolHistory.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      params: event.params,
      status: "pending",
    });

    if (session.toolHistory.length > 10) session.toolHistory.shift();
    await updateStatusMessage(session, getToken);
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

    let toolEntry = session.toolHistory.find(
      (t) => t.toolCallId === event.toolCallId,
    );
    let isOrphanReconcile = false;
    if (!toolEntry) {
      const orphan = orphans.get(event.toolCallId as string);
      logger.debug(
        `discord-tool-status: after_tool_call: lookup orphan id=${event.toolCallId} found=${orphan ? "yes" : "no"}`,
        { subsystem: "plugins", toolCallId: event.toolCallId },
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
          session.toolHistory.push(toolEntry);
          if (session.toolHistory.length > 10) session.toolHistory.shift();
          logger.debug(
            `discord-tool-status: after_tool_call: reconciled orphan tool entry.`,
            { subsystem: "plugins", toolCallId: event.toolCallId },
          );
        }
        orphans.remove(event.toolCallId as string);
      }
    }
    if (toolEntry) {
      if (event.error) {
        toolEntry.status = "error";
      } else if (isOrphanReconcile) {
        toolEntry.status = "orphan-completed";
      } else {
        toolEntry.status = "completed";
      }
      toolEntry.durationMs = event.durationMs;
      await updateStatusMessage(session, getToken);
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
    await updateStatusMessage(session, getToken, true);
    scheduleSessionCleanup(
      contextKey,
      session,
      sessionKey,
      1000,
      "message_sending",
      getToken,
    );
    return undefined;
  }

  async function onBeforeAgentReply(
    event: BeforeAgentReplyEvent,
    ctx: AgentContext,
  ) {
    if (shouldSkipSession(ctx, "before_agent_reply")) return { handled: false };
    logHookEvent("before_agent_reply", event, ctx);

    await resolveAndFinalize(ctx, 1000, "before_agent_reply", true);
    return { handled: false };
  }

  async function onAgentEnd(event: AgentEndEvent, ctx: AgentContext) {
    if (isSubagentSessionKey(ctx.sessionKey)) {
      logger.trace("discord-tool-status: agent_end: skip subagent session.", {
        subsystem: "plugins",
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
          if (session.clearTimer) {
            clearTimeout(session.clearTimer);
            session.clearTimer = undefined;
          }
          const entries = parseActiveMemoryToolEntries(event);
          session.toolHistory = session.toolHistory.filter(
            (t) => t.toolCallId !== "active-memory",
          );
          if (entries.length > 0) {
            for (const entry of entries) {
              const existing = session.toolHistory.find(
                (t) => t.toolCallId === entry.toolCallId,
              );
              if (existing) {
                existing.status = entry.status;
                existing.params = entry.params;
                existing.toolName = entry.toolName;
              } else {
                session.toolHistory.push(entry);
              }
            }
            while (session.toolHistory.length > 10) {
              session.toolHistory.shift();
            }
          }
          await updateStatusMessage(session, getToken, true);
        }
        return;
      }

      await resolveAndFinalize(ctx, 1500, "agent_end");
    }
  }

  return Object.freeze({
    onMessageReceived,
    onBeforeToolCall,
    onAfterToolCall,
    onMessageSending,
    onBeforeAgentReply,
    onAgentEnd,
  });
}
