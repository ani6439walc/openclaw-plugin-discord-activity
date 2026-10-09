import type { AgentPipelineEvent, ToolEntry } from "./types.js";

export const SKILL_HARNESS_EVENT_STREAM = "plugin:skill-harness";
export const SKILL_HARNESS_EVENT_KIND = "skill-harness.pipeline";
export const SKILL_HARNESS_TOOL = "skill-harness";

export function getSkillHarnessPipelineSessionKey(
  event: AgentPipelineEvent,
): string | undefined {
  return (
    event.sessionKey ??
    (typeof event.data?.sessionKey === "string"
      ? event.data.sessionKey
      : undefined)
  );
}

function getNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatConfidence(confidence: unknown): string | undefined {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return undefined;
  }
  const rounded = Math.round(confidence * 100) / 100;
  return rounded.toFixed(2).replace(/^0\./, ".");
}

function extractSkillNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        names.push(item.trim());
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const name =
          typeof obj.name === "string"
            ? obj.name
            : typeof obj.skillName === "string"
              ? obj.skillName
              : typeof obj.id === "string"
                ? obj.id
                : undefined;
        if (name && name.trim()) {
          names.push(name.trim());
        }
      }
    }
    return names;
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function cleanClue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map((v) => cleanClue(v)).filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (typeof value === "string") {
    let trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    trimmed = trimmed
      .replace(/\s*·\s*rrf\s*:?\s*/gi, ", RRF: ")
      .replace(/,\s*rrf\s*:?\s*/gi, ", RRF: ")
      .replace(/\brrf\b/gi, "RRF");
    return trimmed || undefined;
  }
  return undefined;
}

function getCandidateCount(data: Record<string, unknown>): number {
  if (
    typeof data.candidateCount === "number" &&
    Number.isFinite(data.candidateCount)
  ) {
    return Math.max(0, Math.floor(data.candidateCount));
  }
  if (
    typeof data.nameCandidates === "number" &&
    Number.isFinite(data.nameCandidates)
  ) {
    return Math.max(0, Math.floor(data.nameCandidates));
  }
  if (Array.isArray(data.matches)) {
    return data.matches.length;
  }
  if (Array.isArray(data.result)) {
    return data.result.length;
  }
  if (typeof data.result === "string" && data.result.trim()) {
    return 1;
  }
  return 0;
}

function formatPhaseStatus(data: Record<string, unknown>): string {
  const phase = typeof data.phase === "string" ? data.phase.trim() : "";
  const confidenceStr = formatConfidence(data.confidence);
  const confBadge = confidenceStr ? ` (${confidenceStr})` : "";
  const count = getCandidateCount(data);

  if (phase === "name-match") {
    if (count === 0) {
      return "name-match · 0 matched";
    }
    const names = extractSkillNames(data.result ?? data.matches);
    const clue = names.length > 0 ? ` (${names.join(", ")})` : "";
    return `name-match · ${count} matched${confBadge}${clue}`;
  }

  if (phase === "search") {
    if (count === 0) {
      return "search · 0 candidates";
    }
    const unit = count === 1 ? "candidate" : "candidates";
    const clueStr = cleanClue(data.reason) ?? cleanClue(data.result);
    const clue = clueStr ? ` (${clueStr})` : "";
    return `search · ${count} ${unit}${confBadge}${clue}`;
  }

  if (phase === "experience-search") {
    if (count === 0) {
      return "experience · 0 candidates";
    }
    const unit = count === 1 ? "candidate" : "candidates";
    const clueStr = cleanClue(data.reason) ?? cleanClue(data.result);
    const clue = clueStr ? ` (${clueStr})` : "";
    return `experience · ${count} ${unit}${confBadge}${clue}`;
  }

  if (phase === "rerank") {
    if (count === 0) {
      return "rerank · 0 candidates";
    }
    const unit = count === 1 ? "candidate" : "candidates";
    const clueStr = cleanClue(data.reason) ?? cleanClue(data.result);
    const clue = clueStr ? ` (${clueStr})` : "";
    return `rerank · ${count} ${unit}${confBadge}${clue}`;
  }

  if (count > 0) {
    const unit = count === 1 ? "candidate" : "candidates";
    const clueStr = cleanClue(data.reason) ?? cleanClue(data.result);
    const clue = clueStr ? ` (${clueStr})` : "";
    return `${phase} · ${count} ${unit}${confBadge}${clue}`;
  }
  return `${phase} · completed`;
}

function formatPipelineCompletedResult(
  skills: string[],
  confidence?: number,
): string {
  if (skills.length === 0) {
    return "no relevant skills";
  }
  const count = skills.length;
  const unit = count === 1 ? "skill" : "skills";
  const names = skills.join(", ");
  const confidenceStr = formatConfidence(confidence);
  const confBadge = confidenceStr ? ` (${confidenceStr})` : "";
  return `${count} ${unit} selected: ${names}${confBadge}`;
}

export function updateSkillHarnessEntry(
  existingEntry: ToolEntry | undefined,
  event: AgentPipelineEvent,
  observedAtMs: number,
): ToolEntry | undefined {
  if (event.stream !== SKILL_HARNESS_EVENT_STREAM) return;
  const data = event.data;
  if (
    !data ||
    typeof data !== "object" ||
    data.kind !== SKILL_HARNESS_EVENT_KIND
  ) {
    return;
  }
  if (typeof data.phase !== "string" || !data.phase.trim()) return;

  const phase = data.phase.trim();
  const state = data.state;

  if (
    existingEntry &&
    (existingEntry.status === "completed" || existingEntry.status === "error")
  ) {
    return existingEntry;
  }

  const startedAtMs = existingEntry?.startedAtMs ?? observedAtMs;

  if (phase === "pipeline" && state === "started") {
    return {
      toolCallId: SKILL_HARNESS_TOOL,
      toolName: SKILL_HARNESS_TOOL,
      status: "pending",
      startedAtMs,
      params: {
        status: "selecting skills",
      },
    };
  }

  if (phase === "pipeline" && (state === "completed" || state === "skipped")) {
    const durationMs =
      typeof data.durationMs === "number" &&
      Number.isFinite(data.durationMs) &&
      data.durationMs >= 0
        ? data.durationMs
        : typeof existingEntry?.startedAtMs === "number"
          ? Math.max(0, observedAtMs - existingEntry.startedAtMs)
          : undefined;

    if (state === "skipped" || data.status === "skipped") {
      return {
        toolCallId: SKILL_HARNESS_TOOL,
        toolName: SKILL_HARNESS_TOOL,
        status: "completed",
        startedAtMs,
        durationMs,
        params: {
          result: "skill selection skipped",
        },
      };
    }

    const rawSkills =
      data.selectedSkills ??
      data.result ??
      existingEntry?.params?._selectedSkills ??
      [];
    const skills = extractSkillNames(rawSkills);
    const confidence =
      typeof data.confidence === "number" && Number.isFinite(data.confidence)
        ? data.confidence
        : (existingEntry?.params?._confidence as number | undefined);

    const result = formatPipelineCompletedResult(skills, confidence);

    return {
      toolCallId: SKILL_HARNESS_TOOL,
      toolName: SKILL_HARNESS_TOOL,
      status: "completed",
      startedAtMs,
      durationMs,
      params: {
        result,
      },
    };
  }

  if (state === "failed" || data.status === "error") {
    const error =
      getNonEmptyString(data.error) ??
      getNonEmptyString(data.reason) ??
      "skill selection failed";
    const durationMs =
      typeof data.durationMs === "number" &&
      Number.isFinite(data.durationMs) &&
      data.durationMs >= 0
        ? data.durationMs
        : typeof existingEntry?.startedAtMs === "number"
          ? Math.max(0, observedAtMs - existingEntry.startedAtMs)
          : undefined;

    return {
      toolCallId: SKILL_HARNESS_TOOL,
      toolName: SKILL_HARNESS_TOOL,
      status: "error",
      startedAtMs,
      durationMs,
      error,
      params: {},
    };
  }

  const status = formatPhaseStatus(data);

  const prevSkills = extractSkillNames(existingEntry?.params?._selectedSkills);
  let nextSkills = prevSkills;
  if (Array.isArray(data.selectedSkills) && data.selectedSkills.length > 0) {
    nextSkills = extractSkillNames(data.selectedSkills);
  } else if (phase === "rerank" && data.result) {
    nextSkills = extractSkillNames(data.result);
  } else if (phase === "name-match" && data.result && prevSkills.length === 0) {
    nextSkills = extractSkillNames(data.result);
  }

  const prevConfidence = existingEntry?.params?._confidence as
    number | undefined;
  let nextConfidence = prevConfidence;
  if (typeof data.confidence === "number" && Number.isFinite(data.confidence)) {
    nextConfidence = data.confidence;
  }

  return {
    toolCallId: SKILL_HARNESS_TOOL,
    toolName: SKILL_HARNESS_TOOL,
    status: "pending",
    startedAtMs,
    durationMs: existingEntry?.durationMs,
    params: {
      status,
      _selectedSkills: nextSkills,
      _confidence: nextConfidence,
    },
  };
}

export function finishPendingSkillHarness(history: ToolEntry[]): void {
  for (const entry of history) {
    if (entry.toolName !== SKILL_HARNESS_TOOL || entry.status !== "pending") {
      continue;
    }
    entry.status = "error";
    entry.params = {};
    entry.error = "skill selection unavailable";
  }
}

export function parseSkillHarnessPipelineEntry(
  event: AgentPipelineEvent,
): ToolEntry | undefined {
  return updateSkillHarnessEntry(undefined, event, Date.now());
}

export function mergeSkillHarnessPipelineEntry(
  existingChildEntries: ToolEntry[],
  entry: ToolEntry,
  _observedAtMs: number,
): { changed: boolean; entries: ToolEntry[] } {
  const existing = existingChildEntries.find(
    (tool) =>
      tool.toolCallId === entry.toolCallId ||
      tool.toolName === SKILL_HARNESS_TOOL,
  );
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { changed: false, entries: existingChildEntries };
  }
  const retained = existingChildEntries.filter(
    (tool) =>
      tool.toolCallId !== entry.toolCallId &&
      tool.toolName !== SKILL_HARNESS_TOOL,
  );
  return { changed: true, entries: [entry, ...retained] };
}
