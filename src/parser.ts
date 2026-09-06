import type { ToolEntry, AgentEventMessage } from "./types.js";
import { sanitizeVisibleText } from "./ansi.js";

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

export type ActiveMemoryPromptContext =
  | { kind: "memory"; text: string }
  | { kind: "outcome"; outcome: "skipped" | "unavailable" };

const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";
const ACTIVE_MEMORY_SKIPPED_OUTCOME =
  "Active Memory intentionally skipped deep recall because this turn did not ask for past context.";
const ACTIVE_MEMORY_UNAVAILABLE_OUTCOME =
  "Active Memory could not retrieve memory for this turn. Do not assume that no relevant memory exists.";
const MAX_ACTIVE_MEMORY_PROMPT_LINES = 3;
const MAX_ACTIVE_MEMORY_PROMPT_LINE_CHARS = 220;
const MAX_ACTIVE_MEMORY_PROMPT_CHARS = 660;

function decodeActiveMemoryXmlEntities(value: string): string {
  return value.replaceAll(
    /&(amp|lt|gt|quot|apos);/gu,
    (entity, name: string) =>
      ({
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      })[name] ?? entity,
  );
}

function boundActiveMemoryPromptText(value: string): string {
  const lines = sanitizeVisibleText(decodeActiveMemoryXmlEntities(value))
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_ACTIVE_MEMORY_PROMPT_LINES)
    .map((line) =>
      [...line].slice(0, MAX_ACTIVE_MEMORY_PROMPT_LINE_CHARS).join(""),
    );
  return [...lines.join("\n")]
    .slice(0, MAX_ACTIVE_MEMORY_PROMPT_CHARS)
    .join("");
}

export function parseActiveMemoryPromptContext(
  prompt: unknown,
): ActiveMemoryPromptContext | undefined {
  if (typeof prompt !== "string") return undefined;
  const openIndex = prompt.indexOf(ACTIVE_MEMORY_OPEN_TAG);
  if (openIndex < 0) return undefined;
  const contentStart = openIndex + ACTIVE_MEMORY_OPEN_TAG.length;
  const closeIndex = prompt.indexOf(ACTIVE_MEMORY_CLOSE_TAG, contentStart);
  if (closeIndex < 0) return undefined;

  const text = boundActiveMemoryPromptText(
    prompt.slice(contentStart, closeIndex),
  );
  if (!text) return undefined;
  if (text === ACTIVE_MEMORY_SKIPPED_OUTCOME) {
    return { kind: "outcome", outcome: "skipped" };
  }
  if (text === ACTIVE_MEMORY_UNAVAILABLE_OUTCOME) {
    return { kind: "outcome", outcome: "unavailable" };
  }
  return { kind: "memory", text };
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

export function isCanonicalDirectSessionKey(
  sessionKey: string | undefined,
): boolean {
  return (
    typeof sessionKey === "string" &&
    /(?:^|:)discord:direct:\d+(?![\s\S])/i.test(sessionKey)
  );
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
