import type { MessageContext, MessageReceivedEvent } from "./types.js";

export function isDiscordContext(ctx: MessageContext): boolean {
  if (ctx.trigger && ctx.trigger !== "user") return false;
  return (
    ctx.channelId === "discord" ||
    ctx.messageProvider === "discord" ||
    /^\d{17,20}$/.test(String(ctx.channelId))
  );
}

export function isInternalSessionKey(sessionKey: string | undefined): boolean {
  return (
    sessionKey?.includes(":active-memory:") === true ||
    isSkillHarnessReviewSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey)
  );
}

export function resolveInboundChannelId(
  event: MessageReceivedEvent,
  ctx: MessageContext,
): string | undefined {
  const metadataTo = event.metadata?.to;
  return (
    extractIdFromMetadata(
      typeof metadataTo === "string" ? metadataTo : undefined,
    ) ||
    extractIdFromMetadata(ctx.conversationId) ||
    (/^\d{17,20}$/.test(String(ctx.channelId))
      ? String(ctx.channelId)
      : undefined)
  );
}

export function getDiscordContextKey(
  sessionKey: string | undefined,
): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(
    /discord:(?:channel|direct|group|dm|chat):[^:]+/i,
  );
  return match ? match[0].toLowerCase() : undefined;
}

export function isSubagentSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":subagent:");
}

export function isSkillHarnessReviewSessionKey(
  sessionKey: string | undefined,
): boolean {
  return (
    typeof sessionKey === "string" &&
    sessionKey.includes(":skill-harness-review:")
  );
}

export function extractIdFromMetadata(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:channel|user|direct|group|dm|chat):(\d+)/i);
  return match?.[1] || undefined;
}

export function extractSenderId(metadata: any): string | undefined {
  return String(metadata?.senderId ?? "").trim() || undefined;
}

export function extractUserIdFromDirectSessionKey(
  sessionKey: string | undefined,
): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(/discord:direct:(\d+)/i);
  return match?.[1];
}

export function isCanonicalDirectSessionKey(
  sessionKey: string | undefined,
): boolean {
  return (
    typeof sessionKey === "string" &&
    /(?:^|:)discord:direct:\d+(?![\s\S])/i.test(sessionKey)
  );
}
