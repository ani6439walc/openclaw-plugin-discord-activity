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
  BeforeAgentRunEvent,
  AgentContext,
  AgentEndEvent,
  AgentPipelineEvent,
  BeforeCompactionEvent,
  AfterCompactionEvent,
} from "./types.js";
import { clearMaxDisplayTimer, clearSessionTimer } from "./helpers.js";
import {
  getDiscordContextKey,
  isActiveMemorySessionKey,
  isSkillHarnessSessionKey,
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
import {
  canonicalToolNameForDedupe,
  isCodexOpenClawToolName,
  preferDisplayToolName,
  preferToolCallId,
  type ToolDedupeIdentity,
} from "./tool-name.js";
import {
  getSkillHarnessPipelineSessionKey,
  mergeSkillHarnessPipelineEntry,
  parseSkillHarnessPipelineEntry,
} from "./skill-harness-status.js";

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

function reconcileActiveMemoryTranscriptEntries(
  history: readonly ToolEntry[],
  entries: readonly ToolEntry[],
): ToolEntry[] {
  const liveChildren = history.filter(
    (entry) =>
      entry.toolName.startsWith("active-memory:") &&
      entry.toolName !== "active-memory:result",
  );
  const claimed = new Set<ToolEntry>();

  return entries.map((entry) => {
    const exact = liveChildren.find(
      (candidate) =>
        !claimed.has(candidate) && candidate.toolCallId === entry.toolCallId,
    );
    if (exact) {
      claimed.add(exact);
      return entry;
    }
    if (entry.toolName === "active-memory:result") {
      return entry;
    }

    const semanticMatch = liveChildren.find(
      (candidate) =>
        !claimed.has(candidate) &&
        candidate.toolName === entry.toolName &&
        stableParamsKey(candidate.params) === stableParamsKey(entry.params),
    );
    if (!semanticMatch) {
      return entry;
    }

    claimed.add(semanticMatch);
    return { ...entry, toolCallId: semanticMatch.toolCallId };
  });
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

function buildPendingSubagentEntries(
  agentId: string | undefined,
  isActiveMemoryEnabled: (agentId: string) => boolean,
  isSkillHarnessEnabled: (agentId: string) => boolean,
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

  if (agentId === undefined || isSkillHarnessEnabled(agentId)) {
    entries.push({
      toolCallId: "skill-harness",
      toolName: "skill-harness",
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
    isSkillHarnessEnabled,
  } = deps;

  // Initialize the ToolHistoryManager
  const toolHistoryManager = new ToolHistoryManager(config);
  const activeMemoryRunIdsBySession = new WeakMap<SessionEntry, Set<string>>();

  function registerActiveMemoryRun(session: SessionEntry, runId: string): void {
    const activeMemoryRunIds =
      activeMemoryRunIdsBySession.get(session) ?? new Set<string>();
    activeMemoryRunIds.add(runId);
    activeMemoryRunIdsBySession.set(session, activeMemoryRunIds);
  }

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

  function completeUnobservedActiveMemoryPlaceholder(
    session: SessionEntry,
  ): void {
    const placeholder = session.toolHistory.find(
      (entry) => entry.toolCallId === "active-memory",
    );
    if (!placeholder || placeholder.status !== "pending") return;
    const hasObservedActiveMemory = session.toolHistory.some((entry) =>
      entry.toolName.startsWith("active-memory:"),
    );
    if (hasObservedActiveMemory) return;

    placeholder.status = "completed";
    session.toolHistory.push({
      toolCallId: "active-memory:fastpath-inferred",
      toolName: "active-memory:fastpath",
      params: { status: "inferred" },
      status: "completed",
    });
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

  async function showPendingSubagentEntries(
    session: SessionEntry,
    ownerSessionKey: string | undefined,
  ): Promise<void> {
    const agentId = extractAgentIdFromSessionKey(ownerSessionKey);
    const pendingEntries = buildPendingSubagentEntries(
      agentId,
      isActiveMemoryEnabled,
      isSkillHarnessEnabled,
    );
    if (pendingEntries.length === 0) return;

    toolHistoryManager.addEntries(session.toolHistory, pendingEntries);
    await updateSessionStatus(session, false);
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
        ...(activeMemoryRunIdsBySession.get(activeSession) ?? []),
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

    await showPendingSubagentEntries(replacement, ownerSessionKey);
    return replacement;
  }

  function shouldSkipSession(
    ctx: { sessionKey?: string },
    hookName: string,
  ): boolean {
    if (
      isActiveMemorySessionKey(ctx.sessionKey) ||
      isSkillHarnessSessionKey(ctx.sessionKey) ||
      isSubagentSessionKey(ctx.sessionKey)
    ) {
      logger.trace(
        `${hookName}: skip (active-memory/skill-harness/subagent) session.`,
        {
          sessionKey: ctx.sessionKey,
        },
      );
      return true;
    }
    return false;
  }

  function shouldSkipToolSession(
    ctx: { sessionKey?: string },
    hookName: string,
  ): boolean {
    if (
      isSkillHarnessSessionKey(ctx.sessionKey) ||
      (isSubagentSessionKey(ctx.sessionKey) &&
        !isActiveMemorySessionKey(ctx.sessionKey))
    ) {
      logger.trace(`${hookName}: skip (skill-harness/subagent) session.`, {
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
    if (
      session.runId &&
      session.runId !== runId &&
      !activeMemoryRunIdsBySession.get(session)?.has(runId)
    ) {
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
    bindRun = true,
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
    return bindRun
      ? bindSessionRun(session, runId)
      : isSessionRunCurrent(session, runId);
  }

  async function resolveAndFinalize(
    ctx: AgentContext,
    delayMs: number,
    hookName: string,
    requireVisibleState = false,
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
    if (requireVisibleState && !store.hasVisibleStatusState(session)) return;
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

    const session = store.getOrCreateSession(contextKey, ctx.sessionKey);
    if (session && session.toolHistory.length === 0) {
      await showPendingSubagentEntries(session, ctx.sessionKey);
    }
  }

  async function onBeforeToolCall(
    event: BeforeToolCallEvent,
    ctx: ToolContext,
  ) {
    if (shouldSkipToolSession(ctx, "before_tool_call")) return;
    const observedAtMs = Date.now();
    logHookEvent("before_tool_call", event, ctx);
    orphans.pruneStale();

    const sourceSessionKey =
      getActiveMemorySourceSessionKey(ctx.sessionKey) ?? ctx.sessionKey;
    const contextKey = getDiscordContextKey(sourceSessionKey);
    const session = contextKey
      ? await store.resolveSession(contextKey, sourceSessionKey)
      : undefined;
    const isActiveMemoryTool = isActiveMemorySessionKey(ctx.sessionKey);
    const toolCallId =
      isActiveMemoryTool && event.toolCallId
        ? `active-memory:${event.toolCallId}`
        : event.toolCallId;
    const toolName = isActiveMemoryTool
      ? `active-memory:${event.toolName}`
      : event.toolName;

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

    if (!bindToolEventRun(session, event.runId, ctx.runId, !isActiveMemoryTool))
      return;

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
    if (shouldSkipToolSession(ctx, "after_tool_call")) return;
    const observedAtMs = Date.now();
    logHookEvent("after_tool_call", event, ctx);
    orphans.pruneStale();

    const sourceSessionKey =
      getActiveMemorySourceSessionKey(ctx.sessionKey) ?? ctx.sessionKey;
    const contextKey = getDiscordContextKey(sourceSessionKey);
    const session = contextKey
      ? await store.resolveSession(contextKey, sourceSessionKey)
      : undefined;
    const isActiveMemoryTool = isActiveMemorySessionKey(ctx.sessionKey);

    if (!session) return;

    if (!bindToolEventRun(session, event.runId, ctx.runId, !isActiveMemoryTool))
      return;

    if (session.finalized) {
      logger.debug("after_tool_call: skip finalized session.", {
        sessionKey: ctx.sessionKey,
        toolCallId: event.toolCallId,
      });
      return;
    }

    if (!event.toolCallId) return;
    const toolCallId = isActiveMemoryTool
      ? `active-memory:${event.toolCallId}`
      : event.toolCallId;

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
    completeUnobservedActiveMemoryPlaceholder(session);
    session.finalized = true;
    await updateSessionStatus(session, true);
    return undefined;
  }

  async function onBeforeAgentRun(
    _event: BeforeAgentRunEvent,
    ctx: AgentContext,
  ) {
    if (!isActiveMemorySessionKey(ctx.sessionKey) || !ctx.runId) return;
    const sourceSessionKey = getActiveMemorySourceSessionKey(ctx.sessionKey);
    const contextKey = getDiscordContextKey(sourceSessionKey);
    if (!contextKey || !sourceSessionKey) return;
    try {
      const session = await store.resolveSession(contextKey, sourceSessionKey);
      if (!session || !store.isCurrentSession(session)) return;
      if (session.supersededRunIds?.has(ctx.runId)) return;
      registerActiveMemoryRun(session, ctx.runId);
    } catch (err) {
      logger.warn("before_agent_run: failed to register active-memory run.", {
        contextKey,
        sessionKey: ctx.sessionKey,
        error: String(err),
      });
    }
  }

  async function onBeforeAgentReply(
    event: BeforeAgentReplyEvent,
    ctx: AgentContext,
  ) {
    if (isActiveMemorySessionKey(ctx.sessionKey)) {
      const sourceSessionKey = getActiveMemorySourceSessionKey(ctx.sessionKey);
      const contextKey = getDiscordContextKey(sourceSessionKey);
      try {
        if (ctx.runId && contextKey && sourceSessionKey) {
          const session = await store.resolveSession(
            contextKey,
            sourceSessionKey,
          );
          if (
            session &&
            store.isCurrentSession(session) &&
            !session.finalized &&
            !session.supersededRunIds?.has(ctx.runId)
          ) {
            registerActiveMemoryRun(session, ctx.runId);
          }
        }
      } catch (err) {
        logger.warn(
          "before_agent_reply: failed to register active-memory run.",
          {
            contextKey,
            sessionKey: ctx.sessionKey,
            error: String(err),
          },
        );
      }
      return { handled: false };
    }
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
    if (
      isSubagentSessionKey(ctx.sessionKey) &&
      !isActiveMemorySessionKey(ctx.sessionKey) &&
      !isSkillHarnessSessionKey(ctx.sessionKey)
    ) {
      logger.trace("agent_end: skip subagent session.", {
        sessionKey: ctx.sessionKey,
      });
      return;
    }
    logHookEvent("agent_end", event, ctx);

    const contextKey = getDiscordContextKey(ctx.sessionKey);
    const compactionWasActiveAtDispatch = contextKey
      ? store.sessions.get(contextKey)?.compactionActive === true
      : false;
    if (contextKey) {
      if (isActiveMemorySessionKey(ctx.sessionKey)) {
        const sourceSessionKey = getActiveMemorySourceSessionKey(
          ctx.sessionKey,
        );
        const session = sourceSessionKey
          ? store.getOrCreateSession(contextKey, sourceSessionKey)
          : undefined;
        if (session) {
          if (ctx.runId && session.supersededRunIds?.has(ctx.runId)) return;
          if (
            ctx.runId &&
            ctx.runId !== session.runId &&
            !activeMemoryRunIdsBySession.get(session)?.has(ctx.runId)
          ) {
            return;
          }
          clearSessionTimer(session);
          const entries = reconcileActiveMemoryTranscriptEntries(
            session.toolHistory,
            parseActiveMemoryToolEntries(event),
          );
          const preservedPlaceholder = session.toolHistory.find(
            (t) => t.toolCallId === "active-memory",
          );
          const parentEntry: ToolEntry | undefined =
            event.error || event.success === false
              ? {
                  toolCallId: "active-memory",
                  toolName: "active-memory",
                  params: preservedPlaceholder?.params ?? {},
                  status: "error",
                  startedAtMs: preservedPlaceholder?.startedAtMs,
                  durationMs: event.durationMs,
                  error: event.error,
                }
              : preservedPlaceholder || typeof event.durationMs === "number"
                ? {
                    toolCallId: "active-memory",
                    toolName: "active-memory",
                    params: preservedPlaceholder?.params ?? {},
                    status: "completed",
                    startedAtMs: preservedPlaceholder?.startedAtMs,
                    durationMs:
                      event.durationMs ?? preservedPlaceholder?.durationMs,
                  }
                : undefined;

          if (entries.length > 0 || parentEntry) {
            if (
              entries.some((entry) => entry.toolName === "active-memory:result")
            ) {
              session.confirmedDisplayState = {
                ...(session.confirmedDisplayState ?? {}),
                "group:active-memory": "expanded",
              };
              session.monotonicSafetyFloor = {
                ...(session.monotonicSafetyFloor ?? {}),
                "group:active-memory": "expanded",
              };
            }
            const newEntries =
              entries.length > 0
                ? toolHistoryManager.upsertEntries(session.toolHistory, entries)
                : [];
            const childEntries = toolHistoryManager
              .findSubagentChildEntries(session.toolHistory, "active-memory")
              .concat(newEntries);
            toolHistoryManager.replaceSubagentGroup(
              session.toolHistory,
              "active-memory",
              parentEntry ? [parentEntry, ...childEntries] : childEntries,
            );
            toolHistoryManager.trim(session.toolHistory);
          }
          await updateSessionStatus(session, true);
        }
        return;
      }

      if (isSkillHarnessSessionKey(ctx.sessionKey)) {
        return;
      }

      const session = await store.resolveSession(contextKey, ctx.sessionKey);
      if (!session || !bindSessionRun(session, ctx.runId)) return;
      if (event.success !== false && !event.error) {
        completeUnobservedActiveMemoryPlaceholder(session);
      }
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

      await resolveAndFinalize(
        ctx,
        AGENT_END_DELAY_MS,
        "agent_end",
        false,
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

  async function onSkillHarnessPipelineEvent(event: AgentPipelineEvent) {
    const observedAtMs = Date.now();
    const sessionKey = getSkillHarnessPipelineSessionKey(event);
    if (!sessionKey) return;

    const entry = parseSkillHarnessPipelineEntry(event);
    if (!entry) return;

    const contextKey = getDiscordContextKey(sessionKey);
    if (!contextKey) return;

    const session = contextKey
      ? await store.resolveSession(contextKey, sessionKey)
      : undefined;
    if (!session) return;
    const provenanceRunId =
      event.runId === sessionKey ? undefined : event.runId;
    if (!isSessionRunCurrent(session, provenanceRunId)) return;

    clearSessionTimer(session);
    const existingChildEntries = toolHistoryManager.findSubagentChildEntries(
      session.toolHistory,
      "skill-harness",
    );
    const existingParentEntry = session.toolHistory.find(
      (tool) => tool.toolName === "skill-harness",
    );
    const shouldPreserveParent =
      entry.toolName === "skill-harness" ||
      existingParentEntry?.status !== "pending" ||
      typeof existingParentEntry.startedAtMs === "number";
    const existingEntries =
      existingParentEntry && shouldPreserveParent
        ? [existingParentEntry, ...existingChildEntries]
        : existingChildEntries;
    const merged = mergeSkillHarnessPipelineEntry(
      existingEntries,
      entry,
      observedAtMs,
    );
    if (!merged.changed) {
      return;
    }
    toolHistoryManager.replaceSubagentGroup(
      session.toolHistory,
      "skill-harness",
      merged.entries,
    );
    toolHistoryManager.trim(session.toolHistory);
    await updateSessionStatus(session, false);
  }

  return Object.freeze({
    onMessageReceived,
    onBeforeToolCall,
    onAfterToolCall,
    onMessageSending,
    onBeforeAgentRun,
    onBeforeAgentReply,
    onAgentEnd,
    onBeforeCompaction,
    onAfterCompaction,
    onSkillHarnessPipelineEvent,
  });
}
