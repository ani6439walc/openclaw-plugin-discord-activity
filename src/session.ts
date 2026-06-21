import { logger } from "../api.js";
import type { ChannelMeta, SessionEntry } from "./types.js";
import { DiscordMessageOperations } from "./discord-message-operations.js";
import { createSessionStore } from "./store.js";
import { createEnhancedOrphanManager } from "./enhanced-orphans.js";
import { renderStatusContent } from "./render.js";
import { clearSessionTimer } from "./helpers.js";
import {
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  STATUS_MAX_ENTRIES,
} from "./constants.js";

export const defaultStore = createSessionStore();
export const defaultOrphans = createEnhancedOrphanManager();

function clearTimers(session: SessionEntry) {
  clearSessionTimer(session);
  if (session.maxDisplayTimer) {
    clearTimeout(session.maxDisplayTimer);
    session.maxDisplayTimer = undefined;
  }
}

function resetSessionState(session: SessionEntry) {
  session.toolHistory = [];
  session.lastRenderedContent = undefined;
  session.finalized = false;
}

// Backward-compat re-exports during transition
export const activeSessions = defaultStore.sessions;
export const sessionContextMap = defaultStore.contexts;

// Re-export store methods for backward compat
export const isCurrentSession =
  defaultStore.isCurrentSession.bind(defaultStore);
export const hasVisibleStatusState =
  defaultStore.hasVisibleStatusState.bind(defaultStore);
export const getOrCreateSession =
  defaultStore.getOrCreateSession.bind(defaultStore);
export const resolveSession = defaultStore.resolveSession.bind(defaultStore);
export const clearSessionState =
  defaultStore.clearSessionState.bind(defaultStore);
export const waitForPendingOp =
  defaultStore.waitForPendingOp.bind(defaultStore);

export async function retireSession(
  session: SessionEntry,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  clearTimers(session);

  await waitForPendingOp(session, `${hookName}_retire_wait`);

  if (!session.statusMessageId) {
    resetSessionState(session);
    return;
  }

  const operations = new DiscordMessageOperations(getToken);
  const staleMsgId = session.statusMessageId;
  const deleted = await operations.delete(session.channelId, staleMsgId, session.accountId);
  if (deleted && session.statusMessageId === staleMsgId) {
    session.statusMessageId = undefined;
  }
  resetSessionState(session);
}

export function scheduleSessionCleanup(
  contextKey: string,
  session: SessionEntry,
  requestSessionKey: string | undefined,
  delayMs: number,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  if (requestSessionKey && session.ownerSessionKey !== requestSessionKey) {
    return;
  }

  const expectedGeneration = session.generation;
  const expectedOwner = session.ownerSessionKey;

  if (session.clearTimer) {
    clearTimeout(session.clearTimer);
  }

  session.clearTimer = setTimeout(() => {
    const current = activeSessions.get(contextKey);
    if (
      !current ||
      current !== session ||
      current.generation !== expectedGeneration ||
      current.ownerSessionKey !== expectedOwner
    ) {
      return;
    }

    if (session.maxDisplayTimer) {
      clearTimeout(session.maxDisplayTimer);
      session.maxDisplayTimer = undefined;
    }

    clearStatusMessage(session, hookName, getToken)
      .catch((err) => {
        logger.warn(`failed to clear status message on ${hookName}.`, {
          contextKey,
          error: String(err),
        });
      })
      .finally(() => {
        clearSessionState(
          contextKey,
          session,
          expectedGeneration,
          expectedOwner,
        );
      });
  }, delayMs);
}

export async function clearStatusMessage(
  session: SessionEntry,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  await waitForPendingOp(session, `${hookName}_wait`);

  // Only clear the maxDisplayTimer, not the session cleanup timer
  if (session.maxDisplayTimer) {
    clearTimeout(session.maxDisplayTimer);
    session.maxDisplayTimer = undefined;
  }

  if (!session.statusMessageId) return;

  const operations = new DiscordMessageOperations(getToken);
  const msgId = session.statusMessageId;
  logger.debug(`[${hookName}] deleting status message ${msgId}.`);
  
  const deleted = await operations.delete(session.channelId, msgId, session.accountId);
  if (deleted) {
    session.statusMessageId = undefined;
  }
  resetSessionState(session);
}

function startMaxDisplayTimer(
  session: SessionEntry,
  contextKey: string,
  maxDisplayMs: number,
  getToken: (accountId?: string) => string,
) {
  if (session.maxDisplayTimer) {
    clearTimeout(session.maxDisplayTimer);
  }

  session.maxDisplayTimer = setTimeout(() => {
    const current = activeSessions.get(contextKey);
    if (!current || current !== session) {
      return;
    }

    logger.warn(
      `status message exceeded maxDisplayMs (${maxDisplayMs}ms), forcing cleanup.`,
      { contextKey, maxDisplayMs },
    );

    clearStatusMessage(session, "max_display_timeout", getToken)
      .catch((err) => {
        logger.warn("failed to clear status message on max_display_timeout.", {
          contextKey,
          error: String(err),
        });
      })
      .finally(() => {
        clearSessionState(contextKey, session);
      });
  }, maxDisplayMs);
}

export async function updateStatusMessage(
  session: SessionEntry,
  getToken: (accountId?: string) => string,
  isFinal = false,
  maxDisplayMs?: number,
  maxStatusMessageLength = DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
) {
  const priorOp = session.pendingOp;
  const op = (async () => {
    if (priorOp) {
      logger.debug("[update_status_message] waiting for pending op...");
      try {
        await priorOp;
      } catch (err) {
        logger.warn("[update_status_message] pending op failed.", {
          error: String(err),
        });
      }
    }

    let content = "";
    while (session.toolHistory.length > 0) {
      content = renderStatusContent(session.toolHistory, isFinal);
      if (
        content.length <= maxStatusMessageLength &&
        session.toolHistory.length <= STATUS_MAX_ENTRIES
      ) {
        break;
      }
      session.toolHistory.shift();
    }

    if (!content) return;

    const operations = new DiscordMessageOperations(getToken);

    const isNewMessage = !session.statusMessageId;

    if (isNewMessage && session.finalized && !isFinal) {
      logger.debug(
        "[update_status_message] skip non-final create for finalized session.",
        {
          contextKey: session.contextKey,
          ownerSessionKey: session.ownerSessionKey,
        },
      );
      return;
    }

    if (isNewMessage) {
      if (!isCurrentSession(session)) {
        return;
      }

      const createdId = await operations.sendWithDmFallback(
        session,
        content,
        session.userMessageId,
      );

      if (!createdId) {
        return;
      }

      if (!isCurrentSession(session)) {
        await operations.delete(session.channelId, createdId, session.accountId);
        return;
      }

      session.statusMessageId = createdId;
      logger.debug(`created status message ${session.statusMessageId}.`);

      if (maxDisplayMs && maxDisplayMs > 0) {
        startMaxDisplayTimer(
          session,
          session.contextKey,
          maxDisplayMs,
          getToken,
        );
      }
      session.lastRenderedContent = content;
      return;
    }

    if (!isCurrentSession(session)) {
      return;
    }

    if (!session.statusMessageId) {
      return;
    }

    if (session.lastRenderedContent === content) {
      logger.debug("skipped status message edit because content is unchanged.");
      return;
    }

    // Check token before edit to avoid state desync if edit silently aborts
    const token = getToken(session.accountId);
    if (!token) {
      logger.warn("skipped status message edit: no token available.", {
        accountId: session.accountId,
      });
      return;
    }

    await operations.edit(
      session.channelId,
      session.statusMessageId,
      content,
      session.accountId,
    );
    session.lastRenderedContent = content;
    logger.debug("updated status message.");
  })();

  session.pendingOp = op;
  try {
    await op;
  } finally {
    if (session.pendingOp === op) {
      session.pendingOp = undefined;
    }
  }
}
