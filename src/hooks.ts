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
  isSkillHarnessReviewSessionKey,
  isSubagentSessionKey,
  extractIdFromMetadata,
  extractSenderId,
} from "./parser.js";
import {
  clearStatusMessage,
  retireSession,
  scheduleSessionCleanup,
  updateStatusMessage,
} from "./session.js";
import {
  DEFAULT_AGENT_END_DELAY_MS,
  DEFAULT_OVERFLOW_RECOVERY_GRACE_MS,
} from "./constants.js";
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
  finishPendingHindsightMemoryRecalls,
  parseHindsightMemoryRecallEvent,
} from "./hindsight-memory-status.js";
import {
  mergeStatusDisplayStates,
  renderStatusContentWithState,
} from "./render.js";

const CONTEXT_OVERFLOW_SIGNAL_RE =
  /\b(?:context|window|prompt|token|tokens|input|request|model)\b/i;
const CONTEXT_OVERFLOW_ACTION_RE =
  /\b(?:too\s+(?:large|long|many)|exceed(?:s|ed|ing)?|overflow|limit|maximum|max)\b/i;
const CONTEXT_OVERFLOW_EXPLICIT_RE =
  /\b(?:context[_ -]?overflow|context[_ -]?length[_ -]?exceeded|context[_ -]?window[_ -]?exceeded|prompt is too long|prompt too large|request_too_large|maximum context length|input is too long)\b/i;
const CONTEXT_OVERFLOW_EXCLUSION_RE =
  /\b(?:rate[_ -]?limit|tokens per min|tpm|rpm|quota|billing|compaction failed|auto-compaction failed|compaction timed out|reasoning is (?:mandatory|required)|requires reasoning)\b/i;

function isContextOverflowAttemptError(error: string | undefined): boolean {
  if (typeof error !== "string") return false;
  const normalized = error.trim();
  if (!normalized || CONTEXT_OVERFLOW_EXCLUSION_RE.test(normalized)) {
    return false;
  }
  if (CONTEXT_OVERFLOW_EXPLICIT_RE.test(normalized)) {
    return true;
  }
  return (
    CONTEXT_OVERFLOW_SIGNAL_RE.test(normalized) &&
    CONTEXT_OVERFLOW_ACTION_RE.test(normalized)
  );
}

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

function extractInboundSteerText(event: MessageReceivedEvent): string {
  const text = (
    (event.metadata?.body as string) ??
    (event.metadata?.content as string) ??
    event.content ??
    ""
  ).trim();
  if (text) return text;

  const mediaList =
    ((event as Record<string, unknown>).media as unknown[]) ??
    (event.metadata?.media as unknown[]) ??
    (event.metadata?.attachments as unknown[]);
  if (Array.isArray(mediaList) && mediaList.length > 0) {
    const first = mediaList[0] as Record<string, unknown> | undefined;
    const kind = typeof first?.kind === "string" ? first.kind : "image";
    return `[${kind}]`;
  }
  return "";
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
  function renderedContent(
    session: SessionEntry,
    history: readonly ToolEntry[],
  ): string {
    return renderStatusContentWithState(
      history,
      true,
      config.maxStatusMessageLength,
      mergeStatusDisplayStates(
        session.confirmedDisplayState,
        session.monotonicSafetyFloor,
      ),
    ).content;
  }

  function renderedFailureChanged(
    session: SessionEntry,
    event: AgentEndEvent,
  ): boolean {
    if (event.success !== false && !event.error) return false;
    const current = session.toolHistory.find(
      (entry) => entry.toolCallId === "agent" && entry.toolName === "agent",
    );
    const candidate: ToolEntry = {
      ...(current ?? {
        toolCallId: "agent",
        toolName: "agent",
        params: {},
      }),
      status: "error",
      durationMs: event.durationMs,
      error: event.error,
    };
    const candidateHistory = session.toolHistory.filter(
      (entry) => entry.toolCallId !== "agent" || entry.toolName !== "agent",
    );
    candidateHistory.push(candidate);
    toolHistoryManager.trim(candidateHistory);
    return (
      session.contentDeliveryUncertain === true ||
      session.lastRenderedContent !== renderedContent(session, candidateHistory)
    );
  }

  function confirmedFinalRendered(session: SessionEntry): boolean {
    return (
      session.contentDeliveryUncertain !== true &&
      session.lastRenderedContent !== undefined &&
      session.lastRenderedContent ===
        renderedContent(session, session.toolHistory)
    );
  }

  function recordMainAgentFailure(
    session: SessionEntry,
    event: AgentEndEvent,
  ): void {
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

  function clearOverflowRecoveryState(session: SessionEntry): void {
    session.overflowRecoveryPending = false;
    session.overflowRecoveryFailure = undefined;
  }

  function consumeDeferredOverflowFailure(session: SessionEntry): boolean {
    const deferredFailure = session.overflowRecoveryFailure;
    session.overflowRecoveryFailure = undefined;
    if (!deferredFailure) {
      return false;
    }
    recordMainAgentFailure(session, deferredFailure);
    return true;
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

  function scheduleOverflowRecoveryGrace(
    contextKey: string,
    session: SessionEntry,
    requestSessionKey: string | undefined,
  ): void {
    if (requestSessionKey && session.ownerSessionKey !== requestSessionKey) {
      return;
    }

    const expectedGeneration = session.generation;
    const expectedOwner = session.ownerSessionKey;
    clearSessionTimer(session);
    clearMaxDisplayTimer(session);

    logger.info("[agent_end_overflow_grace] scheduled status message cleanup", {
      contextKey,
      delayMs: DEFAULT_OVERFLOW_RECOVERY_GRACE_MS,
      generation: expectedGeneration,
      ownerSessionKey: expectedOwner,
    });

    session.clearTimer = setTimeout(() => {
      const expectedCompactionEpoch = session.compactionEpoch ?? 0;
      const isUnrecoveredGraceTarget = () => {
        const current = store.sessions.get(contextKey);
        return (
          current === session &&
          current.generation === expectedGeneration &&
          current.ownerSessionKey === expectedOwner &&
          !session.compactionActive &&
          (session.compactionEpoch ?? 0) === expectedCompactionEpoch
        );
      };

      if (!isUnrecoveredGraceTarget() || !session.overflowRecoveryPending) {
        return;
      }

      void (async () => {
        if (session.pendingOp) {
          try {
            await session.pendingOp;
          } catch (err) {
            logger.warn(
              "agent_end_overflow_grace: pending status update failed.",
              {
                contextKey,
                error: String(err),
              },
            );
          }
          if (!isUnrecoveredGraceTarget() || !session.overflowRecoveryPending) {
            return;
          }
        }

        clearMaxDisplayTimer(session);
        const hadDeferredFailure = consumeDeferredOverflowFailure(session);
        clearOverflowRecoveryState(session);
        session.finalized = true;

        logger.info(
          "[agent_end_overflow_grace] executing scheduled status message cleanup",
          {
            contextKey,
            generation: expectedGeneration,
            statusMessageId: session.statusMessageId,
            hadDeferredFailure,
          },
        );

        try {
          if (session.statusMessageId && hadDeferredFailure) {
            await updateSessionStatus(session, true);
          }
        } catch (err) {
          logger.warn(
            "failed to render failure status on agent_end_overflow_grace.",
            {
              contextKey,
              error: String(err),
            },
          );
        }

        if (
          !isUnrecoveredGraceTarget() ||
          session.overflowRecoveryPending ||
          !session.finalized
        ) {
          return;
        }

        try {
          await clearStatusMessage(
            session,
            "agent_end_overflow_grace",
            getToken,
          );
        } catch (err) {
          logger.warn(
            "failed to clear status message on agent_end_overflow_grace.",
            {
              contextKey,
              error: String(err),
            },
          );
        } finally {
          if (isUnrecoveredGraceTarget() && !session.overflowRecoveryPending) {
            store.clearSessionState(
              contextKey,
              session,
              expectedGeneration,
              expectedOwner,
            );
          }
        }
      })();
    }, DEFAULT_OVERFLOW_RECOVERY_GRACE_MS);
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
      activeRunIds: nextRunId ? new Set([nextRunId]) : new Set(),
      supersededRunIds: new Set([
        ...(activeSession.supersededRunIds ?? []),
        ...(activeSession.activeRunIds ?? []),
        ...(activeSession.runId ? [activeSession.runId] : []),
      ]),
      finalized: false,
      overflowRecoveryPending: false,
      overflowRecoveryFailure: undefined,
      steeredRunIds: new Set(),
      toolHistory: [],
    };

    clearSessionTimer(activeSession);
    store.sessions.set(activeSession.contextKey, replacement);
    logger.info(
      `replacing activity generation for ${activeSession.contextKey}`,
      {
        oldGeneration: activeSession.generation,
        newGeneration: replacement.generation,
        retirementReason,
        nextRunId,
        ownerSessionKey,
      },
    );
    retireSession(activeSession, retirementReason, getToken).catch((err) => {
      logger.warn("failed to retire old session on owner switch.", {
        contextKey: activeSession.contextKey,
        error: String(err),
      });
    });

    return replacement;
  }

  /**
   * Inbound DM messages are addressed to the user id, while the status card lives in the DM
   * channel resolved when it was sent. Once a card exists, keep the channel it was created in so
   * edits and deletes still reach it.
   */
  function adoptInboundChannel(session: SessionEntry, actualChannelId: string) {
    if (session.statusMessageId !== undefined) return;
    session.channelId = actualChannelId;
  }

  function shouldSkipSession(
    ctx: { sessionKey?: string },
    hookName: string,
  ): boolean {
    // Isolate background reviews and legacy internal sessions from user activity.
    if (
      ctx.sessionKey?.includes(":active-memory:") ||
      isSkillHarnessReviewSessionKey(ctx.sessionKey) ||
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
      if (session.activeRunIds?.has(runId)) {
        return true;
      }
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
    if (runId) {
      if (!session.runId) {
        session.runId = runId;
      }
      if (!session.activeRunIds) {
        session.activeRunIds = new Set();
      }
      session.activeRunIds.add(runId);
    }
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
      if (ctx.sessionKey && activeSession.ownerSessionKey !== ctx.sessionKey) {
        const nextOwnerSessionKey = ctx.sessionKey;
        await replaceActivityGeneration(
          activeSession,
          nextOwnerSessionKey,
          ctx.runId,
          "message_received_owner_switch",
        );
        return;
      }

      const steerText = extractInboundSteerText(event);

      const isAlreadyAdmittedRun = Boolean(
        ctx.runId &&
        (activeSession.runId === ctx.runId ||
          activeSession.activeRunIds?.has(ctx.runId)),
      );

      const isSteerMessage =
        !activeSession.finalized &&
        steerText.length > 0 &&
        (activeSession.statusMessageId !== undefined ||
          activeSession.toolHistory.length > 0);

      const isPreservedActiveTurn =
        !activeSession.finalized && (isAlreadyAdmittedRun || isSteerMessage);

      if (isPreservedActiveTurn) {
        if (ctx.runId) {
          if (!activeSession.activeRunIds) {
            activeSession.activeRunIds = new Set();
          }
          activeSession.activeRunIds.add(ctx.runId);
        }
        adoptInboundChannel(activeSession, actualChannelId);
        activeSession.userMessageId = event.messageId;
        activeSession.senderId = extractSenderId(event.metadata);
        activeSession.accountId = ctx.accountId;

        if (steerText) {
          const hasMatchingSteer =
            (ctx.runId !== undefined &&
              activeSession.steeredRunIds?.has(ctx.runId)) ||
            activeSession.toolHistory.some(
              (entry) =>
                entry.toolName === "steer" && entry.params?.steer === steerText,
            );
          if (!hasMatchingSteer) {
            toolHistoryManager.addEntry(activeSession.toolHistory, {
              toolCallId: `steer:${event.messageId ?? ctx.runId ?? Date.now()}`,
              toolName: "steer",
              params: { steer: steerText },
              status: "completed",
              startedAtMs: Date.now(),
            });
            if (ctx.runId) {
              if (!activeSession.steeredRunIds) {
                activeSession.steeredRunIds = new Set();
              }
              activeSession.steeredRunIds.add(ctx.runId);
            }
            await updateSessionStatus(activeSession, false);
          }
        }
        return;
      }

      if (
        activeSession.finalized ||
        (ctx.runId !== undefined &&
          activeSession.runId !== undefined &&
          activeSession.runId !== ctx.runId &&
          !activeSession.activeRunIds?.has(ctx.runId))
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

      adoptInboundChannel(activeSession, actualChannelId);
      activeSession.userMessageId = event.messageId;
      activeSession.senderId = extractSenderId(event.metadata);
      activeSession.accountId = ctx.accountId;
      if (ctx.runId) {
        activeSession.runId = ctx.runId;
        if (!activeSession.activeRunIds) {
          activeSession.activeRunIds = new Set();
        }
        activeSession.activeRunIds.add(ctx.runId);
      }
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
      logger.info("before_tool_call: skip finalized session.", {
        sessionKey: ctx.sessionKey,
        toolCallId: event.toolCallId,
        runId: event.runId,
        generation: session.generation,
      });
      return;
    }

    if (session.overflowRecoveryPending) {
      clearOverflowRecoveryState(session);
      clearSessionTimer(session);
    }
    if (session.compactionActive) {
      finishCompactionEntry(session, "completed");
      session.compactionActive = false;
    }

    if (!toolCallId) return;
    upsertToolEntry(toolHistoryManager, session.toolHistory, {
      toolCallId,
      toolName,
      params: event.params,
      status: "pending",
      startedAtMs: observedAtMs,
    });

    const update = updateSessionStatus(session, false);
    update.catch((err: unknown) => {
      logger.warn("before_tool_call: status update failed.", {
        contextKey: session.contextKey,
        error: String(err),
      });
    });
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
      const pendingEntry = findDedupedToolEntry(session.toolHistory, {
        toolCallId: event.toolCallId ?? "",
        toolName: event.toolName,
        params: event.params,
      });
      if (!pendingEntry || pendingEntry.status !== "pending") {
        logger.info("after_tool_call: skip finalized session.", {
          sessionKey: ctx.sessionKey,
          toolCallId: event.toolCallId,
          runId: event.runId,
          generation: session.generation,
        });
        return;
      }
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
      try {
        await updateSessionStatus(session, false);
      } catch (err) {
        logger.warn("after_tool_call: status update failed.", {
          contextKey: session.contextKey,
          error: String(err),
        });
      }
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
    if (session.runId && ctx.runId && session.runId !== ctx.runId) {
      logger.debug(
        "message_sending: skip finalization from older admitted run",
        {
          contextKey,
          sessionKey,
          currentRunId: session.runId,
          incomingRunId: ctx.runId,
        },
      );
      return undefined;
    }
    logger.info(
      "message_sending: updating session status on outbound message",
      {
        contextKey,
        sessionKey,
        runId: ctx.runId,
        generation: session.generation,
      },
    );
    const wasOverflowRecoveryPending = session.overflowRecoveryPending === true;
    const needsOverflowOrCompactionCleanup =
      wasOverflowRecoveryPending || session.compactionActive === true;
    session.overflowRecoveryPending = false;
    if (wasOverflowRecoveryPending) {
      consumeDeferredOverflowFailure(session);
    }
    if (session.compactionActive) {
      session.compactionActive = false;
      finishCompactionEntry(session, "completed");
    }
    finishPendingHindsightMemoryRecalls(session.toolHistory);
    finishPendingSkillHarness(session.toolHistory);
    session.finalized = true;
    await updateSessionStatus(session, true);
    if (needsOverflowOrCompactionCleanup) {
      scheduleSessionCleanup(
        contextKey,
        session,
        sessionKey,
        DEFAULT_AGENT_END_DELAY_MS,
        "message_sending_delayed",
        getToken,
      );
    }
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
        if (!session.activeRunIds) session.activeRunIds = new Set();
        session.activeRunIds.add(ctx.runId);
        return { handled: false };
      }
      if (!session.finalized) {
        if (session.activeRunIds?.has(ctx.runId)) {
          logger.info(
            "before_agent_reply: adopting active steer/continuation run",
            {
              contextKey,
              sessionKey: ctx.sessionKey,
              previousRunId: session.runId,
              nextRunId: ctx.runId,
              generation: session.generation,
            },
          );
          session.runId = ctx.runId;

          const steerText = event.cleanedBody?.trim();
          if (steerText) {
            const hasMatchingSteer =
              (ctx.runId !== undefined &&
                session.steeredRunIds?.has(ctx.runId)) ||
              session.toolHistory.some(
                (entry) =>
                  entry.toolName === "steer" &&
                  entry.params?.steer === steerText,
              );
            if (!hasMatchingSteer) {
              toolHistoryManager.addEntry(session.toolHistory, {
                toolCallId: `steer:${ctx.runId ?? Date.now()}`,
                toolName: "steer",
                params: { steer: steerText },
                status: "completed",
                startedAtMs: Date.now(),
              });
              if (ctx.runId) {
                if (!session.steeredRunIds) {
                  session.steeredRunIds = new Set();
                }
                session.steeredRunIds.add(ctx.runId);
              }
              await updateSessionStatus(session, false);
            }
          }
          return { handled: false };
        }
        return { handled: false };
      }

      logger.info("before_agent_reply: triggering run replacement", {
        contextKey,
        sessionKey: ctx.sessionKey,
        currentRunId: session.runId,
        incomingRunId: ctx.runId,
        generation: session.generation,
      });

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
      if (session.runId && ctx.runId && session.runId !== ctx.runId) {
        logger.debug("agent_end: skip older admitted run cleanup", {
          contextKey,
          currentRunId: session.runId,
          incomingRunId: ctx.runId,
        });
        return;
      }
      finishPendingHindsightMemoryRecalls(session.toolHistory);
      finishPendingSkillHarness(session.toolHistory);
      if (compactionWasActiveAtDispatch) {
        session.compactionActive = false;
        finishCompactionEntry(session, "error");
      } else if (isContextOverflowAttemptError(event.error)) {
        if (session.compactionActive) {
          return;
        }
        session.overflowRecoveryPending = true;
        session.overflowRecoveryFailure = {
          ...event,
          success: false,
        };
        session.finalized = false;
        clearMaxDisplayTimer(session);
        logger.info(
          "agent_end: deferring finalization for context overflow recovery",
          {
            contextKey,
            sessionKey: ctx.sessionKey,
            runId: ctx.runId,
            generation: session.generation,
          },
        );
        if (store.hasVisibleStatusState(session)) {
          await updateSessionStatus(session, false);
        }
        if (
          session.overflowRecoveryPending &&
          !session.compactionActive &&
          !session.finalized
        ) {
          scheduleOverflowRecoveryGrace(contextKey, session, ctx.sessionKey);
        }
        return;
      }

      clearOverflowRecoveryState(session);
      const hasFailure = event.success === false || Boolean(event.error);
      if (session.finalized && session.pendingOp) {
        try {
          await session.pendingOp;
        } catch (err) {
          logger.warn("agent_end: pending status update failed.", {
            contextKey,
            error: String(err),
          });
        }
        if (
          !store.isCurrentSession(session) ||
          !bindSessionRun(session, ctx.runId)
        ) {
          return;
        }
      }
      const failureVisibleChange = hasFailure
        ? renderedFailureChanged(session, event)
        : false;
      if (hasFailure && (!session.finalized || failureVisibleChange)) {
        recordMainAgentFailure(session, event);
      }

      logger.info("agent_end: finalizing session", {
        contextKey,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        generation: session.generation,
        success: event.success,
        hasError: Boolean(event.error),
        failureVisibleChange,
      });

      if (
        session.finalized &&
        !failureVisibleChange &&
        confirmedFinalRendered(session)
      ) {
        scheduleSessionCleanup(
          contextKey,
          session,
          ctx.sessionKey,
          DEFAULT_AGENT_END_DELAY_MS,
          "agent_end_delayed",
          getToken,
        );
        return;
      }

      await resolveAndFinalize(
        ctx,
        DEFAULT_AGENT_END_DELAY_MS,
        "agent_end",
        session,
      );
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

    clearOverflowRecoveryState(session);
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
    clearOverflowRecoveryState(session);
    session.compactionActive = false;
    session.finalized = false;
    await updateSessionStatus(session, false);
  }

  async function onHindsightMemoryPipelineEvent(event: AgentPipelineEvent) {
    const parsed = parseHindsightMemoryRecallEvent(event);
    if (!parsed || shouldSkipSession(parsed, "hindsight_memory_pipeline"))
      return;
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
      if (session.overflowRecoveryPending && !session.compactionActive) {
        scheduleOverflowRecoveryGrace(contextKey, session, sessionKey);
      }
    } catch (err) {
      logger.warn(
        "hindsight_memory_pipeline: failed to update activity status.",
        {
          sessionKey,
          error: String(err),
        },
      );
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
      if (session.overflowRecoveryPending && !session.compactionActive) {
        scheduleOverflowRecoveryGrace(contextKey, session, sessionKey);
      }
    } catch (err) {
      logger.warn("skill_harness_pipeline: failed to update activity status.", {
        sessionKey,
        error: String(err),
      });
    }
  }

  return Object.freeze({
    onHindsightMemoryPipelineEvent,
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
