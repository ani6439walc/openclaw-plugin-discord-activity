import { logger } from "../api.js";
import { MAX_RETRIES, RETRY_FALLBACK_MS } from "./constants.js";

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const dmChannelCache = new Map<string, string>();

export async function resolveDmChannel(
  userId: string,
  token: string,
): Promise<string | undefined> {
  const cached = dmChannelCache.get(userId);
  if (cached) return cached;

  const res = await discordApiRequest(
    `https://discord.com/api/v10/users/@me/channels`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: userId }),
    },
    "resolveDmChannel",
  );

  const data = (await res.json().catch(() => ({}))) as any;
  if (res.ok && data.id) {
    dmChannelCache.set(userId, data.id);
    return data.id;
  }
  return undefined;
}

export async function getRetryDelayMs(res: Response): Promise<number> {
  const headerVal = Number(res.headers.get("retry-after"));
  if (Number.isFinite(headerVal) && headerVal > 0) {
    return Math.ceil(headerVal * 1000);
  }

  try {
    const body = (await res.clone().json()) as { retry_after?: unknown };
    const bodyVal = Number(body.retry_after);
    if (Number.isFinite(bodyVal) && bodyVal > 0) {
      return Math.ceil(bodyVal * 1000);
    }
  } catch {
    /* intentionally empty: fall through to default delay */
  }

  return RETRY_FALLBACK_MS;
}

export async function discordApiRequest(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, init);

      if (res.ok) {
        return res;
      }

      if (res.status === 429) {
        const delayMs = await getRetryDelayMs(res);
        logger.warn(`${operation} hit rate limit.`, {
          status: res.status,
          retryInMs: delayMs,
          attempt,
        });
        if (attempt === MAX_RETRIES) {
          return res;
        }
        await sleep(delayMs);
        continue;
      }

      if (res.status >= 500) {
        if (attempt === MAX_RETRIES) {
          return res;
        }
        const backoffMs = RETRY_FALLBACK_MS * Math.pow(2, attempt);
        logger.warn(`${operation} server error, retrying.`, {
          status: res.status,
          retryInMs: backoffMs,
          attempt,
        });
        await sleep(backoffMs);
        continue;
      }

      return res;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        throw err;
      }
      const backoffMs = RETRY_FALLBACK_MS * Math.pow(2, attempt);
      logger.warn(`${operation} network error, retrying.`, {
        error: String(err),
        retryInMs: backoffMs,
        attempt,
      });
      await sleep(backoffMs);
    }
  }

  throw new Error("unexpected retry loop exit");
}

export type DiscordMutationResult = {
  outcome: "applied" | "rejected" | "uncertain";
  reason: string;
  status?: number;
};

export type SendMessageResult = DiscordMutationResult & {
  messageId?: string;
};

export function createMessageNonce(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 25);
}

export async function sendMessageWithResult(
  channelId: string,
  content: string,
  token: string,
  replyToId?: string,
  nonce = createMessageNonce(),
): Promise<SendMessageResult> {
  try {
    const body: Record<string, unknown> = {
      content,
      nonce,
      enforce_nonce: true,
    };
    if (replyToId) body.message_reference = { message_id: replyToId };
    const res = await discordApiRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "sendMessage",
    );
    const data = (await res.json().catch(() => ({}))) as { id?: unknown };
    if (!res.ok) {
      logger.warn("sendMessage failed.", {
        status: res.status,
        error: data,
      });
      return {
        outcome: res.status >= 500 ? "uncertain" : "rejected",
        status: res.status,
        reason: `http-${res.status}`,
      };
    }
    if (typeof data.id !== "string" || !data.id.trim()) {
      logger.warn("sendMessage succeeded without a usable message id.", {
        status: res.status,
      });
      return {
        outcome: "uncertain",
        status: res.status,
        reason: "missing-message-id",
      };
    }
    return {
      outcome: "applied",
      messageId: data.id,
      status: res.status,
      reason: "created",
    };
  } catch (err) {
    logger.warn("sendMessage error.", {
      error: String(err),
    });
    return {
      outcome: "uncertain",
      reason: "network-error",
    };
  }
}

export async function sendMessage(
  channelId: string,
  content: string,
  token: string,
  replyToId?: string,
): Promise<string | undefined> {
  return (await sendMessageWithResult(channelId, content, token, replyToId))
    .messageId;
}

export async function editMessageWithResult(
  channelId: string,
  messageId: string,
  content: string,
  token: string,
): Promise<DiscordMutationResult> {
  try {
    const res = await discordApiRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      },
      "editMessage",
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as any;
      logger.warn("editMessage failed.", {
        status: res.status,
        error: data,
      });
      return {
        outcome: res.status >= 500 ? "uncertain" : "rejected",
        status: res.status,
        reason: `http-${res.status}`,
      };
    }
    return {
      outcome: "applied",
      status: res.status,
      reason: "edited",
    };
  } catch (err) {
    logger.warn("editMessage error.", {
      error: String(err),
    });
    return {
      outcome: "uncertain",
      reason: "network-error",
    };
  }
}

export async function editMessage(
  channelId: string,
  messageId: string,
  content: string,
  token: string,
): Promise<boolean> {
  return (
    (await editMessageWithResult(channelId, messageId, content, token))
      .outcome === "applied"
  );
}

export type DeleteMessageResult = {
  deleted: boolean;
  retryable: boolean;
  status?: number;
  reason: string;
};

export async function deleteMessageWithResult(
  channelId: string,
  messageId: string,
  token: string,
): Promise<DeleteMessageResult> {
  try {
    const res = await discordApiRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bot ${token}` },
      },
      "deleteMessage",
    );
    if (res.ok || res.status === 404) {
      return {
        deleted: true,
        retryable: false,
        status: res.status,
        reason: res.ok ? "deleted" : "not-found",
      };
    }
    logger.warn("deleteMessage failed.", {
      status: res.status,
    });
    return {
      deleted: false,
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
      reason: `http-${res.status}`,
    };
  } catch (err) {
    logger.warn("deleteMessage error.", {
      error: String(err),
    });
    return {
      deleted: false,
      retryable: true,
      reason: "network-error",
    };
  }
}

/** @deprecated Compatibility wrapper; use deleteMessageWithResult internally. */
export async function deleteMessage(
  channelId: string,
  messageId: string,
  token: string,
): Promise<boolean> {
  return (await deleteMessageWithResult(channelId, messageId, token)).deleted;
}
