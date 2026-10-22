import {
  ANSI,
  ansiSpan,
  sanitizeInlineText,
  sanitizeVisibleText,
} from "./ansi.js";
import { formatDisplayFields } from "./formatting.js";
import type { ToolEntry } from "./types.js";

// Structurally shared with the renderer's semantic tree; no raw tool data escapes here.
export type DecisionDisplayNode = {
  text: string;
  continuationLines: string[];
  children: DecisionDisplayNode[];
  isQuestion?: boolean;
};

type RecordValue = Record<string, unknown>;

/** Normalize nested string values before serialization and ordinary field trimming. */
function stateDisplayValue(value: unknown): unknown {
  const singleLine = (text: string) =>
    sanitizeVisibleText(text).replace(/\s*[\r\n]+\s*/g, " ");
  if (typeof value === "string") return singleLine(value);
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value, (_key, nested: unknown) =>
        typeof nested === "string" ? singleLine(nested) : nested,
      );
    } catch {
      return "[unserializable]";
    }
  }
  return value;
}

export function createDecisionStateLines(entry: ToolEntry): string[] {
  const state = record(entry.params)?.state;
  let objectState = record(state);
  if (typeof state === "string") {
    try {
      objectState = record(JSON.parse(state));
    } catch {
      // Plain text and malformed JSON keep their original single-row display.
    }
  }
  const fields: [string | undefined, unknown][] = objectState
    ? Object.entries(objectState)
    : [[undefined, state]];
  return fields.flatMap(([key, value]) => {
    const normalized = stateDisplayValue(value);
    if (!hasText(normalized)) return [];
    const label = key === undefined ? "" : `${sanitizeInlineText(key)}: `;
    const field = formatDisplayFields({
      value: `${label}${String(normalized)}`,
    })[0];
    const hint = field.omittedHint
      ? ansiSpan(ANSI.lightGray, field.omittedHint)
      : "";
    return [`    ≡ ${field.value}${hint}`];
  });
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function hasText(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || sanitizeVisibleText(value).trim() !== "")
  );
}

/** Reuse ordinary fields' sanitization, multiline preservation and 70-code-point limit. */
function valueNode(
  value: unknown,
  fallback: string,
  style: string = ANSI.green,
  prefix = "",
): DecisionDisplayNode {
  let displayValue = hasText(value) ? value : fallback;
  if (displayValue !== null && typeof displayValue === "object") {
    try {
      displayValue = JSON.stringify(displayValue, (_key, nested: unknown) =>
        typeof nested === "string" ? sanitizeVisibleText(nested) : nested,
      );
    } catch {
      // Ordinary formatting supplies a safe fallback for non-JSON values.
    }
  }
  const field =
    formatDisplayFields({ value: displayValue })[0] ??
    formatDisplayFields({ value: hasText(fallback) ? fallback : "?" })[0];
  const lines = field.multilineLines ?? [field.value];
  const rendered = lines.map((line, index) =>
    ansiSpan(style, `${index === 0 ? prefix : ""}${line}`),
  );
  if (field.omittedHint) {
    rendered[rendered.length - 1] += ansiSpan(
      ANSI.lightGray,
      field.omittedHint,
    );
  }
  return {
    text: rendered[0],
    continuationLines: rendered.slice(1),
    children: [],
  };
}

function append(node: DecisionDisplayNode, text: string): void {
  if (node.continuationLines.length) {
    node.continuationLines[node.continuationLines.length - 1] += text;
  } else {
    node.text += text;
  }
}

function fieldNode(key: string, value: unknown): DecisionDisplayNode {
  const node = valueNode(value, "未提供描述");
  const label = valueNode(key, "?");
  const labelText = sanitizeVisibleText(
    [label.text, ...label.continuationLines].join(" "),
  );
  node.text = `${ansiSpan(key === "error" ? ANSI.red : ANSI.magenta, `${labelText}:`)} ${node.text}`;
  return node;
}

/** Explicit wrapper payloads are authoritative, even when invalid or unavailable. */
function readOutcome(value: unknown, depth = 0): RecordValue | undefined {
  const obj = record(value);
  if (!obj || depth > 3 || obj.isError === true) return;
  if (obj.status === "ok" || obj.status === "unavailable") return obj;
  if (Object.hasOwn(obj, "details")) return readOutcome(obj.details, depth + 1);
  if (Object.hasOwn(obj, "structuredContent")) {
    return readOutcome(obj.structuredContent, depth + 1);
  }
  if (!Array.isArray(obj.content)) return;
  for (const item of obj.content) {
    const block = record(item);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = record(JSON.parse(block.text));
      if (parsed?.status === "ok" || parsed?.status === "unavailable")
        return parsed;
    } catch {
      // Tool text is not necessarily JSON; never treat it as an answer itself.
    }
  }
}

function probability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function criteriaFor(question: RecordValue): [string, unknown][] {
  if (question.type === "boolean") {
    const criteria = record(question.criteria);
    return [
      ["true", criteria?.true],
      ["false", criteria?.false],
    ];
  }
  if (question.type === "choice")
    return Object.entries(record(question.criteria) ?? {});
  if (question.type === "score" && Array.isArray(question.criteria)) {
    return Array.from(question.criteria, (description, index) => [
      String(index),
      description,
    ]);
  }
  return [];
}

function validAnswer(
  question: RecordValue,
  value: unknown,
  criteria: [string, unknown][],
): RecordValue | undefined {
  const answer = record(value);
  if (!answer || answer.type !== question.type) return;
  if (question.type === "boolean")
    return probability(answer.probabilityTrue) ? answer : undefined;
  if (criteria.length < 2) return;
  if (question.type === "choice") {
    const probabilities = record(answer.probabilities);
    if (
      typeof answer.choice !== "string" ||
      !criteria.some(([key]) => key === answer.choice) ||
      !probabilities
    )
      return;
    if (
      Object.keys(probabilities).length !== criteria.length ||
      !Object.values(probabilities).some(
        (value) => probability(value) && value > 0,
      ) ||
      criteria.some(
        ([key]) =>
          !Object.hasOwn(probabilities, key) ||
          !probability(probabilities[key]),
      )
    )
      return;
    return answer;
  }
  if (question.type === "score") {
    if (
      typeof answer.score !== "number" ||
      !Number.isFinite(answer.score) ||
      answer.score < 0 ||
      answer.score > criteria.length - 1
    )
      return;
    if (
      !Array.isArray(answer.probabilities) ||
      answer.probabilities.length !== criteria.length ||
      !answer.probabilities.some((value) => probability(value) && value > 0) ||
      criteria.some(
        (_, index) => !probability((answer.probabilities as unknown[])[index]),
      )
    )
      return;
    return answer;
  }
}

export function createDecisionDisplayNodes(
  entry: ToolEntry,
): DecisionDisplayNode[] {
  const questions = record(record(entry.params)?.questions);
  const outcome =
    entry.status === "pending" || entry.status === "error"
      ? undefined
      : readOutcome(entry.result);
  const answers =
    outcome?.status === "ok"
      ? record(record(outcome.result)?.answers)
      : undefined;
  const unavailable = outcome?.status === "unavailable";
  const missing =
    entry.status === "pending"
      ? "等待結果…"
      : entry.status === "error"
        ? "評估失敗"
        : unavailable
          ? "無法評估"
          : "結果未提供";
  const nodes = Object.entries(questions ?? {}).map(([id, rawQuestion]) => {
    const question = record(rawQuestion) ?? {};
    const node = valueNode(question.instructions, id, ANSI.yellow, "» ");
    node.isQuestion = true;
    const criteria = criteriaFor(question);
    const answer = validAnswer(
      question,
      answers && Object.hasOwn(answers, id) ? answers[id] : undefined,
      criteria,
    );
    if (answer?.type === "choice") {
      const selected = valueNode(answer.choice, "?");
      append(
        node,
        ` → ${[selected.text, ...selected.continuationLines].join(" ")}`,
      );
    } else if (answer?.type === "score") {
      append(
        node,
        ` → ${ansiSpan(ANSI.magenta, "score:")} ${ansiSpan(ANSI.green, `${(answer.score as number).toFixed(2)} / ${criteria.length - 1}`)}`,
      );
    }
    node.children = criteria.map(([key, description], index) => {
      const child = fieldNode(key, description);
      let value: unknown;
      if (answer?.type === "boolean") {
        value =
          index === 0
            ? answer.probabilityTrue
            : 1 - (answer.probabilityTrue as number);
      } else if (answer?.type === "choice") {
        value = record(answer.probabilities)?.[key];
      } else if (answer?.type === "score") {
        value = (answer.probabilities as unknown[])[index];
      }
      append(
        child,
        ` → ${ansiSpan(ANSI.green, probability(value) ? percent(value) : missing)}`,
      );
      return child;
    });
    if (!criteria.length) node.children.push(valueNode(missing, missing));
    return node;
  });
  if (!nodes.length) nodes.push(valueNode(missing, missing));
  if (unavailable)
    nodes.push(fieldNode("reason", outcome.reason ?? "未提供原因"));
  if (entry.status === "error" && entry.error)
    nodes.push(fieldNode("error", entry.error));
  return nodes;
}
