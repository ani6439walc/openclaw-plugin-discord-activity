import { logger } from "../api.js";
import type { SessionEntry } from "./types.js";
import {
  deleteDiscordStatusMessage,
  editDiscordStatusMessage,
  sendDiscordStatusWithDmFallback,
} from "./discord-message-operations.js";
import { createSessionStore } from "./store.js";
import { createOrphanManager } from "./orphans.js";
import { renderStatusContent } from "./render.js";
import { clearSessionTimer, clearAllSessionTimers } from "./helpers.js";
import { DEFAULT_MAX_STATUS_MESSAGE_LENGTH } from "./constants.js";

export const defaultStore = createSessionStore();
export const defaultOrphans = createOrphanManager();

function clearTimers(session: SessionEntry) {
  clearAllSessionTimers(session);
}

function resetSessionState(session: SessionEntry) {
  session.toolHistory = [];
  session.lastRenderedContent = undefined;
  session.finalized = false;
}

export async function retireSession(
  session: SessionEntry,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  clearTimers(session);

  await defaultStore.waitForPendingOp(session, `${hookName}_retire_wait`);

  if (!session.statusMessageId) {
    resetSessionState(session);
    return;
  }

  const staleMsgId = session.statusMessageId;
  const deleted = await deleteDiscordStatusMessage(
    getToken,
    session.channelId,
    staleMsgId,
    session.accountId,
  );
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
    const current = defaultStore.sessions.get(contextKey);
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
        defaultStore.clearSessionState(
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
  await defaultStore.waitForPendingOp(session, `${hookName}_wait`);

  // Only clear the maxDisplayTimer, not the session cleanup timer
  if (session.maxDisplayTimer) {
    clearTimeout(session.maxDisplayTimer);
    session.maxDisplayTimer = undefined;
  }

  if (!session.statusMessageId) return;

  const msgId = session.statusMessageId;
  logger.debug(`[${hookName}] deleting status message ${msgId}.`);

  const deleted = await deleteDiscordStatusMessage(
    getToken,
    session.channelId,
    msgId,
    session.accountId,
  );
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
    const current = defaultStore.sessions.get(contextKey);
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
        defaultStore.clearSessionState(contextKey, session);
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
      if (content.length <= maxStatusMessageLength) {
        break;
      }
      session.toolHistory.shift();
    }

    if (!content) return;

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
      if (!defaultStore.isCurrentSession(session)) {
        return;
      }

      const createdId = await sendDiscordStatusWithDmFallback(
        getToken,
        session,
        content,
        session.userMessageId,
      );

      if (!createdId) {
        return;
      }

      if (!defaultStore.isCurrentSession(session)) {
        await deleteDiscordStatusMessage(
          getToken,
          session.channelId,
          createdId,
          session.accountId,
        );
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

    if (!defaultStore.isCurrentSession(session)) {
      return;
    }

    if (!session.statusMessageId) {
      return;
    }

    if (session.lastRenderedContent === content) {
      logger.debug("skipped status message edit because content is unchanged.");
      return;
    }

    const edited = await editDiscordStatusMessage(
      getToken,
      session.channelId,
      session.statusMessageId,
      content,
      session.accountId,
    );
    if (edited) {
      session.lastRenderedContent = content;
      logger.debug("updated status message.");
    }
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
