import { logger } from "../api.js";
import type { GetTokenFn, SessionEntry } from "./types.js";
import {
  sendMessageWithResult as sendDiscordMessageWithResult,
  editMessageWithResult as editDiscordMessageWithResult,
  deleteMessage as deleteDiscordMessage,
  deleteMessageWithResult as deleteDiscordMessageWithResult,
  resolveDmChannel as resolveDmChannelApi,
} from "./discord-api.js";
import type {
  DeleteMessageResult,
  DiscordMutationResult,
  SendMessageResult,
} from "./discord-api.js";
import { extractUserIdFromDirectSessionKey } from "./parser.js";

export async function editDiscordStatusMessageWithResult(
  getToken: GetTokenFn,
  channelId: string,
  messageId: string,
  content: string,
  accountId?: string,
): Promise<DiscordMutationResult> {
  let token: string;
  try {
    token = getToken(accountId);
  } catch (error) {
    logger.warn("Unable to resolve Discord token; skipping status edit.", {
      error: String(error),
    });
    return {
      outcome: "rejected",
      reason: "token-resolution-error",
    };
  }
  if (!token) {
    logger.warn("editDiscordStatusMessage: no token available", {
      channelId,
      messageId,
    });
    return {
      outcome: "rejected",
      reason: "missing-token",
    };
  }

  return await editDiscordMessageWithResult(
    channelId,
    messageId,
    content,
    token,
  );
}

export async function editDiscordStatusMessage(
  getToken: GetTokenFn,
  channelId: string,
  messageId: string,
  content: string,
  accountId?: string,
): Promise<boolean> {
  return (
    (
      await editDiscordStatusMessageWithResult(
        getToken,
        channelId,
        messageId,
        content,
        accountId,
      )
    ).outcome === "applied"
  );
}

/**
 * @deprecated Compatibility wrapper; use deleteDiscordStatusMessageWithResult
 * for internal failure classification.
 */
export async function deleteDiscordStatusMessage(
  getToken: GetTokenFn,
  channelId: string,
  messageId: string,
  accountId?: string,
): Promise<boolean> {
  const token = getToken(accountId);
  if (!token) {
    logger.warn("deleteDiscordStatusMessage: no token available", {
      channelId,
      messageId,
    });
    return false;
  }

  return await deleteDiscordMessage(channelId, messageId, token);
}

export async function deleteDiscordStatusMessageWithResult(
  getToken: GetTokenFn,
  channelId: string,
  messageId: string,
  accountId?: string,
): Promise<DeleteMessageResult> {
  let token: string;
  try {
    token = getToken(accountId);
  } catch (error) {
    logger.warn("Unable to resolve Discord token; skipping status delete.", {
      error: String(error),
    });
    return {
      deleted: false,
      retryable: false,
      reason: "token-resolution-error",
    };
  }
  if (!token) {
    logger.warn("deleteDiscordStatusMessage: no token available", {
      channelId,
      messageId,
    });
    return {
      deleted: false,
      retryable: false,
      reason: "missing-token",
    };
  }

  return await deleteDiscordMessageWithResult(channelId, messageId, token);
}

export async function sendDiscordStatusWithDmFallbackWithResult(
  getToken: GetTokenFn,
  session: SessionEntry,
  content: string,
  replyToId?: string,
  nonce?: string,
): Promise<SendMessageResult> {
  let token: string;
  try {
    token = getToken(session.accountId);
  } catch (error) {
    logger.warn("Unable to resolve Discord token; skipping status send.", {
      error: String(error),
    });
    return {
      outcome: "rejected",
      reason: "token-resolution-error",
    };
  }
  if (!token) {
    logger.warn("sendDiscordStatusWithDmFallback: no token available", {
      contextKey: session.contextKey,
      channelId: session.channelId,
    });
    return {
      outcome: "rejected",
      reason: "missing-token",
    };
  }

  // Preemptively resolve DM channel for direct-message sessions
  const userId = extractUserIdFromDirectSessionKey(session.ownerSessionKey);
  if (userId && userId === session.channelId) {
    let dmChannelId: string | undefined;
    try {
      dmChannelId = await resolveDmChannelApi(userId, token);
    } catch (error) {
      logger.warn(
        "failed to resolve DM channel before sending status message.",
        {
          userId,
          contextKey: session.contextKey,
          ownerSessionKey: session.ownerSessionKey,
          error: String(error),
        },
      );
      return {
        outcome: "rejected",
        reason: "dm-resolution-error",
      };
    }
    if (dmChannelId) {
      session.channelId = dmChannelId;
      return await sendDiscordMessageWithResult(
        dmChannelId,
        content,
        token,
        replyToId,
        nonce,
      );
    }
    logger.warn("failed to resolve DM channel before sending status message.", {
      userId,
      contextKey: session.contextKey,
      ownerSessionKey: session.ownerSessionKey,
    });
    return {
      outcome: "rejected",
      reason: "dm-resolution-failed",
    };
  }

  return await sendDiscordMessageWithResult(
    session.channelId,
    content,
    token,
    replyToId,
    nonce,
  );
}

export async function sendDiscordStatusWithDmFallback(
  getToken: GetTokenFn,
  session: SessionEntry,
  content: string,
  replyToId?: string,
): Promise<string | undefined> {
  return (
    await sendDiscordStatusWithDmFallbackWithResult(
      getToken,
      session,
      content,
      replyToId,
    )
  ).messageId;
}
