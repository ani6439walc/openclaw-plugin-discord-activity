import { logger } from "../api.js";
import type { SessionEntry } from "./types.js";
import {
  deleteDiscordStatusMessageWithResult,
  editDiscordStatusMessage,
  sendDiscordStatusWithDmFallback,
} from "./discord-message-operations.js";
import { createSessionStore } from "./store.js";
import { createOrphanManager } from "./orphans.js";
import { renderStatusContent } from "./render.js";
import { clearSessionTimer, clearAllSessionTimers } from "./helpers.js";
import {
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  DELETE_RECOVERY_DELAY_MS,
} from "./constants.js";

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

async function runSerializedSessionOperation(
  session: SessionEntry,
  hookName: string,
  operation: () => Promise<void>,
) {
  const priorOp = session.pendingOp;
  const op = (async () => {
    if (priorOp) {
      logger.debug(`[${hookName}] waiting for pending op...`);
      try {
        await priorOp;
      } catch (error) {
        logger.warn(`[${hookName}] pending op failed.`, {
          error: String(error),
        });
      }
    }
    await operation();
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

function scheduleDeleteRecovery(
  session: SessionEntry,
  messageId: string,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  const cleanup = {
    contextKey: session.contextKey,
    channelId: session.channelId,
    messageId,
    accountId: session.accountId,
  };

  setTimeout(() => {
    void deleteDiscordStatusMessageWithResult(
      getToken,
      cleanup.channelId,
      cleanup.messageId,
      cleanup.accountId,
    )
      .then((result) => {
        if (result.deleted) return;
        logger.warn("status message cleanup recovery failed.", {
          contextKey: cleanup.contextKey,
          channelId: cleanup.channelId,
          messageId: cleanup.messageId,
          hookName,
          attemptCount: 2,
          terminalReason: result.reason,
          status: result.status,
        });
      })
      .catch((error) => {
        logger.warn("status message cleanup recovery threw unexpectedly.", {
          contextKey: cleanup.contextKey,
          channelId: cleanup.channelId,
          messageId: cleanup.messageId,
          hookName,
          attemptCount: 2,
          terminalReason: "unexpected-error",
          error: String(error),
        });
      });
  }, DELETE_RECOVERY_DELAY_MS);
}

async function deleteStatusMessageWithRecovery(
  session: SessionEntry,
  messageId: string,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  const result = await deleteDiscordStatusMessageWithResult(
    getToken,
    session.channelId,
    messageId,
    session.accountId,
  );
  if (!result.deleted && result.retryable) {
    scheduleDeleteRecovery(session, messageId, hookName, getToken);
  } else if (!result.deleted) {
    logger.warn("status message cleanup failed without recovery.", {
      contextKey: session.contextKey,
      channelId: session.channelId,
      messageId,
      hookName,
      attemptCount: 1,
      terminalReason: result.reason,
      status: result.status,
    });
  }
}

export async function retireSession(
  session: SessionEntry,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  clearTimers(session);
  await runSerializedSessionOperation(
    session,
    `${hookName}_retire`,
    async () => {
      if (!session.statusMessageId) {
        resetSessionState(session);
        return;
      }

      const staleMsgId = session.statusMessageId;
      await deleteStatusMessageWithRecovery(
        session,
        staleMsgId,
        hookName,
        getToken,
      );
      if (session.statusMessageId === staleMsgId) {
        session.statusMessageId = undefined;
      }
      resetSessionState(session);
    },
  );
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
  await runSerializedSessionOperation(session, hookName, async () => {
    // Only clear the maxDisplayTimer, not the session cleanup timer
    if (session.maxDisplayTimer) {
      clearTimeout(session.maxDisplayTimer);
      session.maxDisplayTimer = undefined;
    }

    if (!session.statusMessageId) return;

    const msgId = session.statusMessageId;
    logger.debug(`[${hookName}] deleting status message ${msgId}.`);

    await deleteStatusMessageWithRecovery(session, msgId, hookName, getToken);
    if (session.statusMessageId === msgId) {
      session.statusMessageId = undefined;
    }
    resetSessionState(session);
  });
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

    const content = renderStatusContent(
      session.toolHistory,
      isFinal,
      maxStatusMessageLength,
    );

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
        await deleteStatusMessageWithRecovery(
          session,
          createdId,
          "late_status_create",
          getToken,
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
