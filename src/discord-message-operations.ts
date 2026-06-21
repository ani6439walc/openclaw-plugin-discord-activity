import { logger } from "../api.js";
import type { SessionEntry } from "./types.js";
import {
  sendMessage as sendDiscordMessage,
  editMessage as editDiscordMessage,
  deleteMessage as deleteDiscordMessage,
  resolveDmChannel as resolveDmChannelApi,
} from "./discord-api.js";
import { extractUserIdFromDirectSessionKey } from "./parser.js";

/**
 * DiscordMessageOperations provides a clean interface for all Discord message operations.
 * It encapsulates the API interactions, retry logic, and DM channel resolution
 * while keeping session state management separate.
 */
export class DiscordMessageOperations {
  constructor(private tokenResolver: (accountId?: string) => string) {}

  /**
   * Sends a new message to the specified channel
   */
  async send(
    channelId: string,
    content: string,
    accountId?: string,
    replyToId?: string
  ): Promise<string | undefined> {
    const token = this.tokenResolver(accountId);
    if (!token) {
      logger.warn("DiscordMessageOperations.send: no token available", { channelId });
      return undefined;
    }

    return await sendDiscordMessage(channelId, content, token, replyToId);
  }

  /**
   * Edits an existing message
   */
  async edit(
    channelId: string,
    messageId: string,
    content: string,
    accountId?: string
  ): Promise<boolean> {
    const token = this.tokenResolver(accountId);
    if (!token) {
      logger.warn("DiscordMessageOperations.edit: no token available", { channelId, messageId });
      return false;
    }

    await editDiscordMessage(channelId, messageId, content, token);
    return true;
  }

  /**
   * Deletes a message
   */
  async delete(
    channelId: string,
    messageId: string,
    accountId?: string
  ): Promise<boolean> {
    const token = this.tokenResolver(accountId);
    if (!token) {
      logger.warn("DiscordMessageOperations.delete: no token available", { channelId, messageId });
      return false;
    }

    return await deleteDiscordMessage(channelId, messageId, token);
  }

  /**
   * Sends a message with DM fallback capability
   */
  async sendWithDmFallback(
    session: SessionEntry,
    content: string,
    replyToId?: string
  ): Promise<string | undefined> {
    const token = this.tokenResolver(session.accountId);
    if (!token) {
      logger.warn("DiscordMessageOperations.sendWithDmFallback: no token available", {
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
}