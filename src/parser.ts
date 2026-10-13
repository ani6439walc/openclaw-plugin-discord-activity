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

export function isSkillHarnessSessionKey(
  sessionKey: string | undefined,
): boolean {
  return (
    typeof sessionKey === "string" && sessionKey.includes(":skill-harness:")
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
