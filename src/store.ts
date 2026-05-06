import { createSubsystemLogger } from "../api.js";
import type { ChannelMeta, SessionEntry } from "./types.js";
import { sleep } from "./discord-api.js";
import { SESSION_RESOLVE_RETRY_MS } from "./constants.js";

const logger = createSubsystemLogger("plugins");

export function createSessionStore() {
  const sessions = new Map<string, SessionEntry>();
  const contexts = new Map<string, ChannelMeta>();

  function isCurrentSession(session: SessionEntry): boolean {
    return sessions.get(session.contextKey) === session;
  }

  function hasVisibleStatusState(session: SessionEntry): boolean {
    return session.toolHistory.some(
      (t) => t.toolCallId !== "init" && t.toolCallId !== "active-memory",
    );
  }

  async function waitForPendingOp(
    session: SessionEntry,
    hookName: string,
  ): Promise<void> {
    if (!session.pendingOp) return;
    logger.debug(
      `discord-tool-status: [${hookName}] Waiting for pending op...`,
      {
        subsystem: "plugins",
      },
    );
    try {
      await session.pendingOp;
    } catch (err) {
      logger.warn(`discord-tool-status: [${hookName}] Pending op failed.`, {
        subsystem: "plugins",
        error: String(err),
      });
    }
  }

  function clearSessionState(
    contextKey: string,
    session?: SessionEntry,
    expectedGeneration?: number,
    expectedOwner?: string,
  ): void {
    if (session) {
      const current = sessions.get(contextKey);
      if (current !== session) {
        return;
      }
      if (
        current &&
        expectedGeneration !== undefined &&
        current.generation !== expectedGeneration
      ) {
        return;
      }
      if (
        current &&
        expectedOwner !== undefined &&
        current.ownerSessionKey !== expectedOwner
      ) {
        return;
      }
    }

    if (session?.clearTimer) {
      clearTimeout(session.clearTimer);
      session.clearTimer = undefined;
    }
    sessions.delete(contextKey);
    contexts.delete(contextKey);
  }

  function getOrCreateSession(
    contextKey: string,
    requestSessionKey?: string,
  ): SessionEntry | undefined {
    const normalizedRequestSessionKey =
      typeof requestSessionKey === "string" &&
      requestSessionKey.trim().length > 0
        ? requestSessionKey
        : undefined;

    const context = contexts.get(contextKey);
    const preferredOwner = context?.sourceSessionKey;
    const existing = sessions.get(contextKey);
    if (existing) {
      if (
        normalizedRequestSessionKey &&
        existing.ownerSessionKey === normalizedRequestSessionKey
      ) {
        return existing;
      }

      if (
        normalizedRequestSessionKey &&
        preferredOwner &&
        normalizedRequestSessionKey === preferredOwner
      ) {
        return undefined;
      }

      if (
        preferredOwner &&
        existing.ownerSessionKey === preferredOwner &&
        normalizedRequestSessionKey &&
        normalizedRequestSessionKey !== preferredOwner
      ) {
        return undefined;
      }

      return existing;
    }

    if (!context) return undefined;

    if (
      preferredOwner &&
      normalizedRequestSessionKey &&
      normalizedRequestSessionKey !== preferredOwner
    ) {
      return undefined;
    }

    const ownerSessionKey =
      normalizedRequestSessionKey || preferredOwner || contextKey;

    const created: SessionEntry = {
      contextKey,
      channelId: context.actualChannelId,
      userMessageId: context.userMessageId,
      senderId: context.senderId,
      accountId: context.accountId,
      ownerSessionKey,
      generation: 1,
      toolHistory: [],
    };
    sessions.set(contextKey, created);
    return created;
  }

  async function resolveSession(
    contextKey: string,
    requestSessionKey?: string,
  ): Promise<SessionEntry | undefined> {
    const immediate = getOrCreateSession(contextKey, requestSessionKey);
    if (immediate) return immediate;

    await sleep(SESSION_RESOLVE_RETRY_MS);
    return getOrCreateSession(contextKey, requestSessionKey);
  }

  return Object.freeze({
    sessions,
    contexts,
    isCurrentSession,
    hasVisibleStatusState,
    getOrCreateSession,
    resolveSession,
    clearSessionState,
    waitForPendingOp,
  });
}
