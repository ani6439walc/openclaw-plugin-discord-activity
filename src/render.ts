import type { ToolEntry } from "./types.js";
import { getToolIcon, formatParams } from "./formatting.js";
import { STATUS_MAX_LENGTH, STATUS_MAX_ENTRIES } from "./constants.js";

function getSubSuffix(status: ToolEntry["status"]): string {
  if (status === "error") return "✘";
  if (status === "orphan-completed") return "♻︎";
  if (status === "completed") return "✔";
  return "←";
}

function renderEntry(t: ToolEntry, isLast: boolean, isFinal: boolean): string {
  const icon = getToolIcon(t.toolName);
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
  const dur =
    typeof t.durationMs === "number"
      ? ` (${t.durationMs.toLocaleString()}ms)`
      : "";
  const errorLine =
    t.status === "error" && t.error ? `\n     error: ${t.error}` : "";
  return `${icon} ${t.toolName}: ${suffix}${dur}${pStr ? "\n" + pStr : ""}${errorLine}`;
}

function renderActiveMemoryGroup(
  group: readonly ToolEntry[],
  _isFinal: boolean,
): string {
  const realEntries = group.filter((e) =>
    e.toolName.startsWith("active-memory:"),
  );
  const subEntryStrs = realEntries.map((entry) => {
    if (entry.toolName === "active-memory:result") {
      return formatParams(
        { result: entry.params?.text },
        {
          first: "   - ",
          rest: "     ",
        },
      );
    }

    const strippedName = entry.toolName.replace(/^active-memory:/, "");
    const subSuffix = getSubSuffix(entry.status);
    const dur =
      typeof entry.durationMs === "number"
        ? ` (${entry.durationMs.toLocaleString()}ms)`
        : "";
    const pStr = formatParams(entry.params, {
      first: "     - ",
      rest: "       ",
    });
    return `   - ${strippedName}: ${subSuffix}${dur}${pStr ? "\n" + pStr : ""}`;
  });

  const hasError = group.some((e) => e.status === "error");
  const hasPending = group.some((e) => e.status === "pending");
  const parentSuffix = hasError ? "✘" : hasPending ? "←" : "✔";
  const errorEntry = group.find((e) => e.status === "error" && e.error);
  const errorLine = errorEntry?.error
    ? `\n     error: ${errorEntry.error}`
    : "";

  return `🧩 active-memory: ${parentSuffix}${
    subEntryStrs.length ? "\n" + subEntryStrs.join("\n") : ""
  }${errorLine}`;
}

function renderIntentionHintGroup(group: readonly ToolEntry[]): string {
  const realEntries = group.filter((e) =>
    e.toolName.startsWith("intention-hint:"),
  );

  if (
    realEntries.length === 1 &&
    realEntries[0].toolName === "intention-hint:result"
  ) {
    const resultEntry = realEntries[0];
    const resultText = resultEntry.params?.text ?? "";
    const dur =
      typeof resultEntry.durationMs === "number"
        ? ` (${resultEntry.durationMs.toLocaleString()}ms)`
        : "";
    const hasError = group.some((e) => e.status === "error");
    const parentSuffix = hasError ? "✘" : "✔";
    const errorEntry = group.find((e) => e.status === "error" && e.error);
    const errorLine = errorEntry?.error
      ? `\n     error: ${errorEntry.error}`
      : "";

    const lines = resultText
      .split("\n")
      .map((line: string) => line.trim())
      .filter(Boolean);
    const flatParams = lines
      .map((line: string, index: number) => {
        const prefix = index === 0 ? "   - " : "     ";
        return `${prefix}${line}`;
      })
      .join("\n");

    return `💡 intention-hint: ${parentSuffix}${dur}${flatParams ? "\n" + flatParams : ""}${errorLine}`;
  }

  const subEntryStrs = realEntries.map((entry) => {
    if (entry.toolName === "intention-hint:result") {
      return formatParams(
        { result: entry.params?.text },
        {
          first: "   - ",
          rest: "     ",
        },
      );
    }

    const strippedName = entry.toolName.replace(/^intention-hint:/, "");
    const subSuffix = getSubSuffix(entry.status);
    const dur =
      typeof entry.durationMs === "number"
        ? ` (${entry.durationMs.toLocaleString()}ms)`
        : "";
    const pStr = formatParams(entry.params, {
      first: "     - ",
      rest: "       ",
    });
    return `   - ${strippedName}: ${subSuffix}${dur}${pStr ? "\n" + pStr : ""}`;
  });

  const hasError = group.some((e) => e.status === "error");
  const hasPending = group.some((e) => e.status === "pending");
  const parentSuffix = hasError ? "✘" : hasPending ? "←" : "✔";
  const errorEntry = group.find((e) => e.status === "error" && e.error);
  const errorLine = errorEntry?.error
    ? `\n     error: ${errorEntry.error}`
    : "";

  return `💡 intention-hint: ${parentSuffix}${
    subEntryStrs.length ? "\n" + subEntryStrs.join("\n") : ""
  }${errorLine}`;
}

function getSubagentGroupEntries(
  toolHistory: readonly ToolEntry[],
): Array<{ name: "active-memory" | "intention-hint"; entries: ToolEntry[] }> {
  const groups: Array<{
    name: "active-memory" | "intention-hint";
    entries: ToolEntry[];
  }> = [];

  const activeMemoryEntries = toolHistory.filter(
    (t) =>
      t.toolName === "active-memory" || t.toolName.startsWith("active-memory:"),
  );
  if (activeMemoryEntries.length > 0) {
    groups.push({ name: "active-memory", entries: activeMemoryEntries });
  }

  const intentionHintEntries = toolHistory.filter(
    (t) =>
      t.toolName === "intention-hint" ||
      t.toolName.startsWith("intention-hint:"),
  );
  if (intentionHintEntries.length > 0) {
    groups.push({ name: "intention-hint", entries: intentionHintEntries });
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
      contentParts.push(renderIntentionHintGroup(group.entries));
    }
  }

  const normalEntries = toolHistory.filter(
    (t) =>
      !(
        t.toolName === "active-memory" ||
        t.toolName.startsWith("active-memory:") ||
        t.toolName === "intention-hint" ||
        t.toolName.startsWith("intention-hint:")
      ),
  );

  for (const [index, entry] of normalEntries.entries()) {
    const isLast = index === normalEntries.length - 1;
    contentParts.push(renderEntry(entry, isLast, isFinal));
  }

  return "```yaml\n" + contentParts.join("\n\n") + "\n```";
}

export function isContentTooLong(content: string, entryCount: number): boolean {
  return content.length > STATUS_MAX_LENGTH || entryCount > STATUS_MAX_ENTRIES;
}
