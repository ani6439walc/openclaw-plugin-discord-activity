import { createSubsystemLogger } from "../api.js";
import type { ChannelMeta, SessionEntry } from "./types.js";
import {
  deleteMessage,
  sendMessage,
  editMessage,
  resolveDmChannel,
} from "./discord-api.js";
import { extractUserIdFromDirectSessionKey } from "./parser.js";
import { createSessionStore, rawSessions, rawContexts } from "./store.js";
import { renderStatusContent } from "./render.js";

const logger = createSubsystemLogger("plugins");

const defaultStore = createSessionStore();

// Backward-compat re-exports during transition
export const activeSessions = rawSessions;
export const sessionContextMap = rawContexts;

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

  await waitForPendingOp(session, `${hookName}_retire_wait`);

  if (!session.statusMessageId) {
    session.toolHistory = [];
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

    clearStatusMessage(session, hookName, getToken)
      .catch((err) => {
        logger.warn(
          `discord-tool-status: Failed to clear status message on ${hookName}`,
          {
            subsystem: "plugins",
            contextKey,
            error: String(err),
          },
        );
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

  if (!session.statusMessageId) return;

  const token = getToken(session.accountId);
  if (token) {
    const msgId = session.statusMessageId;
    logger.debug(
      `discord-tool-status: [${hookName}] Deleting status message ${msgId}`,
      { subsystem: "plugins" },
    );
    const deleted = await deleteMessage(session.channelId, msgId, token);
    if (deleted) {
      session.statusMessageId = undefined;
    }
  }
  session.toolHistory = [];
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
    return undefined;
  }

  return sendMessage(session.channelId, content, token, replyToId);
}

export async function updateStatusMessage(
  session: SessionEntry,
  getToken: (accountId?: string) => string,
  isFinal = false,
) {
  const priorOp = session.pendingOp;
  const op = (async () => {
    if (priorOp) {
      logger.debug(
        "discord-tool-status: [update_status_message] Waiting for pending op...",
        {
          subsystem: "plugins",
        },
      );
      try {
        await priorOp;
      } catch (err) {
        logger.warn(
          "discord-tool-status: [update_status_message] Pending op failed.",
          {
            subsystem: "plugins",
            error: String(err),
          },
        );
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

    if (!session.statusMessageId) {
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
      logger.debug(
        `discord-tool-status: Created status message ${session.statusMessageId}`,
        {
          subsystem: "plugins",
        },
      );
      return;
    }

    if (!isCurrentSession(session)) {
      return;
    }

    await editMessage(
      session.channelId,
      session.statusMessageId,
      content,
      token,
    );
    logger.debug("discord-tool-status: Updated status message.", {
      subsystem: "plugins",
    });
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
