import { logger } from "../api.js";
import type { GetTokenFn, SessionEntry } from "./types.js";
import {
  sendMessage as sendDiscordMessage,
  editMessage as editDiscordMessage,
  deleteMessage as deleteDiscordMessage,
  resolveDmChannel as resolveDmChannelApi,
} from "./discord-api.js";
import { extractUserIdFromDirectSessionKey } from "./parser.js";

export async function editDiscordStatusMessage(
  getToken: GetTokenFn,
  channelId: string,
  messageId: string,
  content: string,
  accountId?: string,
): Promise<boolean> {
  const token = getToken(accountId);
  if (!token) {
    logger.warn("editDiscordStatusMessage: no token available", {
      channelId,
      messageId,
    });
    return false;
  }

  await editDiscordMessage(channelId, messageId, content, token);
  return true;
}

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

export async function sendDiscordStatusWithDmFallback(
  getToken: GetTokenFn,
  session: SessionEntry,
  content: string,
  replyToId?: string,
): Promise<string | undefined> {
  const token = getToken(session.accountId);
  if (!token) {
    logger.warn("sendDiscordStatusWithDmFallback: no token available", {
      contextKey: session.contextKey,
      channelId: session.channelId,
    });
    return undefined;
  }

  // Preemptively resolve DM channel for direct-message sessions
  const userId = extractUserIdFromDirectSessionKey(session.ownerSessionKey);
  if (userId && userId === session.channelId) {
    const dmChannelId = await resolveDmChannelApi(userId, token);
    if (dmChannelId) {
      session.channelId = dmChannelId;
      return await sendDiscordMessage(dmChannelId, content, token, replyToId);
    }
    logger.warn("failed to resolve DM channel before sending status message.", {
      userId,
      contextKey: session.contextKey,
      ownerSessionKey: session.ownerSessionKey,
    });
    return undefined;
  }

  return await sendDiscordMessage(session.channelId, content, token, replyToId);
}
