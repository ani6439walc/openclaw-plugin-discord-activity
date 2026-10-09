import type { AgentPipelineEvent, ToolEntry } from "./types.js";

export const HINDSIGHT_EVENT_STREAM = "plugin:hindsight";
export const HINDSIGHT_RECALL_STREAM = HINDSIGHT_EVENT_STREAM;
export const HINDSIGHT_TOOL = "hindsight";
export const HINDSIGHT_RECALL_TOOL = HINDSIGHT_TOOL;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Only project fixed labels and validated counts; never render producer text,
// queries, bank identifiers, memories, or exception messages in Discord.
export function parseHindsightRecallEvent(
  event: AgentPipelineEvent,
): { sessionKey: string; entry: ToolEntry } | undefined {
  if (event.stream !== HINDSIGHT_EVENT_STREAM || !nonEmptyString(event.runId))
    return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.kind !== "hindsight.recall")
    return;
  if (data.pluginId !== undefined && data.pluginId !== "hindsight") return;
  if (
    typeof data.recallId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(data.recallId)
  )
    return;
  const sessionKey = event.sessionKey ?? data.sessionKey;
  if (!nonEmptyString(sessionKey)) return;
  if (data.sessionKey !== undefined && data.sessionKey !== sessionKey) return;

  const entry: ToolEntry = {
    toolCallId: `hindsight:${event.runId}:${data.recallId}`,
    toolName: HINDSIGHT_TOOL,
    params: {},
    status: "pending",
  };
  if (data.state === "started") {
    entry.params = { status: "recalling memories" };
    return { sessionKey, entry };
  }
  if (
    typeof data.durationMs !== "number" ||
    !Number.isFinite(data.durationMs) ||
    data.durationMs < 0
  )
    return;
  entry.durationMs = data.durationMs;

  switch (data.state) {
    case "completed":
      if (
        typeof data.resultCount !== "number" ||
        !Number.isSafeInteger(data.resultCount) ||
        data.resultCount < 0
      )
        return;
      entry.status = "completed";
      entry.params = {
        result:
          data.resultCount === 0
            ? "no relevant memories"
            : `${data.resultCount} ${data.resultCount === 1 ? "memory" : "memories"} recalled`,
      };
      break;
    case "failed":
      entry.status = "error";
      entry.error =
        data.reason === "timeout" ? "recall timed out" : "recall failed";
      break;
    case "cancelled":
      entry.status = "error";
      entry.error = "recall cancelled";
      break;
    case "skipped":
      entry.status = "completed";
      entry.params = { result: "recall skipped: client unavailable" };
      break;
    default:
      return;
  }
  return { sessionKey, entry };
}

export function finishPendingHindsightRecalls(history: ToolEntry[]): void {
  for (const entry of history) {
    if (entry.toolName !== HINDSIGHT_TOOL || entry.status !== "pending")
      continue;
    entry.status = "error";
    entry.params = {};
    entry.error = "recall outcome unavailable";
  }
}
