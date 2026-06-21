import { logger } from "../api.js";
import type { SessionEntry } from "./types.js";
import {
  sendMessage as sendDiscordMessage,
  editMessage as editDiscordMessage,
  deleteMessage as deleteDiscordMessage,
  resolveDmChannel as resolveDmChannelApi,
} from "./discord-api.js";

/**
 * DiscordMessageClient provides a clean interface for all Discord message operations.
 * It encapsulates the API interactions, retry logic, and DM channel resolution
 * while keeping session state management separate.
 */
export class DiscordMessageClient {
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
      logger.warn("DiscordMessageClient.send: no token available", { channelId });
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
  ): Promise<void> {
    const token = this.tokenResolver(accountId);
    if (!token) {
      logger.warn("DiscordMessageClient.edit: no token available", { channelId, messageId });
      return;
    }

    await editDiscordMessage(channelId, messageId, content, token);
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
      logger.warn("DiscordMessageClient.delete: no token available", { channelId, messageId });
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
      logger.warn("DiscordMessageClient.sendWithDmFallback: no token available", {
        contextKey: session.contextKey,
        channelId: session.channelId,
      });
      return undefined;
    }

    // Preemptively resolve DM channel for direct-message sessions
    const userId = this.extractUserIdFromDirectSessionKey(session.ownerSessionKey);
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

  /**
   * Updates a status message for a session
   */
  async updateStatusMessage(
    session: SessionEntry,
    content: string,
    isFinal = false
  ): Promise<void> {
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
      const createdId = await this.sendWithDmFallback(
        session,
        content,
        session.userMessageId,
      );

      if (!createdId) {
        return;
      }

      session.statusMessageId = createdId;
      logger.debug(`created status message ${session.statusMessageId}.`);
      session.lastRenderedContent = content;
      return;
    }

    if (!session.statusMessageId) {
      return;
    }

    if (session.lastRenderedContent === content) {
      logger.debug("skipped status message edit because content is unchanged.");
      return;
    }

    await this.edit(
      session.channelId,
      session.statusMessageId,
      content,
      session.accountId,
    );
    session.lastRenderedContent = content;
    logger.debug("updated status message.");
  }

  /**
   * Deletes a status message for a session
   */
  async deleteStatusMessage(
    session: SessionEntry
  ): Promise<boolean> {
    if (!session.statusMessageId) {
      return true; // Already deleted
    }

    const result = await this.delete(
      session.channelId,
      session.statusMessageId,
      session.accountId
    );

    if (result) {
      session.statusMessageId = undefined;
    }

    return result;
  }

  private extractUserIdFromDirectSessionKey(sessionKey: string): string | undefined {
    // Extract user ID from session keys that look like 'discord:user:{userId}' or 'discord:{userId}'
    const match = sessionKey.match(/^discord:(?:user:)?(\d{17,20})$/);
    return match ? match[1] : undefined;
  }
}