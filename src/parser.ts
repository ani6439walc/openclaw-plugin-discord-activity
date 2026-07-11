import type { ToolEntry, AgentEventMessage } from "./types.js";

function extractAssistantText(msg: AgentEventMessage): string | undefined {
  if (typeof msg.content === "string") {
    const text = msg.content.trim();
    return text || undefined;
  }

  if (!Array.isArray(msg.content)) {
    return undefined;
  }

  const text = msg.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || undefined;
}

function getRecordedDurationMs(msg: AgentEventMessage): number | undefined {
  if (typeof msg.durationMs === "number") {
    return msg.durationMs;
  }
  if (
    msg.details !== null &&
    typeof msg.details === "object" &&
    "durationMs" in msg.details &&
    typeof msg.details.durationMs === "number"
  ) {
    return msg.details.durationMs;
  }
  return undefined;
}

function getRecordedToolError(msg: AgentEventMessage): string | undefined {
  if (typeof msg.error === "string" && msg.error.trim()) {
    return msg.error.trim();
  }
  if (
    msg.details !== null &&
    typeof msg.details === "object" &&
    "error" in msg.details &&
    typeof msg.details.error === "string" &&
    msg.details.error.trim()
  ) {
    return msg.details.error.trim();
  }
  return msg.isError ? extractAssistantText(msg) : undefined;
}

function parseToolCallArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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

export function isActiveMemorySessionKey(
  sessionKey: string | undefined,
): boolean {
  return (
    typeof sessionKey === "string" && sessionKey.includes(":active-memory:")
  );
}

export function isSkillHarnessSessionKey(
  sessionKey: string | undefined,
): boolean {
  return (
    typeof sessionKey === "string" && sessionKey.includes(":skill-harness:")
  );
}

export function getActiveMemorySourceSessionKey(
  sessionKey: string | undefined,
): string | undefined {
  if (!isActiveMemorySessionKey(sessionKey)) {
    return undefined;
  }
  const idx = sessionKey!.indexOf(":active-memory:");
  if (idx <= 0) {
    return undefined;
  }
  const sourceSessionKey = sessionKey!.slice(0, idx);
  const subagentIdx = sourceSessionKey.indexOf(":subagent:");
  return subagentIdx > 0
    ? sourceSessionKey.slice(0, subagentIdx)
    : sourceSessionKey;
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

export function extractAgentIdFromSessionKey(
  sessionKey: string | undefined,
): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1];
  }
  return undefined;
}

export function parseActiveMemoryToolEntries(event: any): ToolEntry[] {
  const messages = (event?.messages ?? []) as AgentEventMessage[];
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const byToolCallId = new Map<string, ToolEntry>();
  const completion = new Map<
    string,
    { isError: boolean; error?: string; durationMs?: number }
  >();

  for (const msg of messages) {
    if (msg?.role === "assistant") {
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item?.type !== "toolCall") continue;
          if (!item.id || !item.name) continue;

          const prefixedId = `active-memory:${item.id}`;
          byToolCallId.set(prefixedId, {
            toolCallId: prefixedId,
            toolName: `active-memory:${item.name}`,
            params: parseToolCallArguments(item.arguments),
            status: "pending",
          });
        }
      }
      continue;
    }

    if (msg?.role === "toolResult" && msg.toolCallId) {
      const prefixedId = `active-memory:${msg.toolCallId}`;
      const error = getRecordedToolError(msg);
      const existing = completion.get(prefixedId);
      completion.set(prefixedId, {
        isError:
          existing?.isError === true ||
          msg.isError === true ||
          error !== undefined,
        error: existing?.error ?? error,
        durationMs: existing?.durationMs ?? getRecordedDurationMs(msg),
      });
      if (!byToolCallId.has(prefixedId)) {
        byToolCallId.set(prefixedId, {
          toolCallId: prefixedId,
          toolName: `active-memory:${msg.toolName || "unknown"}`,
          params: {},
          status: "pending",
        });
      }
    }
  }

  for (const [toolCallId, entry] of byToolCallId) {
    const recorded = completion.get(toolCallId);
    if (!recorded) continue;
    entry.status = recorded.isError ? "error" : "completed";
    entry.error = recorded.error;
    entry.durationMs = recorded.durationMs;
  }

  const entries = Array.from(byToolCallId.values());
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((msg) => msg?.role === "assistant");
  const finalAssistantText = lastAssistantMessage
    ? extractAssistantText(lastAssistantMessage)
    : undefined;

  if (finalAssistantText) {
    entries.push({
      toolCallId: "active-memory:result",
      toolName: "active-memory:result",
      params: { text: finalAssistantText },
      status: "completed",
    });
  }

  return entries;
}
