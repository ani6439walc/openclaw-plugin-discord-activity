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
  return `${icon} ${t.toolName}: ${suffix}${dur}${pStr ? "\n" + pStr : ""}`;
}

function renderActiveMemoryGroup(
  group: readonly ToolEntry[],
  isFinal: boolean,
): string {
  const realEntries = group.filter((e) =>
    e.toolName.startsWith("active-memory:"),
  );
  const subEntryStrs = realEntries.map((entry) => {
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

  return `🧠 active-memory: ♻︎${
    subEntryStrs.length ? "\n" + subEntryStrs.join("\n") : ""
  }`;
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
