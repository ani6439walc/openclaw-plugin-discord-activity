import type {
  StatefulStatusRenderResult,
  StatusBlockDisplayLevel,
  StatusDisplayState,
  ToolEntry,
} from "./types.js";
import {
  getToolIcon,
  formatDisplayFields,
  type DisplayField,
} from "./formatting.js";
import { ANSI, ansiSpan, sanitizeVisibleText } from "./ansi.js";
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
    duration = `${Math.round(durationMs / 10) / 100}s`;
  } else {
    duration = `${Math.round(durationMs / 100) / 10}s`;
  }
  return duration;
}

function formatHeaderDuration(entry: ToolEntry): string {
  if (typeof entry.durationMs !== "number") return "";
  return formatDurationBadge(entry.durationMs);
}

function formatDurationBadge(durationMs: number): string {
  return ` ${ansiSpan(ANSI.yellow, `[${formatDurationMs(durationMs)}]`)}`;
}

function getAuthoritativeGroupParent(
  prefix: string,
  parentEntry: ToolEntry | undefined,
): ToolEntry | undefined {
  if (!parentEntry) return;
  if (prefix === "active-memory") return parentEntry;
  if (
    prefix === "skill-harness" &&
    (parentEntry.status !== "pending" ||
      typeof parentEntry.startedAtMs === "number")
  ) {
    return parentEntry;
  }
}

function getGroupDurationMs(
  group: readonly ToolEntry[],
  prefix: string,
): number | undefined {
  const parentEntry = group.find((entry) => entry.toolName === prefix);
  const authoritativeParent = getAuthoritativeGroupParent(prefix, parentEntry);
  if (authoritativeParent) {
    return authoritativeParent.status === "pending"
      ? undefined
      : authoritativeParent.durationMs;
  }

  const parentDuration = parentEntry?.durationMs;
  if (typeof parentDuration === "number") return parentDuration;

  const childTools = group.filter(
    (entry) =>
      entry.toolName.startsWith(`${prefix}:`) &&
      !isSubagentResultEntry(entry, prefix),
  );

  if (
    childTools.length === 0 ||
    childTools.some(
      (entry) =>
        entry.status === "pending" ||
        typeof entry.startedAtMs !== "number" ||
        typeof entry.durationMs !== "number",
    )
  ) {
    return;
  }

  const startedAtMs = Math.min(
    ...childTools.map((entry) => entry.startedAtMs as number),
  );
  const completedAtMs = Math.max(
    ...childTools.map(
      (entry) => (entry.startedAtMs as number) + (entry.durationMs as number),
    ),
  );
  return Math.max(0, completedAtMs - startedAtMs);
}

function getStatusStyle(status: ToolEntry["status"]): string {
  if (status === "error") return ANSI.red;
  if (status === "orphan-completed") return ANSI.cyan;
  if (status === "completed") return ANSI.green;
  return ANSI.yellow;
}

function renderMainField(field: DisplayField): string {
  const keyStyle = field.key === "error" ? ANSI.red : ANSI.magenta;
  if (field.multilineLines) {
    return `${ansiSpan(keyStyle, `${field.key}:`)} |`;
  }
  const value = ansiSpan(ANSI.green, field.value);
  const hint = field.omittedHint
    ? ansiSpan(ANSI.lightGray, field.omittedHint)
    : "";
  return `${ansiSpan(keyStyle, `${field.key}:`)} ${value}${hint}`;
}

function getDisplayFieldWidth(field: DisplayField): number {
  return [...`${field.key}: ${field.value}${field.omittedHint ?? ""}`].length;
}

function packMainFields(fields: readonly DisplayField[]): DisplayField[][] {
  const compactFields: DisplayField[] = [];
  const ordinaryFields: DisplayField[] = [];

  for (const field of fields) {
    if (field.compactEligible && getDisplayFieldWidth(field) <= 70) {
      compactFields.push(field);
    } else {
      ordinaryFields.push(field);
    }
  }

  const rows: DisplayField[][] = [];
  let currentRow: DisplayField[] = [];
  let currentWidth = 0;
  for (const field of compactFields) {
    const fieldWidth = getDisplayFieldWidth(field);
    const nextWidth =
      currentWidth + (currentRow.length > 0 ? 3 : 0) + fieldWidth;
    if (currentRow.length === 3 || nextWidth > 70) {
      rows.push(currentRow);
      currentRow = [];
      currentWidth = 0;
    }
    currentRow.push(field);
    currentWidth += (currentRow.length > 1 ? 3 : 0) + fieldWidth;
  }
  if (currentRow.length > 0) rows.push(currentRow);

  return [...rows, ...ordinaryFields.map((field) => [field])];
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

function getSkillHarnessResultFields(entry: ToolEntry): DisplayField[] {
  const resultText = entry.params?.text ?? "";
  let cleanText = resultText;
  const fenceMatch = resultText.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/m);
  if (fenceMatch) {
    cleanText = fenceMatch[1].trim();
  }

  try {
    const obj = JSON.parse(cleanText);
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      return formatDisplayFields(obj, { toolName: entry.toolName });
    }
  } catch {}

  return formatDisplayFields(
    { result: cleanText },
    { toolName: entry.toolName },
  );
}

function createEntryFieldNodes(entry: ToolEntry): StatusNode[] {
  const nodes = packMainFields(
    formatDisplayFields(entry.params, { toolName: entry.toolName }),
  ).map(createFieldNode);

  if (
    entry.status === "error" &&
    entry.error &&
    entry.params?.error !== entry.error
  ) {
    const errorRows = packMainFields(
      formatDisplayFields({ error: entry.error }),
    );
    nodes.push(...errorRows.map(createFieldNode));
  }
  return nodes;
}

function createNestedToolNode(entry: ToolEntry, prefix: string): StatusNode {
  const strippedName = sanitizeHeaderToken(
    getDisplayToolName(entry.toolName.slice(prefix.length + 1)),
  );
  return {
    text: `${ansiSpan(ANSI.cyan, strippedName)} ${ansiSpan(getStatusStyle(entry.status), getSubSuffix(entry.status))}${formatHeaderDuration(entry)}`,
    continuationLines: [],
    children: createEntryFieldNodes(entry),
  };
}

type InternalGroupName = "active-memory" | "skill-harness";

const DISPLAY_LEVEL_RANK: Record<StatusBlockDisplayLevel, number> = {
  expanded: 0,
  collapsed: 1,
  removed: 2,
};

export function createDefaultStatusDisplayState(): StatusDisplayState {
  return {};
}

export function mergeStatusDisplayStates(
  ...states: readonly (StatusDisplayState | undefined)[]
): StatusDisplayState {
  const merged = createDefaultStatusDisplayState();
  for (const state of states) {
    if (!state) continue;
    for (const [key, level] of Object.entries(state)) {
      const current = merged[key] ?? "expanded";
      if (DISPLAY_LEVEL_RANK[level] > DISPLAY_LEVEL_RANK[current]) {
        merged[key] = level;
      }
    }
  }
  return merged;
}

function advanceDisplayState(
  state: StatusDisplayState,
  key: string,
  level: StatusBlockDisplayLevel,
): void {
  const current = state[key] ?? "expanded";
  if (DISPLAY_LEVEL_RANK[level] > DISPLAY_LEVEL_RANK[current]) {
    state[key] = level;
  }
}

type StatusHeader = {
  icon: string;
  name: string;
  nameStyle: string;
  status: string;
  statusStyle: string;
  durationMs?: number;
  disclosure?: boolean;
};

type StatusNode = {
  text: string;
  continuationLines: string[];
  children: StatusNode[];
};

type StatusBlock = {
  key: string;
  header: StatusHeader;
  children: StatusNode[];
  protected?: boolean;
};

function sanitizeHeaderToken(value: string): string {
  return sanitizeVisibleText(value).replaceAll(/[\r\n\t]+/gu, " ");
}

function renderStatusHeader(header: StatusHeader, collapsed = false): string {
  const label = header.name ? `${header.icon} ${header.name}` : header.icon;
  const duration =
    typeof header.durationMs === "number"
      ? formatDurationBadge(header.durationMs)
      : "";
  const disclosure = header.disclosure
    ? ` ${ansiSpan(ANSI.lightGray, collapsed ? "▸" : "▾")}`
    : "";
  return `${ansiSpan(header.nameStyle, label)}${disclosure} ${ansiSpan(header.statusStyle, header.status)}${duration}`;
}

function createFieldNode(fields: DisplayField[]): StatusNode {
  return {
    ...renderFieldNodeContent(fields),
    children: [],
  };
}

function renderFieldNodeContent(fields: readonly DisplayField[]): {
  text: string;
  continuationLines: string[];
} {
  const multilineField =
    fields.length === 1 && fields[0].multilineLines ? fields[0] : undefined;
  const multilineLines = multilineField?.multilineLines;
  const continuationLines = multilineLines
    ? multilineLines.map((line, index, lines) => {
        const coloredLine = ansiSpan(ANSI.green, line);
        return index === lines.length - 1 && multilineField.omittedHint
          ? `${coloredLine}${ansiSpan(ANSI.lightGray, multilineField.omittedHint)}`
          : coloredLine;
      })
    : [];
  return {
    text: fields.map(renderMainField).join(" · "),
    continuationLines,
  };
}

const ROOT_TREE_PREFIX = "   ";

function renderStatusNodes(
  nodes: readonly StatusNode[],
  prefix = ROOT_TREE_PREFIX,
): string[] {
  return nodes.flatMap((node, index) => {
    const isLast = index === nodes.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childPrefix = `${prefix}${isLast ? "    " : " │  "}`;
    return [
      `${prefix} ${connector} ${node.text}`,
      ...node.continuationLines.map((line) => `${childPrefix} ${line}`),
      ...renderStatusNodes(node.children, childPrefix),
    ];
  });
}

function renderSubagentGroup(
  icon: string,
  prefix: InternalGroupName,
  group: readonly ToolEntry[],
): StatusBlock {
  const realEntries = group.filter((e) => e.toolName.startsWith(`${prefix}:`));
  const displayedTools = realEntries
    .filter((entry) => !isSubagentResultEntry(entry, prefix))
    .slice(-STATUS_MAX_SUBAGENT_ENTRIES);
  const resultEntries = realEntries.filter((entry) =>
    isSubagentResultEntry(entry, prefix),
  );
  const parentEntry = group.find((entry) => entry.toolName === prefix);
  const authoritativeParent = getAuthoritativeGroupParent(prefix, parentEntry);
  const parentSuffix = group.some((entry) => entry.status === "error")
    ? "✘"
    : authoritativeParent
      ? getSubSuffix(authoritativeParent.status)
      : realEntries.length
        ? getParentSuffix(realEntries)
        : getParentSuffix(group);
  const parentErrorEntry = group.find(
    (entry) =>
      entry.toolName === prefix && entry.status === "error" && entry.error,
  );
  const nodes = displayedTools.map((entry) =>
    createNestedToolNode(entry, prefix),
  );
  for (const resultEntry of resultEntries) {
    const resultFields =
      prefix === "skill-harness"
        ? getSkillHarnessResultFields(resultEntry)
        : formatDisplayFields({ result: resultEntry.params?.text });
    for (const row of packMainFields(resultFields)) {
      nodes.push(createFieldNode(row));
    }
  }
  if (
    parentErrorEntry?.error &&
    !displayedTools.some((entry) => entry.error === parentErrorEntry.error)
  ) {
    for (const row of packMainFields(
      formatDisplayFields({ error: parentErrorEntry.error }),
    )) {
      nodes.push(createFieldNode(row));
    }
  }

  const parentStatus: ToolEntry["status"] =
    parentSuffix === "✘"
      ? "error"
      : parentSuffix === "✔"
        ? "completed"
        : "pending";
  const groupDurationMs = getGroupDurationMs(group, prefix);
  return {
    key: `group:${prefix}`,
    header: {
      icon,
      name: sanitizeHeaderToken(prefix),
      nameStyle: ANSI.boldCyan,
      status: parentSuffix,
      statusStyle: getStatusStyle(parentStatus),
      durationMs: groupDurationMs,
      disclosure: true,
    },
    children: nodes,
  };
}

function createEntryBlock(t: ToolEntry): StatusBlock {
  const icon = getToolIcon(t.toolName);
  const toolName = sanitizeHeaderToken(getDisplayToolName(t.toolName));
  const suffix = getSubSuffix(t.status);
  return {
    key: `tool:${t.displayId ?? t.toolCallId}`,
    header: {
      icon,
      name: toolName,
      nameStyle: ANSI.boldCyan,
      status: suffix,
      statusStyle: getStatusStyle(t.status),
      durationMs: t.durationMs,
      disclosure: true,
    },
    children: createEntryFieldNodes(t),
  };
}

function createMainAgentFailureBlock(): StatusBlock {
  const header: StatusHeader = {
    icon: "💥",
    name: "agent",
    nameStyle: ANSI.boldBlue,
    status: "✘",
    statusStyle: ANSI.red,
  };
  return {
    key: "agent",
    header,
    children: [],
    protected: true,
  };
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

  return groups;
}

const OPENING_FENCE = "```ansi\n";
const CLOSING_FENCE = "\n```";
function renderBlocks(
  blocks: readonly StatusBlock[],
  displayState: StatusDisplayState,
): string {
  const body = blocks
    .filter((block) => (displayState[block.key] ?? "expanded") !== "removed")
    .flatMap((block, index) => {
      const collapsed = (displayState[block.key] ?? "expanded") === "collapsed";
      return [
        ...(index > 0 ? [""] : []),
        renderStatusHeader(block.header, collapsed),
        ...(collapsed ? [] : renderStatusNodes(block.children)),
      ];
    });
  return `${OPENING_FENCE}${body.join("\n")}${CLOSING_FENCE}`;
}

function renderBoundedStatus(
  blocks: readonly StatusBlock[],
  requestedMaxLength: number,
  priorState: StatusDisplayState,
): StatefulStatusRenderResult {
  const minimumLength = OPENING_FENCE.length + CLOSING_FENCE.length;
  if (
    !Number.isInteger(requestedMaxLength) ||
    requestedMaxLength < minimumLength
  ) {
    throw new RangeError(
      `Status max length must be an integer of at least ${minimumLength}`,
    );
  }

  const maxLength = Math.min(requestedMaxLength, STATUS_MAX_LENGTH);
  const displayState = mergeStatusDisplayStates(priorState);
  const complete = (content: string): StatefulStatusRenderResult => ({
    content,
    displayState: mergeStatusDisplayStates(displayState),
  });
  const renderCurrent = () => renderBlocks(blocks, displayState);

  let content = renderCurrent();
  if (content.length <= maxLength) return complete(content);

  for (const block of blocks) {
    if (block.protected || !block.header.disclosure) continue;
    if ((displayState[block.key] ?? "expanded") !== "expanded") continue;
    advanceDisplayState(displayState, block.key, "collapsed");
    content = renderCurrent();
    if (content.length <= maxLength) return complete(content);
  }

  for (const block of blocks) {
    if (block.protected) continue;
    if ((displayState[block.key] ?? "expanded") === "removed") continue;
    advanceDisplayState(displayState, block.key, "removed");
    content = renderCurrent();
    if (content.length <= maxLength) return complete(content);
  }

  return complete(
    content.length <= maxLength ? content : `${OPENING_FENCE}${CLOSING_FENCE}`,
  );
}

export function renderStatusContentWithState(
  toolHistory: readonly ToolEntry[],
  _isFinal: boolean,
  maxLength = STATUS_MAX_LENGTH,
  priorState = createDefaultStatusDisplayState(),
): StatefulStatusRenderResult {
  const displayState = mergeStatusDisplayStates(priorState);
  const subagentBlocks = getSubagentGroupEntries(toolHistory).map((group) =>
    renderSubagentGroup(
      group.name === "active-memory" ? "🧩" : "💡",
      group.name,
      group.entries,
    ),
  );
  const normalBlocks = toolHistory
    .filter(
      (entry) =>
        !isSubagentToolEntry(entry, "active-memory") &&
        !isSubagentToolEntry(entry, "skill-harness") &&
        !isMainAgentEntry(entry),
    )
    .map(createEntryBlock);
  const mainAgentFailure = toolHistory.filter(isMainAgentEntry).at(-1);
  const failureBlock =
    mainAgentFailure?.status === "error"
      ? createMainAgentFailureBlock()
      : undefined;
  const eligibleBlocks = [...subagentBlocks, ...normalBlocks].filter(
    (block) => (displayState[block.key] ?? "expanded") !== "removed",
  );
  const availableSlots = STATUS_MAX_ENTRIES - (failureBlock ? 1 : 0);
  const selectedBlocks = eligibleBlocks.slice(-availableSlots);
  const selectedKeys = new Set(selectedBlocks.map((block) => block.key));
  for (const block of eligibleBlocks) {
    if (!selectedKeys.has(block.key)) {
      advanceDisplayState(displayState, block.key, "removed");
    }
  }

  return renderBoundedStatus(
    failureBlock ? [...selectedBlocks, failureBlock] : selectedBlocks,
    maxLength,
    displayState,
  );
}

export function renderStatusContent(
  toolHistory: readonly ToolEntry[],
  isFinal: boolean,
  maxLength = STATUS_MAX_LENGTH,
): string {
  return renderStatusContentWithState(toolHistory, isFinal, maxLength).content;
}

export function isContentTooLong(
  content: string,
  _entryCount: number,
): boolean {
  return content.length > STATUS_MAX_LENGTH;
}
