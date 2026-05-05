import { createSubsystemLogger } from "../api.js";
import type { ChannelMeta, SessionEntry } from "./types.js";
import {
  deleteMessage,
  sendMessage,
  editMessage,
  sleep,
  resolveDmChannel,
} from "./discord-api.js";
import { extractUserIdFromDirectSessionKey } from "./parser.js";
import { SESSION_RESOLVE_RETRY_MS } from "./constants.js";
import { getToolIcon, formatParams } from "./formatting.js";

const logger = createSubsystemLogger("plugins");

export const sessionContextMap = new Map<string, ChannelMeta>();
export const activeSessions = new Map<string, SessionEntry>();

export function isCurrentSession(session: SessionEntry): boolean {
  return activeSessions.get(session.contextKey) === session;
}

export function hasVisibleStatusState(session: SessionEntry): boolean {
  return session.toolHistory.some(
    (t) => t.toolCallId !== "init" && t.toolCallId !== "active-memory",
  );
}

export async function waitForPendingOp(
  session: SessionEntry,
  hookName: string,
) {
  if (!session.pendingOp) return;
  logger.debug(`discord-tool-status: [${hookName}] Waiting for pending op...`, {
    subsystem: "plugins",
  });
  try {
    await session.pendingOp;
  } catch (err) {
    logger.warn(`discord-tool-status: [${hookName}] Pending op failed.`, {
      subsystem: "plugins",
      error: String(err),
    });
  }
}

export function clearSessionState(
  contextKey: string,
  session?: SessionEntry,
  expectedGeneration?: number,
  expectedOwner?: string,
) {
  if (session) {
    const current = activeSessions.get(contextKey);
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
  activeSessions.delete(contextKey);
  sessionContextMap.delete(contextKey);
}

export function getOrCreateSession(
  contextKey: string,
  requestSessionKey?: string,
): SessionEntry | undefined {
  const normalizedRequestSessionKey =
    typeof requestSessionKey === "string" && requestSessionKey.trim().length > 0
      ? requestSessionKey
      : undefined;

  const context = sessionContextMap.get(contextKey);
  const preferredOwner = context?.sourceSessionKey;
  const existing = activeSessions.get(contextKey);
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
  activeSessions.set(contextKey, created);
  return created;
}

export async function resolveSession(
  contextKey: string,
  requestSessionKey?: string,
): Promise<SessionEntry | undefined> {
  const immediate = getOrCreateSession(contextKey, requestSessionKey);
  if (immediate) return immediate;

  await sleep(SESSION_RESOLVE_RETRY_MS);
  return getOrCreateSession(contextKey, requestSessionKey);
}

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
      const contentParts: string[] = [];
      let i = 0;
      while (i < session.toolHistory.length) {
        const t = session.toolHistory[i];
        if (
          t.toolName === "active-memory" ||
          t.toolName.startsWith("active-memory:")
        ) {
          const group: typeof session.toolHistory = [];
          while (
            i < session.toolHistory.length &&
            (session.toolHistory[i].toolName === "active-memory" ||
              session.toolHistory[i].toolName.startsWith("active-memory:"))
          ) {
            group.push(session.toolHistory[i]);
            i++;
          }

          const realEntries = group.filter((e) =>
            e.toolName.startsWith("active-memory:"),
          );
          const subEntryStrs = realEntries.map((entry) => {
            const strippedName = entry.toolName.replace(/^active-memory:/, "");
            let subSuffix: string;
            if (entry.status === "error") {
              subSuffix = "✘";
            } else if (entry.status === "orphan-completed") {
              subSuffix = "♻︎";
            } else if (entry.status === "completed") {
              subSuffix = "✔";
            } else {
              subSuffix = "←";
            }
            const dur =
              typeof entry.durationMs === "number"
                ? ` (${entry.durationMs.toLocaleString()}ms)`
                : "";
            const pStr = formatParams(entry.params, {
              first: "     - ",
              rest: "       ",
            });
            return `   - ${strippedName}: ${subSuffix}${dur}${pStr ? "\n" + pStr : ""}`;
          });

          contentParts.push(
            `🧠 active-memory: ♻︎${subEntryStrs.length ? "\n" + subEntryStrs.join("\n") : ""}`,
          );
        } else {
          // Non-active-memory entry — exact same rendering as before
          const icon = getToolIcon(t.toolName);
          const pStr = formatParams(t.params);
          const isLast = i === session.toolHistory.length - 1;
          const done =
            t.status === "completed" ||
            t.status === "error" ||
            t.status === "orphan-completed";
          let suffix: string;
          if (t.status === "error") {
            suffix = "✘";
          } else if (t.status === "orphan-completed") {
            suffix = "♻︎";
          } else if (done && (!isLast || isFinal)) {
            suffix = "✔";
          } else {
            suffix = "←";
          }
          const dur =
            typeof t.durationMs === "number"
              ? ` (${t.durationMs.toLocaleString()}ms)`
              : "";
          contentParts.push(
            `${icon} ${t.toolName}: ${suffix}${dur}${pStr ? "\n" + pStr : ""}`,
          );
          i++;
        }
      }

      content = "```yaml\n" + contentParts.join("\n\n") + "\n```";
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
