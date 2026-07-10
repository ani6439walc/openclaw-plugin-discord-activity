import type { ToolEntry } from "./types.js";
import { getToolIcon, formatParams } from "./formatting.js";
import { STATUS_MAX_LENGTH, STATUS_MAX_ENTRIES } from "./constants.js";
import { getDisplayToolName } from "./tool-name.js";

function getSubSuffix(status: ToolEntry["status"]): string {
  if (status === "error") return "✘";
  if (status === "orphan-completed") return "♻︎";
  if (status === "completed") return "✔";
  return "←";
}

function formatDuration(entry: ToolEntry): string {
  return typeof entry.durationMs === "number"
    ? ` (${entry.durationMs.toLocaleString()}ms)`
    : "";
}

function formatErrorLine(entry: ToolEntry | undefined): string {
  return entry?.status === "error" && entry.error
    ? `\n${formatParams({ error: entry.error }, { first: "   - ", rest: "     " })}`
    : "";
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
  return [...toolEntries, ...resultEntries].slice(-STATUS_MAX_ENTRIES);
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
  return `   - ${strippedName}: ${getSubSuffix(entry.status)}${formatDuration(entry)}${pStr ? "\n" + pStr : ""}`;
}

function renderSubagentGroup(
  icon: string,
  prefix: string,
  group: readonly ToolEntry[],
  renderResult?: (entry: ToolEntry) => string,
): string {
  const realEntries = group.filter((e) => e.toolName.startsWith(`${prefix}:`));
  const subEntryStrs = sortSubagentChildEntries(realEntries, prefix).map(
    (entry) => renderNestedToolEntry(entry, prefix, renderResult),
  );
  const parentSuffix = group.some((entry) => entry.status === "error")
    ? "✘"
    : realEntries.length
      ? getParentSuffix(realEntries)
      : getParentSuffix(group);
  const errorEntry = group.find((e) => e.status === "error" && e.error);
  const errorLine = formatErrorLine(errorEntry);

  const totalDuration = realEntries.reduce(
    (sum, entry) =>
      sum + (typeof entry.durationMs === "number" ? entry.durationMs : 0),
    0,
  );
  const durationStr =
    totalDuration > 0 ? ` (${totalDuration.toLocaleString()}ms)` : "";

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

export function renderStatusContent(
  toolHistory: readonly ToolEntry[],
  isFinal: boolean,
): string {
  const contentParts: string[] = [];
  const subagentGroups = getSubagentGroupEntries(toolHistory);

  for (const group of subagentGroups) {
    if (group.name === "active-memory") {
      contentParts.push(renderActiveMemoryGroup(group.entries, isFinal));
    } else {
      contentParts.push(renderSkillHarnessGroup(group.entries));
    }
  }

  const normalEntries = toolHistory
    .filter(
      (t) =>
        !(
          isSubagentToolEntry(t, "active-memory") ||
          isSubagentToolEntry(t, "skill-harness")
        ),
    )
    .slice(-STATUS_MAX_ENTRIES);

  for (const [index, entry] of normalEntries.entries()) {
    const isLast = index === normalEntries.length - 1;
    contentParts.push(renderEntry(entry, isLast, isFinal));
  }

  return "```yaml\n" + contentParts.join("\n\n") + "\n```";
}

export function isContentTooLong(
  content: string,
  _entryCount: number,
): boolean {
  return content.length > STATUS_MAX_LENGTH;
}
