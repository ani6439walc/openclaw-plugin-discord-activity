import type { ToolEntry } from "./types.js";
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

function getGroupDurationMs(
  group: readonly ToolEntry[],
  prefix: string,
): number | undefined {
  const parentEntry = group.find((entry) => entry.toolName === prefix);
  const hasSkillHarnessLifecycleParent =
    prefix === "skill-harness" &&
    parentEntry !== undefined &&
    (parentEntry.status !== "pending" ||
      typeof parentEntry.startedAtMs === "number");
  if (hasSkillHarnessLifecycleParent) {
    return parentEntry.status === "pending"
      ? undefined
      : parentEntry.durationMs;
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
      return formatDisplayFields(obj);
    }
  } catch {}

  return formatDisplayFields({ result: cleanText });
}

function createEntryFieldNodes(
  entry: ToolEntry,
  errorPriority: DetailPriority,
  sourceIndex: number,
): { nodes: StatusNode[]; errorNode?: StatusNode } {
  const nodes = packMainFields(
    formatDisplayFields(entry.params, { toolName: entry.toolName }),
  ).map((row, index) =>
    createFieldNode(
      row,
      entry.status === "error" &&
        entry.error !== undefined &&
        entry.params?.error === entry.error &&
        row.some((field) => field.key === "error")
        ? errorPriority
        : 0,
      sourceIndex,
      index,
    ),
  );
  let errorNode = nodes.find((node) => node.priority === errorPriority);

  if (
    entry.status === "error" &&
    entry.error &&
    entry.params?.error !== entry.error
  ) {
    const errorRows = packMainFields(
      formatDisplayFields({ error: entry.error }),
    );
    const errorNodes = errorRows.map((row, index) =>
      createFieldNode(row, errorPriority, sourceIndex, nodes.length + index),
    );
    nodes.push(...errorNodes);
    errorNode = errorNodes[0];
  }
  return { nodes, errorNode };
}

function createNestedToolNode(
  entry: ToolEntry,
  prefix: string,
  sourceIndex: number,
): { node: StatusNode; errorNode?: StatusNode } {
  const strippedName = sanitizeHeaderToken(
    getDisplayToolName(entry.toolName.slice(prefix.length + 1)),
  );
  const { nodes, errorNode } = createEntryFieldNodes(entry, 2, sourceIndex);
  const node: StatusNode = {
    text: `${ansiSpan(ANSI.cyan, strippedName)} ${ansiSpan(getStatusStyle(entry.status), getSubSuffix(entry.status))}${formatHeaderDuration(entry)}`,
    continuationLines: [],
    children: nodes,
    priority: 4,
    sourceIndex,
    fieldIndex: -1,
  };
  nodes.forEach((child) => {
    child.parent = node;
  });
  return { node, errorNode };
}

type DetailPriority = 0 | 1 | 2 | 3 | 4;

type StatusHeader = {
  icon: string;
  name: string;
  nameStyle: string;
  status: string;
  statusStyle: string;
  durationMs?: number;
  compressibleName?: boolean;
  disclosure?: boolean;
};

type StatusNode = {
  text: string;
  continuationLines: string[];
  children: StatusNode[];
  priority: DetailPriority;
  sourceIndex: number;
  fieldIndex: number;
  parent?: StatusNode;
  suppressedBy?: StatusNode;
};

type StatusBlock = {
  header: StatusHeader;
  children: StatusNode[];
  sourceIndex: number;
  collapseChildrenAtomically?: boolean;
};

function sanitizeHeaderToken(value: string): string {
  return sanitizeVisibleText(value).replaceAll(/[\r\n\t]+/gu, " ");
}

function renderStatusHeader(
  header: StatusHeader,
  options: {
    collapsed?: boolean;
    includeDuration?: boolean;
    name?: string;
  } = {},
): string {
  const name = options.name ?? header.name;
  const label = name ? `${header.icon} ${name}` : header.icon;
  const duration =
    options.includeDuration !== false && typeof header.durationMs === "number"
      ? formatDurationBadge(header.durationMs)
      : "";
  const disclosure = header.disclosure
    ? ` ${ansiSpan(ANSI.cyan, options.collapsed ? "▸" : "▾")}`
    : "";
  return `${ansiSpan(header.nameStyle, label)}${disclosure} ${ansiSpan(header.statusStyle, header.status)}${duration}`;
}

function createFieldNode(
  fields: DisplayField[],
  priority: DetailPriority = 0,
  sourceIndex = 0,
  fieldIndex = 0,
): StatusNode {
  const multilineField =
    fields.length === 1 && fields[0].multilineLines ? fields[0] : undefined;
  const multilineLines = multilineField?.multilineLines;
  const continuationLines = multilineLines
    ? multilineLines.map((line, index, lines) =>
        index === lines.length - 1 && multilineField.omittedHint
          ? `${line}${ansiSpan(ANSI.lightGray, multilineField.omittedHint)}`
          : line,
      )
    : [];
  return {
    text: fields.map(renderMainField).join(" · "),
    continuationLines,
    children: [],
    priority,
    sourceIndex,
    fieldIndex,
  };
}

const ROOT_TREE_PREFIX = "   ";

function renderStatusNodes(
  nodes: readonly StatusNode[],
  removed: ReadonlySet<StatusNode>,
  prefix = ROOT_TREE_PREFIX,
): string[] {
  const visible = nodes.filter((node) => isStatusNodeVisible(node, removed));
  return visible.flatMap((node, index) => {
    const isLast = index === visible.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childPrefix = `${prefix}${isLast ? "    " : " │  "}`;
    return [
      `${prefix} ${connector} ${node.text}`,
      ...node.continuationLines.map((line) => `${childPrefix} ${line}`),
      ...renderStatusNodes(node.children, removed, childPrefix),
    ];
  });
}

function isStatusNodeVisible(
  node: StatusNode,
  removed: ReadonlySet<StatusNode>,
): boolean {
  if (removed.has(node)) return false;
  if (node.parent && !isStatusNodeVisible(node.parent, removed)) return false;
  return !node.suppressedBy || !isStatusNodeVisible(node.suppressedBy, removed);
}

function renderSubagentGroup(
  icon: string,
  prefix: string,
  group: readonly ToolEntry[],
  sourceIndexes: ReadonlyMap<ToolEntry, number>,
): StatusBlock {
  const realEntries = group.filter((e) => e.toolName.startsWith(`${prefix}:`));
  const displayedTools = realEntries
    .filter((entry) => !isSubagentResultEntry(entry, prefix))
    .slice(-STATUS_MAX_SUBAGENT_ENTRIES);
  const resultEntries = realEntries.filter((entry) =>
    isSubagentResultEntry(entry, prefix),
  );
  const parentEntry = group.find((entry) => entry.toolName === prefix);
  const hasSkillHarnessLifecycleParent =
    prefix === "skill-harness" &&
    parentEntry !== undefined &&
    (parentEntry.status !== "pending" ||
      typeof parentEntry.startedAtMs === "number");
  const parentSuffix = group.some((entry) => entry.status === "error")
    ? "✘"
    : hasSkillHarnessLifecycleParent
      ? getSubSuffix(parentEntry.status)
      : realEntries.length
        ? getParentSuffix(realEntries)
        : getParentSuffix(group);
  const parentErrorEntry = group.find(
    (entry) =>
      entry.toolName === prefix && entry.status === "error" && entry.error,
  );
  const nestedTools = displayedTools.map((entry) =>
    createNestedToolNode(entry, prefix, sourceIndexes.get(entry) ?? 0),
  );
  const nodes = nestedTools.map(({ node }) => node);
  for (const resultEntry of resultEntries) {
    const resultFields =
      prefix === "skill-harness"
        ? getSkillHarnessResultFields(resultEntry)
        : formatDisplayFields({ result: resultEntry.params?.text });
    for (const [index, row] of packMainFields(resultFields).entries()) {
      nodes.push(
        createFieldNode(row, 1, sourceIndexes.get(resultEntry) ?? 0, index),
      );
    }
  }
  if (parentErrorEntry?.error) {
    const matchingChildError = nestedTools.find(
      ({ errorNode }, index) =>
        errorNode && displayedTools[index].error === parentErrorEntry.error,
    )?.errorNode;
    for (const [index, row] of packMainFields(
      formatDisplayFields({ error: parentErrorEntry.error }),
    ).entries()) {
      const parentErrorNode = createFieldNode(
        row,
        3,
        sourceIndexes.get(parentErrorEntry) ?? 0,
        index,
      );
      parentErrorNode.suppressedBy = matchingChildError;
      nodes.push(parentErrorNode);
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
    sourceIndex: Math.min(
      ...group.map((entry) => sourceIndexes.get(entry) ?? 0),
    ),
    collapseChildrenAtomically: true,
  };
}

function createEntryBlock(t: ToolEntry, sourceIndex: number): StatusBlock {
  const icon = getToolIcon(t.toolName);
  const toolName = sanitizeHeaderToken(getDisplayToolName(t.toolName));
  const suffix = getSubSuffix(t.status);
  const { nodes } = createEntryFieldNodes(t, 2, sourceIndex);
  return {
    header: {
      icon,
      name: toolName,
      nameStyle: ANSI.boldCyan,
      status: suffix,
      statusStyle: getStatusStyle(t.status),
      durationMs: t.durationMs,
    },
    children: nodes,
    sourceIndex,
  };
}

function createMainAgentFailureBlock(
  entry: ToolEntry,
  sourceIndex: number,
): StatusBlock {
  const header: StatusHeader = {
    icon: "💥",
    name: "agent",
    nameStyle: ANSI.boldBlue,
    status: "✘",
    statusStyle: ANSI.red,
    compressibleName: false,
  };
  if (!entry.error) return { header, children: [], sourceIndex };
  const rows = packMainFields(formatDisplayFields({ error: entry.error }));
  return {
    header,
    children: rows.map((row, index) =>
      createFieldNode(row, 3, sourceIndex, index),
    ),
    sourceIndex,
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

function getOmissionMarker(omittedLineCount: number): string {
  if (omittedLineCount <= 0) return "";
  const unit = omittedLineCount === 1 ? "line" : "lines";
  return ansiSpan(ANSI.lightGray, `(+${omittedLineCount} ${unit})`);
}

function renderBlocks(
  blocks: readonly StatusBlock[],
  removed: ReadonlySet<StatusNode>,
  omittedLineCount: number,
  headerOverrides?: readonly string[],
  collapsedBlocks: ReadonlySet<StatusBlock> = new Set(),
): string {
  const body = getRenderedBodyLines(
    blocks,
    removed,
    headerOverrides,
    collapsedBlocks,
  );
  const marker = getOmissionMarker(omittedLineCount);
  if (marker) body.push(marker);
  return `${OPENING_FENCE}${body.join("\n")}${CLOSING_FENCE}`;
}

function getRenderedBodyLines(
  blocks: readonly StatusBlock[],
  removed: ReadonlySet<StatusNode>,
  headerOverrides?: readonly string[],
  collapsedBlocks: ReadonlySet<StatusBlock> = new Set(),
): string[] {
  return blocks.flatMap((block, index) => [
    ...(index > 0 ? [""] : []),
    headerOverrides?.[index] ??
      renderStatusHeader(block.header, {
        collapsed: collapsedBlocks.has(block),
      }),
    ...(collapsedBlocks.has(block)
      ? []
      : renderStatusNodes(block.children, removed)),
  ]);
}

function countNonblankLines(lines: readonly string[]): number {
  return lines.filter((line) =>
    line.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").trim(),
  ).length;
}

function collectRemovalCandidates(
  blocks: readonly StatusBlock[],
): Array<{ block: StatusBlock; node: StatusNode }> {
  const candidates: Array<{
    block: StatusBlock;
    node: StatusNode;
    traversalOrder: number;
  }> = [];
  let traversalOrder = 0;
  const visit = (block: StatusBlock, node: StatusNode) => {
    candidates.push({ block, node, traversalOrder });
    traversalOrder += 1;
    node.children.forEach((child) => visit(block, child));
  };
  for (const block of blocks) {
    block.children.forEach((node) => visit(block, node));
  }
  return candidates
    .sort(
      (a, b) =>
        a.node.priority - b.node.priority ||
        a.node.sourceIndex - b.node.sourceIndex ||
        a.node.fieldIndex - b.node.fieldIndex ||
        a.traversalOrder - b.traversalOrder,
    )
    .map(({ block, node }) => ({ block, node }));
}

function truncateHeaderName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  if (maxLength <= 1) return "…";
  let retained = "";
  for (const character of name) {
    if (retained.length + character.length > maxLength - 1) break;
    retained += character;
  }
  return `${retained}…`;
}

type EmergencyHeader = {
  block: StatusBlock;
  collapsed: boolean;
  includeDuration: boolean;
  name: string;
};

function renderHeaderOnly(
  headers: readonly EmergencyHeader[],
  baselineLineCount: number,
): string {
  const body = headers.flatMap((header, index) => [
    ...(index > 0 ? [""] : []),
    renderStatusHeader(header.block.header, {
      collapsed: header.collapsed,
      includeDuration: header.includeDuration,
      name: header.name,
    }),
  ]);
  const marker = getOmissionMarker(baselineLineCount - headers.length);
  if (marker) body.push(marker);
  return `${OPENING_FENCE}${body.join("\n")}${CLOSING_FENCE}`;
}

function renderEmergencyHeaders(
  blocks: readonly StatusBlock[],
  baselineLineCount: number,
  maxLength: number,
  collapsedBlocks: ReadonlySet<StatusBlock>,
): string {
  const headers: EmergencyHeader[] = blocks.map((block) => ({
    block,
    collapsed: collapsedBlocks.has(block),
    includeDuration: true,
    name: block.header.name,
  }));
  let rendered = renderHeaderOnly(headers, baselineLineCount);

  if (rendered.length > maxLength) {
    headers.forEach((header) => {
      header.includeDuration = false;
    });
    rendered = renderHeaderOnly(headers, baselineLineCount);
  }

  while (rendered.length > maxLength) {
    const oldestCompressible = headers
      .map((header, index) => ({ header, index }))
      .filter(({ header }) => header.block.header.compressibleName !== false)
      .sort(
        (a, b) =>
          a.header.block.sourceIndex - b.header.block.sourceIndex ||
          b.header.name.length - a.header.name.length,
      )[0];
    if (
      !oldestCompressible ||
      [...oldestCompressible.header.name].length <= 1
    ) {
      break;
    }
    const overflow = rendered.length - maxLength;
    const target = Math.max(
      1,
      oldestCompressible.header.name.length - overflow,
    );
    const truncated = truncateHeaderName(
      oldestCompressible.header.name,
      target,
    );
    oldestCompressible.header.name =
      truncated.length < oldestCompressible.header.name.length
        ? truncated
        : truncateHeaderName(
            oldestCompressible.header.name,
            oldestCompressible.header.name.length - 1,
          );
    rendered = renderHeaderOnly(headers, baselineLineCount);
  }

  while (rendered.length > maxLength && headers.length > 0) {
    const oldest =
      headers
        .map((header, index) => ({ header, index }))
        .filter(({ header }) => header.block.header.compressibleName !== false)
        .sort(
          (a, b) => a.header.block.sourceIndex - b.header.block.sourceIndex,
        )[0]?.index ?? 0;
    headers.splice(oldest, 1);
    rendered = renderHeaderOnly(headers, baselineLineCount);
  }

  if (rendered.length <= maxLength) return rendered;
  return `${OPENING_FENCE}${CLOSING_FENCE}`;
}

const MAX_ITERATIVE_BOUNDING_NODES = 256;

function renderBoundedStatus(
  blocks: readonly StatusBlock[],
  requestedMaxLength: number,
): string {
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
  const removed = new Set<StatusNode>();
  const collapsedBlocks = new Set<StatusBlock>();
  const candidates = collectRemovalCandidates(blocks);
  const applyRemovalCandidate = (candidate: (typeof candidates)[number]) => {
    if (collapsedBlocks.has(candidate.block)) return 0;
    if (!isStatusNodeVisible(candidate.node, removed)) return 0;
    if (candidate.block.collapseChildrenAtomically) {
      const removedNodeCount = candidates.filter(
        ({ block, node }) =>
          block === candidate.block && isStatusNodeVisible(node, removed),
      ).length;
      collapsedBlocks.add(candidate.block);
      return removedNodeCount;
    }
    removed.add(candidate.node);
    return 1;
  };
  let batchRemovals = Math.max(
    0,
    candidates.length - MAX_ITERATIVE_BOUNDING_NODES,
  );
  for (const candidate of candidates) {
    if (batchRemovals === 0) break;
    batchRemovals = Math.max(
      0,
      batchRemovals - applyRemovalCandidate(candidate),
    );
  }

  const renderCurrent = () => {
    const baselineLineCount = countNonblankLines(
      getRenderedBodyLines(blocks, new Set(), undefined, collapsedBlocks),
    );
    const currentLineCount = countNonblankLines(
      getRenderedBodyLines(blocks, removed, undefined, collapsedBlocks),
    );
    return renderBlocks(
      blocks,
      removed,
      baselineLineCount - currentLineCount,
      undefined,
      collapsedBlocks,
    );
  };
  let rendered = renderCurrent();

  for (const candidate of candidates) {
    if (rendered.length <= maxLength) return rendered;
    if (applyRemovalCandidate(candidate) === 0) continue;
    rendered = renderCurrent();
  }

  if (rendered.length <= maxLength) return rendered;
  const baselineLineCount = countNonblankLines(
    getRenderedBodyLines(blocks, new Set(), undefined, collapsedBlocks),
  );
  return renderEmergencyHeaders(
    blocks,
    baselineLineCount,
    maxLength,
    collapsedBlocks,
  );
}

export function renderStatusContent(
  toolHistory: readonly ToolEntry[],
  _isFinal: boolean,
  maxLength = STATUS_MAX_LENGTH,
): string {
  const contentParts: StatusBlock[] = [];
  const sourceIndexes = new Map(
    toolHistory.map((entry, index) => [entry, index] as const),
  );
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
    contentParts.push(
      renderSubagentGroup(
        group.name === "active-memory" ? "🧩" : "💡",
        group.name,
        group.entries,
        sourceIndexes,
      ),
    );
  }

  const mainAgentFailure = toolHistory.filter(isMainAgentEntry).at(-1);
  if (mainAgentFailure?.status === "error") {
    contentParts.push(
      createMainAgentFailureBlock(
        mainAgentFailure,
        sourceIndexes.get(mainAgentFailure) ?? 0,
      ),
    );
  }

  for (const entry of normalEntries) {
    contentParts.push(createEntryBlock(entry, sourceIndexes.get(entry) ?? 0));
  }

  return renderBoundedStatus(contentParts, maxLength);
}

export function isContentTooLong(
  content: string,
  _entryCount: number,
): boolean {
  return content.length > STATUS_MAX_LENGTH;
}
