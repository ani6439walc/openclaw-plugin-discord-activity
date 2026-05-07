import { createSubsystemLogger } from "../api.js";
import type { ChannelMeta, SessionEntry } from "./types.js";
import {
  deleteMessage,
  sendMessage,
  editMessage,
  resolveDmChannel,
} from "./discord-api.js";
import { extractUserIdFromDirectSessionKey } from "./parser.js";
import { createSessionStore } from "./store.js";
import { createOrphanToolManager } from "./orphans.js";
import { renderStatusContent } from "./render.js";

const logger = createSubsystemLogger("plugins/discord-tool-status");

export const defaultStore = createSessionStore();
export const defaultOrphans = createOrphanToolManager();

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
  if (session.clearTimer) {
    clearTimeout(session.clearTimer);
    session.clearTimer = undefined;
  }
  if (session.maxDisplayTimer) {
    clearTimeout(session.maxDisplayTimer);
    session.maxDisplayTimer = undefined;
  }

  await waitForPendingOp(session, `${hookName}_retire_wait`);

  if (!session.statusMessageId) {
    session.toolHistory = [];
    session.finalized = false;
    return;
  }

  const token = getToken(session.accountId);
  if (!token) {
    session.toolHistory = [];
    return;
  }

  const staleMsgId = session.statusMessageId;
  const deleted = await deleteMessage(session.channelId, staleMsgId, token);
  if (deleted && session.statusMessageId === staleMsgId) {
    session.statusMessageId = undefined;
  }
  session.toolHistory = [];
  session.finalized = false;
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
        logger.warn(`Failed to clear status message on ${hookName}`, {
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
  await waitForPendingOp(session, hookName);

  if (session.maxDisplayTimer) {
    clearTimeout(session.maxDisplayTimer);
    session.maxDisplayTimer = undefined;
  }

  if (!session.statusMessageId) return;

  const token = getToken(session.accountId);
  if (token) {
    const msgId = session.statusMessageId;
    logger.debug(`[${hookName}] Deleting status message ${msgId}`);
    const deleted = await deleteMessage(session.channelId, msgId, token);
    if (deleted) {
      session.statusMessageId = undefined;
    }
  }
  session.toolHistory = [];
  session.finalized = false;
}

async function sendMessageWithDmFallback(
  session: SessionEntry,
  content: string,
  token: string,
  replyToId?: string,
): Promise<string | undefined> {
  // Preemptively resolve DM channel for direct-message sessions
  const userId = extractUserIdFromDirectSessionKey(session.ownerSessionKey);
  if (userId && userId === session.channelId) {
    const dmChannelId = await resolveDmChannel(userId, token);
    if (dmChannelId) {
      session.channelId = dmChannelId;
      return sendMessage(dmChannelId, content, token, replyToId);
    }
    logger.warn("failed to resolve DM channel before sending status message.", {
      userId,
      contextKey: session.contextKey,
      ownerSessionKey: session.ownerSessionKey,
    });
    return undefined;
  }

  return sendMessage(session.channelId, content, token, replyToId);
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
      `Status message exceeded maxDisplayMs (${maxDisplayMs}ms), forcing cleanup.`,
      { contextKey, maxDisplayMs },
    );

    clearStatusMessage(session, "max_display_timeout", getToken)
      .catch((err) => {
        logger.warn("Failed to clear status message on max_display_timeout", {
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
) {
  const priorOp = session.pendingOp;
  const op = (async () => {
    if (priorOp) {
      logger.debug("[update_status_message] Waiting for pending op...");
      try {
        await priorOp;
      } catch (err) {
        logger.warn("[update_status_message] Pending op failed.", {
          error: String(err),
        });
      }
    }

    let content = "";
    while (session.toolHistory.length > 0) {
      content = renderStatusContent(session.toolHistory, isFinal);
      if (content.length <= 1700 && session.toolHistory.length <= 6) break;
      session.toolHistory.shift();
    }

    if (!content) return;

    const token = getToken(session.accountId);
    if (!token) return;

    const isNewMessage = !session.statusMessageId;

    if (isNewMessage && session.finalized && !isFinal) {
      logger.debug(
        "[update_status_message] Skip non-final create for finalized session.",
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

      const createdId = await sendMessageWithDmFallback(
        session,
        content,
        token,
        session.userMessageId,
      );

      if (!createdId) {
        return;
      }

      if (!isCurrentSession(session)) {
        await deleteMessage(session.channelId, createdId, token);
        return;
      }

      session.statusMessageId = createdId;
      logger.debug(`Created status message ${session.statusMessageId}`);

      if (maxDisplayMs && maxDisplayMs > 0) {
        startMaxDisplayTimer(
          session,
          session.contextKey,
          maxDisplayMs,
          getToken,
        );
      }
      return;
    }

    if (!isCurrentSession(session)) {
      return;
    }

    if (!session.statusMessageId) {
      return;
    }

    await editMessage(
      session.channelId,
      session.statusMessageId,
      content,
      token,
    );
    logger.debug("Updated status message.");
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
