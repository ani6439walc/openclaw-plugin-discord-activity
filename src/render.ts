import type { ToolEntry } from "./types.js";
import { getToolIcon, formatParams } from "./formatting.js";
import {
  STATUS_MAX_LENGTH,
  STATUS_MAX_ENTRIES,
  STATUS_MAX_SUBAGENT_ENTRIES,
} from "./constants.js";
import { getDisplayToolName } from "./tool-name.js";

function getSubSuffix(status: ToolEntry["status"]): string {
  if (status === "error") return "✘";
  if (status === "orphan-completed") return "♻︎";
  if (status === "completed") return "✔";
  return "←";
}

function formatDurationMs(durationMs: number): string {
  let duration: string;
  if (durationMs <= 1000) {
    duration = `${durationMs.toLocaleString()}ms`;
  } else if (durationMs < 10_000) {
    duration = `${(Math.round(durationMs / 10) / 100).toFixed(2)}s`;
  } else {
    duration = `${(Math.round(durationMs / 100) / 10).toFixed(1)}s`;
  }
  return ` (${duration})`;
}

function formatDuration(entry: ToolEntry): string {
  return typeof entry.durationMs === "number"
    ? formatDurationMs(entry.durationMs)
    : "";
}

function formatErrorLine(entry: ToolEntry | undefined): string {
  return entry?.status === "error" && entry.error
    ? `\n${formatParams({ error: entry.error }, { first: "   - ", rest: "     " })}`
    : "";
}

function formatNestedErrorLine(entry: ToolEntry): string {
  if (
    entry.status !== "error" ||
    !entry.error ||
    entry.params?.error === entry.error
  ) {
    return "";
  }
  return `\n${formatParams(
    { error: entry.error },
    { first: "     - ", rest: "       " },
  )}`;
}

function getParentSuffix(group: readonly ToolEntry[]): string {
  const hasError = group.some((entry) => entry.status === "error");
  const hasPending = group.some((entry) => entry.status === "pending");
  return hasError ? "✘" : hasPending ? "←" : "✔";
}

function isSubagentToolEntry(entry: ToolEntry, prefix: string): boolean {
  return entry.toolName === prefix || entry.toolName.startsWith(`${prefix}:`);
}

function isSubagentResultEntry(entry: ToolEntry, prefix: string): boolean {
  return entry.toolName === `${prefix}:result`;
}

function isMainAgentEntry(entry: ToolEntry): boolean {
  return entry.toolCallId === "agent" && entry.toolName === "agent";
}

function sortSubagentChildEntries(
  entries: readonly ToolEntry[],
  prefix: string,
): ToolEntry[] {
  const toolEntries = entries.filter(
    (entry) => !isSubagentResultEntry(entry, prefix),
  );
  const resultEntries = entries.filter((entry) =>
    isSubagentResultEntry(entry, prefix),
  );
  return [...toolEntries, ...resultEntries].slice(-STATUS_MAX_SUBAGENT_ENTRIES);
}

function renderSkillHarnessResult(entry: ToolEntry): string {
  const resultText = entry.params?.text ?? "";
  let cleanText = resultText;
  const fenceMatch = resultText.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/m);
  if (fenceMatch) {
    cleanText = fenceMatch[1].trim();
  }

  try {
    const obj = JSON.parse(cleanText);
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      return formatParams(obj, { first: "   - ", rest: "     " });
    }
  } catch {}

  return formatParams({ result: cleanText }, { first: "   - ", rest: "     " });
}

function renderNestedToolEntry(
  entry: ToolEntry,
  prefix: string,
  renderResult?: (entry: ToolEntry) => string,
): string {
  if (entry.toolName === `${prefix}:result`) {
    if (renderResult) {
      return renderResult(entry);
    }
    return formatParams(
      { result: entry.params?.text },
      {
        first: "   - ",
        rest: "     ",
      },
    );
  }

  const strippedName = getDisplayToolName(
    entry.toolName.slice(prefix.length + 1),
  );
  const pStr = formatParams(entry.params, {
    first: "     - ",
    rest: "       ",
  });
  return `   - ${strippedName}: ${getSubSuffix(entry.status)}${formatDuration(entry)}${pStr ? "\n" + pStr : ""}${formatNestedErrorLine(entry)}`;
}

function renderSubagentGroup(
  icon: string,
  prefix: string,
  group: readonly ToolEntry[],
  renderResult?: (entry: ToolEntry) => string,
): string {
  const realEntries = group.filter((e) => e.toolName.startsWith(`${prefix}:`));
  const displayedEntries = sortSubagentChildEntries(realEntries, prefix);
  const subEntryStrs = displayedEntries.map((entry) =>
    renderNestedToolEntry(entry, prefix, renderResult),
  );
  const parentSuffix = group.some((entry) => entry.status === "error")
    ? "✘"
    : realEntries.length
      ? getParentSuffix(realEntries)
      : getParentSuffix(group);
  const parentErrorEntry = group.find(
    (entry) =>
      entry.toolName === prefix && entry.status === "error" && entry.error,
  );
  const errorLine = displayedEntries.some(
    (entry) => entry.error === parentErrorEntry?.error,
  )
    ? ""
    : formatErrorLine(parentErrorEntry);

  const totalDuration = realEntries.reduce(
    (sum, entry) =>
      sum + (typeof entry.durationMs === "number" ? entry.durationMs : 0),
    0,
  );
  const durationStr = totalDuration > 0 ? formatDurationMs(totalDuration) : "";

  return `${icon} ${prefix}: ${parentSuffix}${durationStr}${
    subEntryStrs.length ? "\n" + subEntryStrs.join("\n") : ""
  }${errorLine}`;
}

function renderEntry(t: ToolEntry, isLast: boolean, isFinal: boolean): string {
  const icon = getToolIcon(t.toolName);
  const toolName = getDisplayToolName(t.toolName);
  const pStr = formatParams(t.params);
  const done =
    t.status === "completed" ||
    t.status === "error" ||
    t.status === "orphan-completed";
  let suffix: string;
  if (t.status === "error") {
    suffix = "✘";
  } else if (t.status === "orphan-completed") {
    suffix = "♻︎";
  } else if (done && (!isLast || isFinal)) {
    suffix = "✔";
  } else {
    suffix = "←";
  }
  const dur = formatDuration(t);
  const errorLine = formatErrorLine(t);
  return `${icon} ${toolName}: ${suffix}${dur}${pStr ? "\n" + pStr : ""}${errorLine}`;
}

function renderMainAgentFailure(entry: ToolEntry): string {
  return `🤖 agent: ✘${formatErrorLine(entry)}`;
}

function renderActiveMemoryGroup(
  group: readonly ToolEntry[],
  _isFinal: boolean,
): string {
  return renderSubagentGroup("🧩", "active-memory", group);
}

function renderSkillHarnessGroup(group: readonly ToolEntry[]): string {
  return renderSubagentGroup(
    "💡",
    "skill-harness",
    group,
    renderSkillHarnessResult,
  );
}

function getSubagentGroupEntries(
  toolHistory: readonly ToolEntry[],
): Array<{ name: "active-memory" | "skill-harness"; entries: ToolEntry[] }> {
  const groups: Array<{
    name: "active-memory" | "skill-harness";
    entries: ToolEntry[];
  }> = [];

  const activeMemoryEntries = toolHistory.filter((t) =>
    isSubagentToolEntry(t, "active-memory"),
  );
  if (activeMemoryEntries.length > 0) {
    groups.push({ name: "active-memory", entries: activeMemoryEntries });
  }

  const skillHarnessEntries = toolHistory.filter((t) =>
    isSubagentToolEntry(t, "skill-harness"),
  );
  if (skillHarnessEntries.length > 0) {
    groups.push({ name: "skill-harness", entries: skillHarnessEntries });
  }

  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

const OPENING_FENCE = "```yaml\n";
const CLOSING_FENCE = "\n```";

type StatusLine = { text: string; protected: boolean };

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (maxLength <= 1) return "…";
  const contentLimit = maxLength - 1;
  let content = "";
  for (const character of text) {
    if (content.length + character.length > contentLimit) break;
    content += character;
  }
  return `${content}…`;
}

function renderBoundedStatus(
  contentParts: readonly string[],
  requestedMaxLength: number,
): string {
  const maxLength = Math.max(
    Math.min(requestedMaxLength, STATUS_MAX_LENGTH),
    OPENING_FENCE.length + CLOSING_FENCE.length,
  );
  const lines = contentParts.flatMap((part, partIndex) => [
    ...(partIndex > 0 ? [{ text: "", protected: false }] : []),
    ...part.split("\n").map((text, lineIndex) => ({
      text,
      protected: lineIndex === 0 || /^\s+- .*: (?:←|✔|✘|♻︎)/u.test(text),
    })),
  ]);
  const retained = lines.map(() => true);
  let retainedCount = lines.length;
  let retainedCharacters = lines.reduce(
    (total, line) => total + line.text.length,
    0,
  );
  let omittedLineCount = 0;

  const getMarker = () => {
    if (omittedLineCount <= 0) return "";
    const unit = omittedLineCount === 1 ? "line" : "lines";
    return `... ${omittedLineCount} ${unit} more`;
  };
  const getRenderedLength = () => {
    const marker = getMarker();
    return (
      OPENING_FENCE.length +
      retainedCharacters +
      Math.max(0, retainedCount - 1) +
      (marker ? marker.length + (retainedCount > 0 ? 1 : 0) : 0) +
      CLOSING_FENCE.length
    );
  };

  const omitLine = (index: number) => {
    if (!retained[index]) return;
    retained[index] = false;
    retainedCount -= 1;
    retainedCharacters -= lines[index].text.length;
    if (lines[index].text.trim()) {
      omittedLineCount += 1;
    }
  };

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (getRenderedLength() <= maxLength) break;
    const line = lines[index];
    if (!line.protected && line.text.trim()) omitLine(index);
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (getRenderedLength() <= maxLength) break;
    const line = lines[index];
    if (!line.protected && !line.text.trim()) omitLine(index);
  }

  while (getRenderedLength() > maxLength && retainedCount > 0) {
    let longestIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (
        retained[index] &&
        (longestIndex < 0 ||
          lines[index].text.length > lines[longestIndex].text.length)
      ) {
        longestIndex = index;
      }
    }
    if (longestIndex < 0) break;

    const line = lines[longestIndex];
    const maxReduction = line.text.length - 1;
    if (maxReduction <= 0) {
      omitLine(longestIndex);
      continue;
    }
    const reduction = Math.min(getRenderedLength() - maxLength, maxReduction);
    const nextLength = line.text.length - reduction;
    const nextText = truncateWithEllipsis(line.text, nextLength);
    retainedCharacters += nextText.length - line.text.length;
    line.text = nextText;
  }

  const body = lines
    .filter((_, index) => retained[index])
    .map((line) => line.text);
  const marker = getMarker();
  if (marker) body.push(marker);
  return `${OPENING_FENCE}${body.join("\n")}${CLOSING_FENCE}`;
}

export function renderStatusContent(
  toolHistory: readonly ToolEntry[],
  isFinal: boolean,
  maxLength = STATUS_MAX_LENGTH,
): string {
  const contentParts: string[] = [];
  const subagentGroups = getSubagentGroupEntries(toolHistory);
  const normalEntries = toolHistory
    .filter(
      (t) =>
        !(
          isSubagentToolEntry(t, "active-memory") ||
          isSubagentToolEntry(t, "skill-harness") ||
          isMainAgentEntry(t)
        ),
    )
    .slice(-STATUS_MAX_ENTRIES);
  const subagentGroupBudget = STATUS_MAX_ENTRIES - normalEntries.length;
  const visibleSubagentGroups =
    subagentGroupBudget >= subagentGroups.length
      ? subagentGroups
      : subagentGroupBudget > 0
        ? subagentGroups.slice(-subagentGroupBudget)
        : [];

  for (const group of visibleSubagentGroups) {
    if (group.name === "active-memory") {
      contentParts.push(renderActiveMemoryGroup(group.entries, isFinal));
    } else {
      contentParts.push(renderSkillHarnessGroup(group.entries));
    }
  }

  const mainAgentFailure = toolHistory.filter(isMainAgentEntry).at(-1);
  if (mainAgentFailure?.status === "error") {
    contentParts.push(renderMainAgentFailure(mainAgentFailure));
  }

  for (const [index, entry] of normalEntries.entries()) {
    const isLast = index === normalEntries.length - 1;
    contentParts.push(renderEntry(entry, isLast, isFinal));
  }

  return renderBoundedStatus(contentParts, maxLength);
}

export function isContentTooLong(
  content: string,
  _entryCount: number,
): boolean {
  return content.length > STATUS_MAX_LENGTH;
}
