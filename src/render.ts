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
  const errorLine = t.status === "error" && t.error ? `\n   - ${t.error}` : "";
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
  const parentSuffix = hasError ? "✘" : hasPending ? "←" : "♻︎";
  const errorEntry = group.find((e) => e.status === "error" && e.error);
  const errorLine = errorEntry?.error ? `\n   - ${errorEntry.error}` : "";

  return `🧠 active-memory: ${parentSuffix}${
    subEntryStrs.length ? "\n" + subEntryStrs.join("\n") : ""
  }${errorLine}`;
}

function renderIntentionHintGroup(group: readonly ToolEntry[]): string {
  const realEntries = group.filter((e) =>
    e.toolName.startsWith("intention-hint:"),
  );
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
  const errorLine = errorEntry?.error ? `\n   - ${errorEntry.error}` : "";

  return `☄️ intention-hint: ${parentSuffix}${
    subEntryStrs.length ? "\n" + subEntryStrs.join("\n") : ""
  }${errorLine}`;
}

export function renderStatusContent(
  toolHistory: readonly ToolEntry[],
  isFinal: boolean,
): string {
  const contentParts: string[] = [];
  let i = 0;

  while (i < toolHistory.length) {
    const t = toolHistory[i];
    if (
      t.toolName === "active-memory" ||
      t.toolName.startsWith("active-memory:")
    ) {
      const group: ToolEntry[] = [];
      while (
        i < toolHistory.length &&
        (toolHistory[i].toolName === "active-memory" ||
          toolHistory[i].toolName.startsWith("active-memory:"))
      ) {
        group.push(toolHistory[i]);
        i++;
      }
      contentParts.push(renderActiveMemoryGroup(group, isFinal));
    } else if (
      t.toolName === "intention-hint" ||
      t.toolName.startsWith("intention-hint:")
    ) {
      const group: ToolEntry[] = [];
      while (
        i < toolHistory.length &&
        (toolHistory[i].toolName === "intention-hint" ||
          toolHistory[i].toolName.startsWith("intention-hint:"))
      ) {
        group.push(toolHistory[i]);
        i++;
      }
      contentParts.push(renderIntentionHintGroup(group));
    } else {
      const isLast = i === toolHistory.length - 1;
      contentParts.push(renderEntry(t, isLast, isFinal));
      i++;
    }
  }

  return "```yaml\n" + contentParts.join("\n\n") + "\n```";
}

export function isContentTooLong(content: string, entryCount: number): boolean {
  return content.length > STATUS_MAX_LENGTH || entryCount > STATUS_MAX_ENTRIES;
}
