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
  BeforeCompactionEvent,
  AfterCompactionEvent,
} from "./types.js";
import { clearMaxDisplayTimer, clearSessionTimer } from "./helpers.js";
import {
  getDiscordContextKey,
  isSkillHarnessSessionKey,
  isSubagentSessionKey,
  extractIdFromMetadata,
  extractSenderId,
} from "./parser.js";
import {
  retireSession,
  scheduleSessionCleanup,
  updateStatusMessage,
} from "./session.js";
import { AGENT_END_DELAY_MS } from "./constants.js";
import { ToolHistoryManager } from "./tool-history-manager.js";
import {
  canonicalToolNameForDedupe,
  isCodexOpenClawToolName,
  preferDisplayToolName,
  preferToolCallId,
  type ToolDedupeIdentity,
} from "./tool-name.js";
import {
  finishPendingSkillHarness,
  getSkillHarnessPipelineSessionKey,
  updateSkillHarnessEntry,
} from "./skill-harness-status.js";
import {
  finishPendingHindsightRecalls,
  parseHindsightRecallEvent,
} from "./hindsight-status.js";

function isTerminalToolStatus(status: ToolEntry["status"]): boolean {
  return (
    status === "completed" ||
    status === "error" ||
    status === "orphan-completed"
  );
}

function resolveToolDurationMs(
  entry: ToolEntry,
  eventDurationMs: number | undefined,
  observedAtMs: number,
): number | undefined {
  if (typeof eventDurationMs === "number") {
    return eventDurationMs;
  }
  if (typeof entry.durationMs === "number") {
    return entry.durationMs;
  }
  if (
    !isTerminalToolStatus(entry.status) &&
    typeof entry.startedAtMs === "number"
  ) {
    return Math.max(0, observedAtMs - entry.startedAtMs);
  }
  return undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }

  return value;
}

function stableParamsKey(params: unknown): string {
  return JSON.stringify(stableValue(params ?? {}));
}

function isDuplicateCodexOpenClawToolEntry(
  existing: ToolDedupeIdentity,
  incoming: ToolDedupeIdentity,
): boolean {
  if (
    canonicalToolNameForDedupe(existing.toolName) !==
    canonicalToolNameForDedupe(incoming.toolName)
  ) {
    return false;
  }
  if (
    !isCodexOpenClawToolName(existing.toolName) &&
    !isCodexOpenClawToolName(incoming.toolName)
  ) {
    return false;
  }
  return stableParamsKey(existing.params) === stableParamsKey(incoming.params);
}

function findDedupedToolEntry(
  history: ToolEntry[],
  incoming: ToolDedupeIdentity,
): ToolEntry | undefined {
  return (
    history.find((entry) => entry.toolCallId === incoming.toolCallId) ??
    history.find((entry) => isDuplicateCodexOpenClawToolEntry(entry, incoming))
  );
}

function upsertToolEntry(
  toolHistoryManager: ToolHistoryManager,
  history: ToolEntry[],
  incoming: ToolEntry,
): ToolEntry {
  const existing = findDedupedToolEntry(history, incoming);
  if (!existing) {
    toolHistoryManager.addEntry(history, incoming);
    return incoming;
  }

  const updates: Partial<ToolEntry> = {
    toolCallId: preferToolCallId(existing, incoming),
    toolName: preferDisplayToolName(existing.toolName, incoming.toolName),
    params: incoming.params,
    status: isTerminalToolStatus(existing.status)
      ? existing.status
      : incoming.status,
  };
  toolHistoryManager.updateEntry(history, existing.toolCallId, updates);
  return { ...existing, ...updates };
}

export function createHookHandlers(deps: HookDeps) {
  const { store, orphans, getToken, config } = deps;

  // Initialize the ToolHistoryManager
  const toolHistoryManager = new ToolHistoryManager(config);

  function getCompactionToolCallId(session: SessionEntry): string {
    return `compaction:${session.compactionEpoch ?? 0}`;
  }

  function finishCompactionEntry(
    session: SessionEntry,
    status: "completed" | "error",
  ): void {
    const toolCallId = getCompactionToolCallId(session);
    const entry = session.toolHistory.find(
      (candidate) => candidate.toolCallId === toolCallId,
    );
    const durationMs =
      typeof entry?.startedAtMs === "number"
        ? Math.max(0, Date.now() - entry.startedAtMs)
        : undefined;
    toolHistoryManager.updateEntry(session.toolHistory, toolCallId, {
      status,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }

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
      config.maxDisplaySeconds * 1000,
      config.maxStatusMessageLength,
      config.replyMode,
    );
  }

  async function replaceActivityGeneration(
    activeSession: SessionEntry,
    nextOwnerSessionKey: string | undefined,
    nextRunId: string | undefined,
    retirementReason: string,
  ): Promise<SessionEntry> {
    const context = store.contexts.get(activeSession.contextKey);
    const ownerSessionKey =
      nextOwnerSessionKey ??
      context?.sourceSessionKey ??
      activeSession.ownerSessionKey;
    const replacement: SessionEntry = {
      contextKey: activeSession.contextKey,
      channelId: context?.actualChannelId ?? activeSession.channelId,
      userMessageId: context?.userMessageId ?? activeSession.userMessageId,
      senderId: context?.senderId ?? activeSession.senderId,
      accountId: context?.accountId ?? activeSession.accountId,
      ownerSessionKey,
      generation: activeSession.generation + 1,
      runId: nextRunId,
      supersededRunIds: new Set([
        ...(activeSession.supersededRunIds ?? []),
        ...(activeSession.runId ? [activeSession.runId] : []),
      ]),
      finalized: false,
      toolHistory: [],
    };

    clearSessionTimer(activeSession);
    store.sessions.set(activeSession.contextKey, replacement);
    retireSession(activeSession, retirementReason, getToken).catch((err) => {
      logger.warn("failed to retire old session on owner switch.", {
        contextKey: activeSession.contextKey,
        error: String(err),
      });
    });

    return replacement;
  }

  function shouldSkipSession(
    ctx: { sessionKey?: string },
    hookName: string,
  ): boolean {
    // Retain isolation for legacy internal sessions without rendering their activity.
    if (
      ctx.sessionKey?.includes(":active-memory:") ||
      isSkillHarnessSessionKey(ctx.sessionKey) ||
      isSubagentSessionKey(ctx.sessionKey)
    ) {
      logger.trace(`${hookName}: skip internal session.`, {
        sessionKey: ctx.sessionKey,
      });
      return true;
    }
    return false;
  }

  function isSessionRunCurrent(
    session: SessionEntry,
    runId: string | undefined,
  ) {
    if (!runId) return true;
    if (session.supersededRunIds?.has(runId)) {
      logger.debug("skip hook for superseded run.", {
        contextKey: session.contextKey,
        receivedRunId: runId,
      });
      return false;
    }
    if (session.runId && session.runId !== runId) {
      logger.debug("skip hook for stale run.", {
        contextKey: session.contextKey,
        expectedRunId: session.runId,
        receivedRunId: runId,
      });
      return false;
    }
    return true;
  }

  function bindSessionRun(session: SessionEntry, runId: string | undefined) {
    if (!isSessionRunCurrent(session, runId)) return false;
    if (runId) session.runId = runId;
    return true;
  }

  function bindToolEventRun(
    session: SessionEntry,
    eventRunId: string | undefined,
    contextRunId: string | undefined,
  ) {
    if (eventRunId && contextRunId && eventRunId !== contextRunId) {
      logger.warn("skip tool hook with inconsistent run ids.", {
        contextKey: session.contextKey,
        eventRunId,
        contextRunId,
      });
      return false;
    }
    const runId = eventRunId ?? contextRunId;
    return bindSessionRun(session, runId);
  }

  async function resolveAndFinalize(
    ctx: AgentContext,
    delayMs: number,
    hookName: string,
    resolvedSession?: SessionEntry,
  ) {
    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (!contextKey) return;
    const session =
      resolvedSession ??
      (await store.resolveSession(contextKey, ctx.sessionKey));
    if (!session) return;
    if (!store.isCurrentSession(session)) return;
    if (!bindSessionRun(session, ctx.runId)) return;
    const compactionEpoch = session.compactionEpoch ?? 0;
    session.finalized = true;
    await updateSessionStatus(session, true);
    if ((session.compactionEpoch ?? 0) !== compactionEpoch) {
      session.finalized = false;
      return;
    }
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
      runId: ctx.runId,
    });

    const activeSession = store.sessions.get(contextKey);
    if (activeSession) {
      if (
        activeSession.finalized ||
        (ctx.runId !== undefined &&
          activeSession.runId !== undefined &&
          activeSession.runId !== ctx.runId) ||
        (ctx.sessionKey && activeSession.ownerSessionKey !== ctx.sessionKey)
      ) {
        const nextOwnerSessionKey =
          ctx.sessionKey ?? activeSession.ownerSessionKey;
        await replaceActivityGeneration(
          activeSession,
          nextOwnerSessionKey,
          ctx.runId,
          "message_received_owner_switch",
        );
        return;
      }

      activeSession.channelId = actualChannelId;
      activeSession.userMessageId = event.messageId;
      activeSession.senderId = extractSenderId(event.metadata);
      activeSession.accountId = ctx.accountId;
      if (ctx.runId) activeSession.runId = ctx.runId;
    }

    store.getOrCreateSession(contextKey, ctx.sessionKey);
  }

  async function onBeforeToolCall(
    event: BeforeToolCallEvent,
    ctx: ToolContext,
  ) {
    if (shouldSkipSession(ctx, "before_tool_call")) return;
    const observedAtMs = Date.now();
    logHookEvent("before_tool_call", event, ctx);
    orphans.pruneStale();

    const sourceSessionKey = ctx.sessionKey;
    const contextKey = getDiscordContextKey(sourceSessionKey);
    const session = contextKey
      ? await store.resolveSession(contextKey, sourceSessionKey)
      : undefined;
    const { toolCallId, toolName } = event;

    if (!session) {
      if (toolCallId && toolName) {
        orphans.add({
          toolCallId,
          toolName,
          params: event.params ?? {},
          createdAt: observedAtMs,
        });
        logger.debug(
          `before_tool_call: orphaned tool call (no sessionKey). id=${event.toolCallId}`,
          {
            toolCallId,
            toolName,
          },
        );
      }
      return;
    }

    if (!bindToolEventRun(session, event.runId, ctx.runId)) return;

    if (session.finalized) {
      logger.debug("before_tool_call: skip finalized session.", {
        sessionKey: ctx.sessionKey,
        toolCallId: event.toolCallId,
      });
      return;
    }

    if (!toolCallId) return;
    upsertToolEntry(toolHistoryManager, session.toolHistory, {
      toolCallId,
      toolName,
      params: event.params,
      status: "pending",
      startedAtMs: observedAtMs,
    });

    await updateSessionStatus(session, false);
  }

  async function onAfterToolCall(event: AfterToolCallEvent, ctx: ToolContext) {
    if (shouldSkipSession(ctx, "after_tool_call")) return;
    const observedAtMs = Date.now();
    logHookEvent("after_tool_call", event, ctx);
    orphans.pruneStale();

    const sourceSessionKey = ctx.sessionKey;
    const contextKey = getDiscordContextKey(sourceSessionKey);
    const session = contextKey
      ? await store.resolveSession(contextKey, sourceSessionKey)
      : undefined;

    if (!session) return;

    if (!bindToolEventRun(session, event.runId, ctx.runId)) return;

    if (session.finalized) {
      logger.debug("after_tool_call: skip finalized session.", {
        sessionKey: ctx.sessionKey,
        toolCallId: event.toolCallId,
      });
      return;
    }

    if (!event.toolCallId) return;
    const toolCallId = event.toolCallId;

    let toolEntry = findDedupedToolEntry(session.toolHistory, {
      toolCallId,
      toolName: event.toolName,
      params: event.params,
    });
    let isOrphanReconcile = false;
    if (!toolEntry) {
      const orphan = orphans.get(toolCallId);
      logger.debug(
        `after_tool_call: lookup orphan id=${event.toolCallId} found=${orphan ? "yes" : "no"}`,
        { toolCallId },
      );
      if (orphan) {
        if (observedAtMs - orphan.createdAt <= config.orphanTtlSeconds * 1000) {
          toolEntry = {
            toolCallId: orphan.toolCallId,
            toolName: orphan.toolName,
            params: orphan.params,
            status: "pending",
            startedAtMs: orphan.createdAt,
          };
          isOrphanReconcile = true;
          toolHistoryManager.addEntry(session.toolHistory, toolEntry);
          logger.debug(`after_tool_call: reconciled orphan tool entry.`, {
            toolCallId,
          });
        }
        orphans.remove(toolCallId);
      }
    }
    if (toolEntry) {
      const updateToolCallId = toolEntry.toolCallId;
      const nextToolCallId = preferToolCallId(toolEntry, {
        toolCallId,
        toolName: event.toolName,
        params: event.params,
      });
      const nextToolName = preferDisplayToolName(
        toolEntry.toolName,
        event.toolName,
      );
      const nextDurationMs = resolveToolDurationMs(
        toolEntry,
        event.durationMs,
        observedAtMs,
      );
      if (event.error) {
        toolHistoryManager.updateEntry(session.toolHistory, updateToolCallId, {
          toolCallId: nextToolCallId,
          toolName: nextToolName,
          params: event.params,
          status: "error",
          error: event.error,
          durationMs: nextDurationMs,
        });
      } else if (isOrphanReconcile) {
        toolHistoryManager.updateEntry(session.toolHistory, updateToolCallId, {
          toolCallId: nextToolCallId,
          toolName: nextToolName,
          params: event.params,
          status: "orphan-completed",
          error: undefined,
          durationMs: nextDurationMs,
        });
      } else {
        toolHistoryManager.updateEntry(session.toolHistory, updateToolCallId, {
          toolCallId: nextToolCallId,
          toolName: nextToolName,
          params: event.params,
          status: "completed",
          error: undefined,
          durationMs: nextDurationMs,
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
    if (!bindSessionRun(session, ctx.runId)) return undefined;
    if (session.finalized) return undefined;
    finishPendingHindsightRecalls(session.toolHistory);
    finishPendingSkillHarness(session.toolHistory);
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

    if (!ctx.runId) return { handled: false };

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (!contextKey) return { handled: false };

    try {
      const session = await store.resolveSession(contextKey, ctx.sessionKey);
      if (!session || session.supersededRunIds?.has(ctx.runId)) {
        return { handled: false };
      }
      if (session.runId === ctx.runId) return { handled: false };
      if (!session.runId && !session.finalized) {
        session.runId = ctx.runId;
        return { handled: false };
      }
      if (!session.finalized) return { handled: false };

      await replaceActivityGeneration(
        session,
        ctx.sessionKey,
        ctx.runId,
        "before_agent_reply_run_replacement",
      );
    } catch (err) {
      logger.warn(
        "before_agent_reply: failed to initialize activity generation.",
        {
          contextKey,
          sessionKey: ctx.sessionKey,
          error: String(err),
        },
      );
    }

    return { handled: false };
  }

  async function onAgentEnd(event: AgentEndEvent, ctx: AgentContext) {
    if (shouldSkipSession(ctx, "agent_end")) return;
    logHookEvent("agent_end", event, ctx);

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    const compactionWasActiveAtDispatch = contextKey
      ? store.sessions.get(contextKey)?.compactionActive === true
      : false;
    if (contextKey) {
      const session = await store.resolveSession(contextKey, ctx.sessionKey);
      if (!session || !bindSessionRun(session, ctx.runId)) return;
      finishPendingHindsightRecalls(session.toolHistory);
      finishPendingSkillHarness(session.toolHistory);
      if (compactionWasActiveAtDispatch) {
        session.compactionActive = false;
        finishCompactionEntry(session, "error");
      }

      if (event.success === false || event.error) {
        const failureEntry: ToolEntry = {
          toolCallId: "agent",
          toolName: "agent",
          params: {},
          status: "error",
          durationMs: event.durationMs,
          error: event.error,
        };
        if (
          !toolHistoryManager.updateEntry(
            session.toolHistory,
            failureEntry.toolCallId,
            failureEntry,
          )
        ) {
          toolHistoryManager.addEntry(session.toolHistory, failureEntry);
        }
      }

      await resolveAndFinalize(ctx, AGENT_END_DELAY_MS, "agent_end", session);
    }
  }

  async function onBeforeCompaction(
    event: BeforeCompactionEvent,
    ctx: AgentContext,
  ) {
    if (shouldSkipSession(ctx, "before_compaction")) return;
    logHookEvent("before_compaction", event, ctx);

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (!contextKey) return;
    const session = await store.resolveSession(contextKey, ctx.sessionKey);
    if (!session || !bindSessionRun(session, ctx.runId)) return;
    if (!store.hasVisibleStatusState(session)) return;

    session.compactionActive = true;
    session.compactionEpoch = (session.compactionEpoch ?? 0) + 1;
    session.finalized = false;
    clearSessionTimer(session);
    clearMaxDisplayTimer(session);

    const failureIndex = session.toolHistory.findIndex(
      (entry) => entry.toolCallId === "agent" && entry.toolName === "agent",
    );
    if (failureIndex >= 0) {
      session.toolHistory.splice(failureIndex, 1);
    }

    toolHistoryManager.addEntry(session.toolHistory, {
      toolCallId: getCompactionToolCallId(session),
      toolName: "compaction",
      params: {},
      status: "pending",
      startedAtMs: Date.now(),
    });

    await updateSessionStatus(session, false);
    clearMaxDisplayTimer(session);
  }

  async function onAfterCompaction(
    event: AfterCompactionEvent,
    ctx: AgentContext,
  ) {
    if (shouldSkipSession(ctx, "after_compaction")) return;
    logHookEvent("after_compaction", event, ctx);

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    if (!contextKey) return;
    const session = await store.resolveSession(contextKey, ctx.sessionKey);
    if (!session || !bindSessionRun(session, ctx.runId)) return;
    if (!session.compactionActive) return;

    finishCompactionEntry(session, "completed");
    session.compactionActive = false;
    session.finalized = false;
    await updateSessionStatus(session, false);
  }

  async function onHindsightPipelineEvent(event: AgentPipelineEvent) {
    const parsed = parseHindsightRecallEvent(event);
    if (!parsed || shouldSkipSession(parsed, "hindsight_pipeline")) return;
    const { sessionKey, entry } = parsed;
    const contextKey = getDiscordContextKey(sessionKey);
    if (!contextKey) return;

    try {
      const session = await store.resolveSession(contextKey, sessionKey);
      if (
        !session ||
        !store.isCurrentSession(session) ||
        session.ownerSessionKey !== sessionKey ||
        session.finalized ||
        (session.runId !== undefined && session.runId !== event.runId) ||
        !bindSessionRun(session, event.runId)
      )
        return;
      const existing = session.toolHistory.find(
        (candidate) => candidate.toolCallId === entry.toolCallId,
      );
      // Terminal events are authoritative, even when observed before a start.
      if (
        existing &&
        (isTerminalToolStatus(existing.status) || entry.status === "pending")
      )
        return;
      entry.startedAtMs = existing?.startedAtMs ?? Date.now();
      if (existing) {
        toolHistoryManager.updateEntry(
          session.toolHistory,
          entry.toolCallId,
          entry,
        );
      } else {
        toolHistoryManager.addEntry(session.toolHistory, entry);
      }
      clearSessionTimer(session);
      await updateSessionStatus(session, false);
    } catch (err) {
      logger.warn("hindsight_pipeline: failed to update activity status.", {
        sessionKey,
        error: String(err),
      });
    }
  }

  async function onSkillHarnessPipelineEvent(event: AgentPipelineEvent) {
    const observedAtMs = Date.now();
    const sessionKey = getSkillHarnessPipelineSessionKey(event);
    if (
      !sessionKey ||
      shouldSkipSession({ sessionKey }, "skill_harness_pipeline")
    )
      return;

    const contextKey = getDiscordContextKey(sessionKey);
    if (!contextKey) return;

    try {
      const session = await store.resolveSession(contextKey, sessionKey);
      if (!session || !store.isCurrentSession(session) || session.finalized)
        return;

      const provenanceRunId =
        event.runId === sessionKey ? undefined : event.runId;
      if (!isSessionRunCurrent(session, provenanceRunId)) return;

      clearSessionTimer(session);
      const existing = session.toolHistory.find(
        (tool) =>
          tool.toolCallId === "skill-harness" ||
          tool.toolName === "skill-harness",
      );
      const updated = updateSkillHarnessEntry(existing, event, observedAtMs);
      if (!updated) return;

      toolHistoryManager.replaceSubagentGroup(
        session.toolHistory,
        "skill-harness",
        [updated],
      );
      toolHistoryManager.trim(session.toolHistory);
      await updateSessionStatus(session, false);
    } catch (err) {
      logger.warn("skill_harness_pipeline: failed to update activity status.", {
        sessionKey,
        error: String(err),
      });
    }
  }

  return Object.freeze({
    onHindsightPipelineEvent,
    onMessageReceived,
    onBeforeToolCall,
    onAfterToolCall,
    onMessageSending,
    onBeforeAgentReply,
    onAgentEnd,
    onBeforeCompaction,
    onAfterCompaction,
    onSkillHarnessPipelineEvent,
  });
}
