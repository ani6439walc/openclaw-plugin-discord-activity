import { logger } from "../api.js";
import type { SessionEntry } from "./types.js";
import {
  deleteDiscordStatusMessageWithResult,
  editDiscordStatusMessageWithResult,
  sendDiscordStatusWithDmFallbackWithResult,
} from "./discord-message-operations.js";
import { createMessageNonce } from "./discord-api.js";
import { createSessionStore } from "./store.js";
import { createOrphanManager } from "./orphans.js";
import {
  mergeStatusDisplayStates,
  renderStatusContentWithState,
} from "./render.js";
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
  session.statusCreateNonce = undefined;
  session.lastRenderedContent = undefined;
  session.contentDeliveryUncertain = undefined;
  session.confirmedDisplayState = undefined;
  session.monotonicSafetyFloor = undefined;
  session.finalized = false;
}

function getSessionDisplayFloor(session: SessionEntry) {
  return mergeStatusDisplayStates(
    session.confirmedDisplayState,
    session.monotonicSafetyFloor,
  );
}

function commitDisplayState(
  session: SessionEntry,
  displayState: ReturnType<typeof getSessionDisplayFloor>,
  outcome: "applied" | "uncertain",
) {
  if (outcome === "applied") {
    session.confirmedDisplayState = mergeStatusDisplayStates(
      session.confirmedDisplayState,
      displayState,
    );
    return;
  }

  session.monotonicSafetyFloor = mergeStatusDisplayStates(
    session.monotonicSafetyFloor,
    displayState,
  );
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
      `status message was idle for maxDisplayMs (${maxDisplayMs}ms), forcing cleanup.`,
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
  const expectedGeneration = session.generation;
  const expectedOwner = session.ownerSessionKey;
  const isExpectedCurrentSession = () =>
    defaultStore.isCurrentSession(session) &&
    session.generation === expectedGeneration &&
    session.ownerSessionKey === expectedOwner;

  if (
    session.statusMessageId &&
    maxDisplayMs &&
    maxDisplayMs > 0 &&
    isExpectedCurrentSession()
  ) {
    startMaxDisplayTimer(session, session.contextKey, maxDisplayMs, getToken);
  }

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

    if (!isExpectedCurrentSession()) return;

    const { content, displayState } = renderStatusContentWithState(
      session.toolHistory,
      isFinal,
      maxStatusMessageLength,
      getSessionDisplayFloor(session),
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
      const isRetryingUncertainCreate = session.statusCreateNonce !== undefined;
      const createNonce = session.statusCreateNonce ?? createMessageNonce();
      const result = await sendDiscordStatusWithDmFallbackWithResult(
        getToken,
        session,
        content,
        session.userMessageId,
        createNonce,
      );

      if (!isExpectedCurrentSession()) {
        if (result.outcome === "applied" && result.messageId) {
          await deleteStatusMessageWithRecovery(
            session,
            result.messageId,
            "late_status_create",
            getToken,
          );
        }
        return;
      }

      if (result.outcome === "uncertain") {
        session.statusCreateNonce = createNonce;
        session.contentDeliveryUncertain = true;
        commitDisplayState(session, displayState, "uncertain");
        return;
      }

      if (result.outcome !== "applied" || !result.messageId) {
        return;
      }

      session.statusCreateNonce = undefined;
      session.statusMessageId = result.messageId;
      session.contentDeliveryUncertain = isRetryingUncertainCreate;
      logger.debug(`created status message ${session.statusMessageId}.`);

      if (maxDisplayMs && maxDisplayMs > 0) {
        startMaxDisplayTimer(
          session,
          session.contextKey,
          maxDisplayMs,
          getToken,
        );
      }

      if (isRetryingUncertainCreate) {
        const reconcileResult = await editDiscordStatusMessageWithResult(
          getToken,
          session.channelId,
          session.statusMessageId,
          content,
          session.accountId,
        );
        if (
          !isExpectedCurrentSession() ||
          session.statusMessageId !== result.messageId
        ) {
          return;
        }
        if (reconcileResult.outcome === "applied") {
          session.lastRenderedContent = content;
          session.contentDeliveryUncertain = false;
          commitDisplayState(session, displayState, "applied");
          logger.debug("reconciled status message after uncertain create.");
        } else if (reconcileResult.outcome === "uncertain") {
          session.contentDeliveryUncertain = true;
          commitDisplayState(session, displayState, "uncertain");
        }
        return;
      }

      session.lastRenderedContent = content;
      session.contentDeliveryUncertain = false;
      commitDisplayState(session, displayState, "applied");
      return;
    }

    if (!session.statusMessageId) {
      return;
    }

    if (
      session.lastRenderedContent === content &&
      !session.contentDeliveryUncertain
    ) {
      commitDisplayState(session, displayState, "applied");
      logger.debug("skipped status message edit because content is unchanged.");
      return;
    }

    const messageId = session.statusMessageId;
    const result = await editDiscordStatusMessageWithResult(
      getToken,
      session.channelId,
      messageId,
      content,
      session.accountId,
    );

    if (!isExpectedCurrentSession() || session.statusMessageId !== messageId) {
      return;
    }

    if (result.outcome === "applied") {
      session.lastRenderedContent = content;
      session.contentDeliveryUncertain = false;
      commitDisplayState(session, displayState, "applied");
      logger.debug("updated status message.");
    } else if (result.outcome === "uncertain") {
      session.contentDeliveryUncertain = true;
      commitDisplayState(session, displayState, "uncertain");
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
