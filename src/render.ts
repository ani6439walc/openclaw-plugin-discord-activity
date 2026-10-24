import type {
  StatefulStatusRenderResult,
  StatusBlockDisplayLevel,
  StatusDisplayState,
  ToolEntry,
} from "./types.js";
import {
  getToolIcon,
  formatDisplayFields,
  extractToolIntent,
  type DisplayField,
} from "./formatting.js";
import { ANSI, ansiSpan, sanitizeVisibleText } from "./ansi.js";
import {
  createDecisionDisplayNodes,
  createDecisionStateLines,
  type DecisionDisplayNode,
} from "./decision-display.js";
import {
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  STATUS_MAX_ENTRIES,
  STATUS_MAX_SUBAGENT_ENTRIES,
} from "./constants.js";
import { canonicalToolNameForDedupe, getDisplayToolName } from "./tool-name.js";

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
  if (prefix === "hindsight-memory") return parentEntry;
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
  const parentEntry = findLastEntry(
    group,
    (entry) => entry.toolName === prefix,
  );
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
    return `${ansiSpan(keyStyle, field.key)} |`;
  }
  const value = ansiSpan(ANSI.green, field.value);
  const hint = field.omittedHint
    ? ansiSpan(ANSI.lightGray, field.omittedHint)
    : "";
  return `${ansiSpan(keyStyle, field.key)} ${value}${hint}`;
}

function getDisplayFieldWidth(field: DisplayField, separator = " "): number {
  return [...`${field.key}${separator}${field.value}${field.omittedHint ?? ""}`]
    .length;
}

function packMainFields(
  fields: readonly DisplayField[],
  separator = " ",
): DisplayField[][] {
  const compactFields: DisplayField[] = [];
  const ordinaryFields: DisplayField[] = [];

  for (const field of fields) {
    if (field.compactEligible && getDisplayFieldWidth(field, separator) <= 34) {
      compactFields.push(field);
    } else {
      ordinaryFields.push(field);
    }
  }

  const rows: DisplayField[][] = [];
  let currentRow: DisplayField[] = [];
  let currentWidth = 0;
  for (const field of compactFields) {
    const fieldWidth = getDisplayFieldWidth(field, separator);
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
  options?: { excludeKeys?: readonly string[]; valueLimit?: number },
): StatusNode[] {
  const nodes = packMainFields(
    formatDisplayFields(entry.params, {
      excludeKeys: options?.excludeKeys,
      valueLimit: options?.valueLimit,
    }),
  ).map(createFieldNode);

  if (
    entry.status === "error" &&
    entry.error &&
    entry.params?.error !== entry.error
  ) {
    const errorRows = packMainFields(
      formatDisplayFields(
        { error: entry.error },
        { valueLimit: options?.valueLimit },
      ),
    );
    nodes.push(...errorRows.map(createFieldNode));
  }
  return nodes;
}

export const SUBAGENT_GROUP_NAMES = [
  "skill-harness",
  "hindsight-memory",
] as const;

export type InternalGroupName = (typeof SUBAGENT_GROUP_NAMES)[number];

function getSubagentGroupIcon(prefix: InternalGroupName): string {
  if (prefix === "skill-harness") return "💡";
  if (prefix === "hindsight-memory") return "🧠";
  return getToolIcon(prefix);
}

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
  collapsedName?: string;
};

type StatusNode = {
  text: string;
  continuationLines: string[];
  children: StatusNode[];
};

type StatusBlock = {
  key: string;
  header: StatusHeader;
  summaryLine?: string;
  children: StatusNode[];
  bodyLines?: string[];
  compactBodyLines?: string[];
  previewUnits?: (compact: boolean) => string[][];
  protected?: boolean;
};

function sanitizeHeaderToken(value: string): string {
  return sanitizeVisibleText(value).replaceAll(/[\r\n\t]+/gu, " ");
}

function formatCollapsedTitle(title: string, maxLength = 32): string {
  const chars = [...title];
  if (chars.length <= maxLength) return title;
  return `${chars.slice(0, maxLength).join("")}...`;
}

function formatExpandedTitle(title: string, maxLength = 120): string {
  const chars = [...title];
  if (chars.length <= maxLength) return title;
  return `${chars.slice(0, maxLength).join("")}...`;
}

function renderStatusHeader(header: StatusHeader, collapsed = false): string {
  const name =
    collapsed && header.collapsedName ? header.collapsedName : header.name;
  const label = name ? `${header.icon} ${name}` : header.icon;
  const duration =
    typeof header.durationMs === "number"
      ? formatDurationBadge(header.durationMs)
      : "";
  const disclosure = header.disclosure
    ? ` ${ansiSpan(ANSI.lightGray, collapsed ? "▸" : "▾")}`
    : "";
  const status = header.status
    ? ` ${ansiSpan(header.statusStyle, header.status)}`
    : "";
  return `${ansiSpan(header.nameStyle, label)}${disclosure}${status}${duration}`;
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
  return nodes.flatMap((node, index) =>
    renderStatusNode(node, index === nodes.length - 1, prefix),
  );
}

function renderStatusNode(
  node: StatusNode,
  isLast: boolean,
  prefix = ROOT_TREE_PREFIX,
): string[] {
  const connector = isLast ? "╰─" : "├─";
  const childPrefix = `${prefix}${isLast ? "    " : " │  "}`;
  return [
    `${prefix} ${connector} ${node.text}`,
    ...node.continuationLines.map((line) => `${childPrefix} ${line}`),
    ...renderStatusNodes(node.children, childPrefix),
  ];
}

function createDecisionPreviewUnits(
  nodes: readonly DecisionDisplayNode[],
): string[][] {
  return nodes.flatMap((node) => {
    if (!node.isQuestion || node.children.length === 0)
      return [renderDecisionNodes([node])];
    // Keep a question with its first answer, and multiline answers with their probabilities.
    const heading = renderDecisionNodes([{ ...node, children: [] }]);
    return node.children.map((child, index) => [
      ...(index === 0 ? heading : []),
      ...renderStatusNode(child, index === node.children.length - 1),
    ]);
  });
}

function renderDecisionNodes(nodes: readonly DecisionDisplayNode[]): string[] {
  return nodes.flatMap((node) =>
    node.isQuestion
      ? [
          `    ${node.text}`,
          ...node.continuationLines.map((line) => `      ${line}`),
          ...renderStatusNodes(node.children),
        ]
      : renderStatusNodes([node]),
  );
}

function findLastEntry(
  entries: readonly ToolEntry[],
  predicate: (entry: ToolEntry) => boolean,
): ToolEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (predicate(entries[i])) return entries[i];
  }
}

const GROUP_INDENT = "    ";
const GROUP_MARK = "⊹";
/** The header's ←/✔/✘ already states these, so their values are shown without the key. */
const UNLABELED_GROUP_KEYS = new Set(["status", "result", "error"]);

/** Text in Discord's default color unless a style is given. */
function paint(style: string | undefined, text: string): string {
  return style ? ansiSpan(style, text) : text;
}

/**
 * skill-harness, hindsight-memory, and main-agent failure rows: no tree connectors, and a ⊹ mark
 * plus text in Discord's default color, so the bold blue header stands above its details. Error
 * rows use the same mark and alignment, with both the mark and text in red.
 */
function renderGroupFieldRow(
  row: readonly DisplayField[],
  indent = GROUP_INDENT,
): string[] {
  const isError = row.some((field) => field.key === "error");
  const style = isError ? ANSI.red : undefined;
  const mark = `${GROUP_MARK} `;
  const label = (field: DisplayField) =>
    UNLABELED_GROUP_KEYS.has(field.key) ? "" : `${field.key}: `;
  const multiline =
    row.length === 1 && row[0].multilineLines ? row[0] : undefined;
  if (multiline?.multilineLines) {
    const [first = "", ...rest] = multiline.multilineLines;
    const lines = [
      `${indent}${paint(style, `${mark}${label(multiline)}${first}`)}`,
      ...rest.map((line) => `${indent}  ${paint(style, line)}`),
    ];
    if (multiline.omittedHint) {
      lines[lines.length - 1] += ansiSpan(
        ANSI.lightGray,
        multiline.omittedHint,
      );
    }
    return lines;
  }
  const text = row
    .map(
      (field, index) =>
        `${paint(style, `${index === 0 ? mark : ""}${label(field)}${field.value}`)}${
          field.omittedHint ? ansiSpan(ANSI.lightGray, field.omittedHint) : ""
        }`,
    )
    .join(paint(style, " · "));
  return [`${indent}${text}`];
}

/** True when a field still shows something after sanitizing (not only control or escape codes). */
function hasVisibleContent(field: DisplayField): boolean {
  const text = field.multilineLines?.join("\n") ?? field.value;
  return sanitizeVisibleText(text).trim() !== "";
}

function renderGroupFields(
  fields: readonly DisplayField[],
  indent = GROUP_INDENT,
): string[] {
  return packMainFields(fields.filter(hasVisibleContent), ": ").flatMap((row) =>
    renderGroupFieldRow(row, indent),
  );
}

/** An entry's parameters plus its terminal error, unless the parameters already carry it. */
function entryFieldsWithError(entry: ToolEntry): DisplayField[] {
  const fields = formatDisplayFields(entry.params);
  if (
    entry.status === "error" &&
    entry.error &&
    entry.params?.error !== entry.error
  ) {
    fields.push(...formatDisplayFields({ error: entry.error }));
  }
  return fields;
}

function renderGroupNestedTool(entry: ToolEntry, prefix: string): string[] {
  const name = sanitizeHeaderToken(
    getDisplayToolName(entry.toolName.slice(prefix.length + 1)),
  );
  return [
    `${GROUP_INDENT}${GROUP_MARK} ${name} ${ansiSpan(getStatusStyle(entry.status), getSubSuffix(entry.status))}${formatHeaderDuration(entry)}`,
    ...renderGroupFields(entryFieldsWithError(entry), `${GROUP_INDENT}  `),
  ];
}

/** Every non-blank error a group's entries carry, in history order, including both sources. */
function collectGroupErrorMessages(group: readonly ToolEntry[]): string[] {
  const messages: string[] = [];
  for (const entry of group) {
    const candidates = [
      ...(entry.activityErrors ?? []),
      entry.params?.error,
      entry.status === "error" ? entry.error : undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        messages.push(candidate);
      }
    }
  }
  return messages;
}

/**
 * Red error lines with a trailing ✘, one per message as displayed. Messages whose visible text is empty after
 * sanitizing (control or escape sequences only) are dropped, and messages that display alike
 * appear once.
 */
function renderDistinctErrorLines(messages: readonly string[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const message of messages) {
    const rendered = renderGroupFields(formatDisplayFields({ error: message }));
    const visible = sanitizeVisibleText(rendered.join("\n")).trim();
    if (!visible || seen.has(visible)) continue;
    seen.add(visible);
    rendered[rendered.length - 1] += ansiSpan(ANSI.red, " ✘");
    lines.push(...rendered);
  }
  return lines;
}

function renderGroupDetails(
  prefix: InternalGroupName,
  displayedTools: readonly ToolEntry[],
  resultEntries: readonly ToolEntry[],
  parentErrorEntry: ToolEntry | undefined,
): string[] {
  const resultLines = resultEntries.flatMap((resultEntry) =>
    renderGroupFields(
      prefix === "skill-harness"
        ? getSkillHarnessResultFields(resultEntry)
        : formatDisplayFields({ result: resultEntry.params?.text }),
    ),
  );
  const bodyLines = displayedTools.flatMap((entry) =>
    renderGroupNestedTool(entry, prefix),
  );
  bodyLines.push(...resultLines);
  if (
    parentErrorEntry?.error &&
    !displayedTools.some((entry) => entry.error === parentErrorEntry.error) &&
    !bodyLines.some((line) => line.includes(parentErrorEntry.error!))
  ) {
    bodyLines.push(
      ...renderGroupFields(
        formatDisplayFields({ error: parentErrorEntry.error }),
      ),
    );
  }

  return bodyLines;
}

function renderSubagentGroup(
  icon: string,
  prefix: InternalGroupName,
  group: readonly ToolEntry[],
): StatusBlock {
  group = [...group].sort(
    (a, b) => (a.statusSequence ?? 0) - (b.statusSequence ?? 0),
  );
  const realEntries = group.filter((e) => e.toolName.startsWith(`${prefix}:`));
  const displayedTools = realEntries
    .filter((entry) => !isSubagentResultEntry(entry, prefix))
    .slice(-STATUS_MAX_SUBAGENT_ENTRIES);
  const resultEntries = realEntries.filter((entry) =>
    isSubagentResultEntry(entry, prefix),
  );
  const parentEntry = findLastEntry(
    group,
    (entry) => entry.toolName === prefix,
  );
  const authoritativeParent = getAuthoritativeGroupParent(prefix, parentEntry);
  const hasError = group.some(
    (entry) => entry.status === "error" || entry.activityErrors?.length,
  );
  const hasResult = realEntries.some((entry) =>
    isSubagentResultEntry(entry, prefix),
  );
  const isOverallCompleted =
    hasResult || authoritativeParent?.status === "completed";
  const parentSuffix =
    hasError && isOverallCompleted
      ? "♻︎"
      : authoritativeParent
        ? getSubSuffix(authoritativeParent.status)
        : hasError
          ? "✘"
          : realEntries.length
            ? getParentSuffix(realEntries)
            : getParentSuffix(group);
  const parentErrorEntry = group.find(
    (entry) =>
      entry.toolName === prefix && entry.status === "error" && entry.error,
  );
  // Error history stays above the single latest producer status or result.
  const errorLines = renderDistinctErrorLines(collectGroupErrorMessages(group));
  const messageFields = (entry: ToolEntry): DisplayField[] =>
    (isSubagentResultEntry(entry, prefix)
      ? prefix === "skill-harness"
        ? getSkillHarnessResultFields(entry)
        : formatDisplayFields({ result: entry.params?.text })
      : formatDisplayFields(entry.params)
    ).filter((field) => field.key !== "error");
  const currentEntry = findLastEntry(
    group,
    (entry) =>
      (entry.toolName === prefix || isSubagentResultEntry(entry, prefix)) &&
      messageFields(entry).some(hasVisibleContent),
  );
  const currentLines = currentEntry
    ? renderGroupFields(messageFields(currentEntry))
    : [];
  const bodyLines =
    realEntries.length === 0 || parentSuffix === "♻︎"
      ? [...errorLines, ...currentLines]
      : parentSuffix === "✘" && errorLines.length > 0
        ? errorLines
        : renderGroupDetails(
            prefix,
            displayedTools,
            resultEntries,
            parentErrorEntry,
          );

  const parentStatus: ToolEntry["status"] =
    parentSuffix === "✘"
      ? "error"
      : parentSuffix === "♻︎"
        ? "orphan-completed"
        : parentSuffix === "✔"
          ? "completed"
          : "pending";
  const groupDurationMs = getGroupDurationMs(group, prefix);
  return {
    key: `group:${prefix}`,
    header: {
      icon,
      name: sanitizeHeaderToken(prefix),
      nameStyle: ANSI.boldBlue,
      status: parentSuffix,
      statusStyle: getStatusStyle(parentStatus),
      durationMs: groupDurationMs,
      disclosure: true,
    },
    children: [],
    bodyLines,
  };
}

type ProgressCardStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

function isProgressCardEntry(entry: ToolEntry): boolean {
  return canonicalToolNameForDedupe(entry.toolName) === "progress_card";
}

function getProgressCardSteps(value: unknown): ProgressCardStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { step, status } = item as Record<string, unknown>;
    if (
      typeof step !== "string" ||
      !step.trim() ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed")
    ) {
      return [];
    }
    return [{ step: sanitizeVisibleText(step.trim()), status }];
  });
}

function parseProgressMarkdown(value: unknown): {
  ariaLabel?: string;
  summary?: string;
} {
  if (typeof value !== "string") return {};
  const sanitized = sanitizeVisibleText(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const progressMatch = sanitized.match(
    /<progress\b[^>]*\baria-label=(?:"([^"]*)"|'([^']*)')[^>]*>(?:<\/progress>)?/iu,
  );
  const ariaLabel = sanitizeHeaderToken(
    progressMatch?.[1] ?? progressMatch?.[2] ?? "",
  ).trim();
  const summary = sanitized
    .replace(/<progress\b[^>]*>(?:<\/progress>)?/giu, " ")
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/\*\*([^*]+)\*\*|__([^_]+)__/gu, "$1$2")
    .replaceAll(/\*([^*]+)\*|_([^_]+)_/gu, "$1$2")
    .replaceAll(/~~([^~]+)~~/gu, "$1")
    .replaceAll("ˋ", "")
    .replaceAll(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replaceAll(/^\s*(?:[-+*]|\d+[.)])\s+/gmu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return {
    ariaLabel: ariaLabel || undefined,
    summary: summary || undefined,
  };
}
function getProgressGroupDurationMs(
  cards: readonly ToolEntry[],
): number | undefined {
  if (cards.length === 0) return;
  const latest = cards.at(-1);
  if (!latest || latest.status === "pending") return;

  const startedAtMsList = cards
    .map((c) => c.startedAtMs)
    .filter((t): t is number => typeof t === "number");

  if (
    startedAtMsList.length > 0 &&
    typeof latest.startedAtMs === "number" &&
    typeof latest.durationMs === "number"
  ) {
    const firstStart = Math.min(...startedAtMsList);
    const lastEnd = latest.startedAtMs + latest.durationMs;
    return Math.max(0, lastEnd - firstStart);
  }

  if (typeof latest.durationMs === "number") {
    return latest.durationMs;
  }
}

function createProgressCardBlock(
  entry: ToolEntry | undefined,
  history: readonly ToolEntry[] = [],
): StatusBlock | undefined {
  if (!entry) return;
  const params =
    entry.params && typeof entry.params === "object" ? entry.params : {};
  const steps = getProgressCardSteps(params.plan);
  const markdown = parseProgressMarkdown(params.markdown);
  const title =
    typeof params.title === "string" && params.title.trim()
      ? sanitizeHeaderToken(params.title.trim())
      : undefined;
  if (steps.length === 0 && !markdown.summary && !markdown.ariaLabel && !title)
    return;

  const completed = steps.filter((step) => step.status === "completed").length;
  const progressDetail =
    steps.length > 0
      ? `${completed}/${steps.length}`
      : (markdown.ariaLabel ?? title);

  const isAllCompleted =
    steps.length > 0
      ? completed === steps.length
      : entry.status === "completed";

  const cards = history.filter(isProgressCardEntry);
  const totalDurationMs = isAllCompleted
    ? getProgressGroupDurationMs(cards.length > 0 ? cards : [entry])
    : undefined;

  const summary = markdown.summary
    ? [...markdown.summary].slice(0, 240).join("")
    : undefined;
  const omittedSummaryCharacters = markdown.summary
    ? [...markdown.summary].length - [...(summary ?? "")].length
    : 0;
  const detail = progressDetail;
  const summaryLine = summary
    ? `    ${ansiSpan(
        ANSI.yellow,
        `§ ${summary}${
          omittedSummaryCharacters > 0
            ? `… (+${omittedSummaryCharacters} chars)`
            : ""
        }`,
      )}`
    : undefined;
  const planLines = steps.map(({ step, status }) => {
    if (status === "completed") {
      return `    ${ansiSpan(ANSI.green, `✓ ${step}`)}`;
    }
    if (status === "in_progress") {
      return `    → ${step}`;
    }
    return `    ${ansiSpan(ANSI.lightGray, `· ${step}`)}`;
  });

  return {
    key: "progress",
    header: {
      icon: "📋",
      name: detail ? `progress · ${detail}` : "progress",
      nameStyle: ANSI.boldBlue,
      status: "",
      statusStyle: ANSI.lightGray,
      durationMs: totalDurationMs,
    },
    children: [],
    bodyLines: [...(summaryLine ? [summaryLine] : []), ...planLines],
    compactBodyLines: [...(summaryLine ? [summaryLine] : []), ...planLines],
    protected: true,
  };
}

function createEntryBlock(t: ToolEntry): StatusBlock {
  const icon = getToolIcon(t.toolName);
  const toolName = sanitizeHeaderToken(getDisplayToolName(t.toolName));
  const suffix = getSubSuffix(t.status);
  const intent = extractToolIntent(t.params);
  const collapsedName = intent
    ? `${toolName} · ${formatCollapsedTitle(intent.text)}`
    : undefined;
  const summaryLine = intent
    ? `    │${ansiSpan(ANSI.yellow, `› ${formatExpandedTitle(intent.text)}`)}`
    : undefined;
  const isDecision =
    canonicalToolNameForDedupe(t.toolName) === "decision_evaluate";
  const decisionNodes = isDecision ? createDecisionDisplayNodes(t) : undefined;
  const children =
    decisionNodes ??
    createEntryFieldNodes(
      t,
      intent ? { excludeKeys: [intent.key] } : undefined,
    );

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
      collapsedName,
    },
    summaryLine,
    children,
    previewUnits: (compact) => {
      if (decisionNodes) {
        // State can fill the entire budget; previews reserve it for questions and answers.
        return createDecisionPreviewUnits(
          compact ? createDecisionDisplayNodes(t, true) : decisionNodes,
        );
      }
      const previewChildren = compact
        ? createEntryFieldNodes(t, {
            excludeKeys: intent ? [intent.key] : undefined,
            valueLimit: 16,
          })
        : children;
      const summary =
        compact && intent
          ? `    │${ansiSpan(ANSI.yellow, `› ${formatCollapsedTitle(intent.text)}`)}`
          : summaryLine;
      return [
        ...(summary ? [[summary]] : []),
        ...previewChildren.map((node, index) =>
          renderStatusNode(node, index === previewChildren.length - 1),
        ),
      ];
    },
    ...(decisionNodes
      ? {
          bodyLines: [
            ...createDecisionStateLines(t),
            ...renderDecisionNodes(decisionNodes),
          ],
        }
      : {}),
  };
}

function createMainAgentFailureBlock(entry: ToolEntry): StatusBlock {
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
    bodyLines: renderGroupFields(entryFieldsWithError(entry)),
    protected: true,
  };
}

function getSubagentGroupEntries(
  toolHistory: readonly ToolEntry[],
): Array<{ name: InternalGroupName; entries: ToolEntry[] }> {
  const seenGroups: InternalGroupName[] = [];
  const entriesByGroup = new Map<InternalGroupName, ToolEntry[]>();

  for (const entry of toolHistory) {
    for (const name of SUBAGENT_GROUP_NAMES) {
      if (isSubagentToolEntry(entry, name)) {
        let entries = entriesByGroup.get(name);
        if (!entries) {
          entries = [];
          entriesByGroup.set(name, entries);
          seenGroups.push(name);
        }
        entries.push(entry);
        break;
      }
    }
  }

  return seenGroups.map((name) => ({
    name,
    entries: entriesByGroup.get(name)!,
  }));
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
        ...(collapsed
          ? []
          : [
              ...(block.summaryLine ? [block.summaryLine] : []),
              ...(block.bodyLines ?? renderStatusNodes(block.children)),
            ]),
      ];
    });
  return `${OPENING_FENCE}${body.join("\n")}${CLOSING_FENCE}`;
}

function renderBoundedStatus(
  blocks: readonly StatusBlock[],
  requestedMaxLength: number,
  priorState: StatusDisplayState,
  latestToolKey?: string,
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

  const maxLength = Math.min(
    requestedMaxLength,
    DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  );
  const displayState = mergeStatusDisplayStates(priorState);
  const complete = (content: string): StatefulStatusRenderResult => ({
    content,
    displayState: mergeStatusDisplayStates(displayState),
  });
  const renderCurrent = () => renderBlocks(blocks, displayState);

  let content = renderCurrent();
  if (content.length <= maxLength) return complete(content);

  const latest = blocks.find(
    (block) =>
      block.key === latestToolKey &&
      (displayState[block.key] ?? "expanded") === "expanded",
  );

  for (const block of blocks) {
    if (block.protected || !block.header.disclosure) continue;
    if (block === latest) continue;
    if ((displayState[block.key] ?? "expanded") !== "expanded") continue;
    advanceDisplayState(displayState, block.key, "collapsed");
    content = renderCurrent();
    if (content.length <= maxLength) return complete(content);
  }

  if (latest) {
    for (const block of blocks) {
      if (!SUBAGENT_GROUP_NAMES.some((name) => block.key === `group:${name}`))
        continue;
      if (displayState[block.key] === "removed") continue;
      advanceDisplayState(displayState, block.key, "removed");
      content = renderCurrent();
      if (content.length <= maxLength) return complete(content);
    }

    const tryPreview = (): string | undefined => {
      const headerOnly = { ...latest, summaryLine: undefined, bodyLines: [] };
      const fixedLength = renderBlocks(
        blocks.map((block) => (block === latest ? headerOnly : block)),
        displayState,
      ).length;
      const preview = createBoundedPreview(latest, maxLength - fixedLength);
      if (!preview) return;
      latest.summaryLine = undefined;
      latest.bodyLines = preview;
      return renderCurrent();
    };
    const preview = tryPreview();
    if (preview) return complete(preview);

    // Headers and protected content can consume even the smallest useful preview.
    for (const block of blocks) {
      if (
        block.protected ||
        block === latest ||
        displayState[block.key] === "removed"
      )
        continue;
      advanceDisplayState(displayState, block.key, "removed");
      content = renderCurrent();
      if (content.length <= maxLength) return complete(content);
      const preview = tryPreview();
      if (preview) return complete(preview);
    }
    advanceDisplayState(displayState, latest.key, "collapsed");
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

  for (const block of blocks) {
    if (!block.compactBodyLines) continue;
    block.bodyLines = block.compactBodyLines;
    content = renderCurrent();
    if (content.length <= maxLength) return complete(content);
  }

  return complete(
    content.length <= maxLength ? content : `${OPENING_FENCE}${CLOSING_FENCE}`,
  );
}

function createBoundedPreview(
  block: StatusBlock,
  budget: number,
): string[] | undefined {
  const marker = `    ${ansiSpan(ANSI.lightGray, "…")}`;
  let best: { count: number; lines: string[] } | undefined;
  for (const compact of [false, true]) {
    let length = marker.length + 1;
    const lines: string[] = [];
    let count = 0;
    const units = block.previewUnits?.(compact) ?? [];
    for (const unit of units) {
      const unitLength = unit.reduce((sum, line) => sum + line.length + 1, 0);
      if (length + unitLength > budget) break;
      lines.push(...unit);
      length += unitLength;
      count++;
    }
    if (count > 0 && count === units.length) return [...lines, marker];
    if (count > 0 && (!best || count >= best.count)) best = { count, lines };
  }
  return best ? [...best.lines, marker] : undefined;
}

export function renderStatusContentWithState(
  toolHistory: readonly ToolEntry[],
  _isFinal: boolean,
  maxLength = DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  priorState = createDefaultStatusDisplayState(),
): StatefulStatusRenderResult {
  const displayState = mergeStatusDisplayStates(priorState);
  const subagentBlocks = getSubagentGroupEntries(toolHistory).map((group) =>
    renderSubagentGroup(
      getSubagentGroupIcon(group.name),
      group.name,
      group.entries,
    ),
  );
  const progressBlock = createProgressCardBlock(
    toolHistory.filter(isProgressCardEntry).at(-1),
    toolHistory,
  );
  if (progressBlock) {
    // Progress marks the main-agent phase, so preparation status must not reappear.
    for (const name of SUBAGENT_GROUP_NAMES) {
      advanceDisplayState(displayState, `group:${name}`, "removed");
    }
  }
  const normalBlocks = toolHistory
    .filter(
      (entry) =>
        !isProgressCardEntry(entry) &&
        !SUBAGENT_GROUP_NAMES.some((prefix) =>
          isSubagentToolEntry(entry, prefix),
        ) &&
        !isMainAgentEntry(entry),
    )
    .map(createEntryBlock);
  const mainAgentFailure = toolHistory.filter(isMainAgentEntry).at(-1);
  const failureBlock =
    mainAgentFailure?.status === "error"
      ? createMainAgentFailureBlock(mainAgentFailure)
      : undefined;
  const eligibleBlocks = [...subagentBlocks, ...normalBlocks].filter(
    (block) => (displayState[block.key] ?? "expanded") !== "removed",
  );
  const availableSlots =
    STATUS_MAX_ENTRIES - (failureBlock ? 1 : 0) - (progressBlock ? 1 : 0);
  const selectedBlocks = eligibleBlocks.slice(-availableSlots);
  const selectedKeys = new Set(selectedBlocks.map((block) => block.key));
  for (const block of eligibleBlocks) {
    if (!selectedKeys.has(block.key)) {
      advanceDisplayState(displayState, block.key, "removed");
    }
  }

  const result = renderBoundedStatus(
    [
      ...(progressBlock ? [progressBlock] : []),
      ...selectedBlocks,
      ...(failureBlock ? [failureBlock] : []),
    ],
    maxLength,
    displayState,
    normalBlocks.at(-1)?.key,
  );
  if (progressBlock) result.preparationComplete = true;
  return result;
}

export function renderStatusContent(
  toolHistory: readonly ToolEntry[],
  isFinal: boolean,
  maxLength = DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
): string {
  return renderStatusContentWithState(toolHistory, isFinal, maxLength).content;
}
