import { STATUS_MAX_ENTRIES } from "./constants.js";
import type { AgentPipelineEvent, ToolEntry } from "./types.js";

const SKILL_HARNESS_EVENT_STREAM = "plugin:skill-harness";
const SKILL_HARNESS_EVENT_KIND = "skill-harness.pipeline";
// Keep public Discord status from accidentally exposing raw prompt/context data.
const SKILL_HARNESS_PARAM_KEYS = new Set([
  "domain",
  "changed",
  "complexity",
  "keywords",
  "topic",
  "confidence",
  "intent",
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

  const phase = data.phase.trim();
  const durationMs =
    status !== "pending" &&
    typeof data.durationMs === "number" &&
    Number.isFinite(data.durationMs) &&
    data.durationMs >= 0
      ? data.durationMs
      : undefined;
  const isPipelineLifecycle = phase === "pipeline";

  return {
    toolCallId: isPipelineLifecycle
      ? "skill-harness"
      : `skill-harness:${event.runId}:${phase}`,
    toolName: isPipelineLifecycle ? "skill-harness" : `skill-harness:${phase}`,
    params,
    status,
    error,
    durationMs,
  };
}

function applySkillHarnessTiming(
  entry: ToolEntry,
  existingEntry: ToolEntry | undefined,
  observedAtMs: number,
): ToolEntry {
  const startedAtMs =
    existingEntry?.startedAtMs ??
    (entry.status === "pending" ? observedAtMs : undefined);
  const isFinished = entry.status === "completed" || entry.status === "error";
  const durationMs = isFinished
    ? (entry.durationMs ??
      existingEntry?.durationMs ??
      (existingEntry?.status !== "pending" ||
      existingEntry.startedAtMs === undefined
        ? undefined
        : Math.max(0, observedAtMs - existingEntry.startedAtMs)))
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
    existingEntry.startedAtMs === nextEntry.startedAtMs &&
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
    entries: boundSkillHarnessEntries([
      ...existingChildEntries.filter(
        (tool) => tool.toolCallId !== entry.toolCallId,
      ),
      nextEntry,
    ]),
  };
}

function boundSkillHarnessEntries(entries: ToolEntry[]): ToolEntry[] {
  const parent = entries.find((entry) => entry.toolName === "skill-harness");
  if (!parent) return entries.slice(-STATUS_MAX_ENTRIES);

  return [
    parent,
    ...entries
      .filter((entry) => entry !== parent)
      .slice(-(STATUS_MAX_ENTRIES - 1)),
  ];
}
