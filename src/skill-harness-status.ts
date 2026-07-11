import { STATUS_MAX_ENTRIES } from "./constants.js";
import type { AgentPipelineEvent, ToolEntry } from "./types.js";

const SKILL_HARNESS_EVENT_STREAM = "plugin:skill-harness";
const SKILL_HARNESS_EVENT_KIND = "skill-harness.pipeline";
// Keep public Discord status from accidentally exposing raw prompt/context data.
const SKILL_HARNESS_PARAM_KEYS = new Set([
  "intent",
  "domain",
  "keywords",
  "complexity",
  "topic",
  "changed",
  "reason",
  "confidence",
  "result",
]);

export function getSkillHarnessPipelineSessionKey(
  event: AgentPipelineEvent,
): string | undefined {
  return (
    event.sessionKey ??
    (typeof event.data.sessionKey === "string"
      ? event.data.sessionKey
      : undefined)
  );
}

function mapPipelineState(value: unknown): ToolEntry["status"] | undefined {
  if (value === "started") return "pending";
  if (value === "completed" || value === "skipped") return "completed";
  if (value === "failed") return "error";
  return undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function parseSkillHarnessPipelineEntry(
  event: AgentPipelineEvent,
): ToolEntry | undefined {
  if (event.stream !== SKILL_HARNESS_EVENT_STREAM) return;
  const data = event.data;
  if (data.kind !== SKILL_HARNESS_EVENT_KIND) return;
  if (typeof data.phase !== "string" || !data.phase.trim()) return;

  const status = mapPipelineState(data.state);
  if (!status) return;

  const params = Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) =>
        SKILL_HARNESS_PARAM_KEYS.has(key) && value !== undefined,
    ),
  );
  const error =
    status === "error"
      ? (getNonEmptyString(data.error) ??
        getNonEmptyString(data.reason) ??
        getNonEmptyString(data.result))
      : undefined;
  if (status === "error") {
    delete params.reason;
    delete params.result;
    if (error) params.error = error;
    else delete params.error;
  }

  return {
    toolCallId: `skill-harness:${event.runId}:${data.phase}`,
    toolName: `skill-harness:${data.phase}`,
    params,
    status,
    error,
  };
}

function applySkillHarnessTiming(
  entry: ToolEntry,
  existingEntry: ToolEntry | undefined,
  observedAtMs: number,
): ToolEntry {
  const startedAtMs = existingEntry?.startedAtMs ?? observedAtMs;
  const isFinished = entry.status === "completed" || entry.status === "error";
  const durationMs = isFinished
    ? (existingEntry?.durationMs ??
      (existingEntry?.status !== "pending" ||
      existingEntry.startedAtMs === undefined
        ? undefined
        : Math.max(0, observedAtMs - startedAtMs)))
    : existingEntry?.durationMs;

  return {
    ...entry,
    startedAtMs,
    durationMs,
  };
}

function isSameSkillHarnessEntry(
  existingEntry: ToolEntry | undefined,
  nextEntry: ToolEntry,
): boolean {
  return Boolean(
    existingEntry &&
    existingEntry.status === nextEntry.status &&
    existingEntry.error === nextEntry.error &&
    existingEntry.durationMs === nextEntry.durationMs &&
    JSON.stringify(existingEntry.params ?? {}) ===
      JSON.stringify(nextEntry.params ?? {}),
  );
}

export function mergeSkillHarnessPipelineEntry(
  existingChildEntries: ToolEntry[],
  entry: ToolEntry,
  observedAtMs: number,
): { changed: boolean; entries: ToolEntry[] } {
  const existingEntry = existingChildEntries.find(
    (tool) => tool.toolCallId === entry.toolCallId,
  );
  const timedEntry = applySkillHarnessTiming(
    entry,
    existingEntry,
    observedAtMs,
  );
  const nextEntry =
    existingEntry?.status === "completed" && timedEntry.status === "pending"
      ? existingEntry
      : timedEntry;

  if (isSameSkillHarnessEntry(existingEntry, nextEntry)) {
    return { changed: false, entries: existingChildEntries };
  }

  return {
    changed: true,
    entries: [
      ...existingChildEntries.filter(
        (tool) => tool.toolCallId !== entry.toolCallId,
      ),
      nextEntry,
    ].slice(-STATUS_MAX_ENTRIES),
  };
}
