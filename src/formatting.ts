import { sanitizeInlineText, sanitizeVisibleText } from "./ansi.js";

export function getToolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("__")) return "🔗";

  // Web & Communication
  if (n.includes("browser")) return "🌎";
  if (n.includes("web_search")) return "🔎";
  if (n.includes("web_fetch")) return "📥";
  if (n.includes("message")) return "✉️";

  // File Operations (Read, Write, Edit, Patch, Diff)
  if (n.includes("read")) return "📄";
  if (n.includes("write")) return "✍️";
  if (n.includes("edit")) return "✂️";
  if (n.includes("apply_patch")) return "📝";
  if (n.includes("diff")) return "🔀";

  // Media & Formats
  if (n.includes("image")) return "🖼️";
  if (n.includes("pdf")) return "📜";
  if (n.includes("tts")) return "🔊";

  // Execution & Process
  if (n.includes("exec")) return "🚀";
  if (n.includes("process")) return "⏳";
  if (n.includes("compaction")) return "🗜️";

  // Knowledge, Memory & Wiki
  if (n.includes("memory")) return "🧠";
  if (n.includes("wiki")) {
    if (n.includes("search")) return "📖";
    if (n.includes("apply")) return "📋";
    if (n.includes("lint")) return "🧹";
    if (n.includes("status")) return "📊";
    return "📚";
  }

  // Session & Agent management
  if (n.includes("session")) {
    if (n.includes("history")) return "🗿";
    if (n.includes("list")) return "🛰️";
    if (n.includes("send")) return "🛸";
    if (n.includes("yield")) return "🏁";
    return "💬";
  }
  if (n.includes("agent")) return "👥";

  // Skill management
  if (n.includes("skill_")) {
    if (n.includes("search")) return "🪃";
    if (n.includes("view")) return "🔧";
    if (n.includes("manage")) return "🛠️";
    if (n.includes("list")) return "🛒";
    return "🎯";
  }

  // Goal management (create_goal, update_goal)
  if (n.includes("_goal")) return "🪧";

  // Plan management (update_plan)
  if (n.includes("_plan")) return "🔖";

  // Scheduling & Infrastructure
  if (n.includes("cron")) return "⏰";
  if (n.includes("gateway")) return "🧱";
  if (n.includes("nodes")) return "🔌";

  return "⚙️";
}

const SINGLE_LINE_DISPLAY_LIMIT = 70;

export type DisplayField = {
  key: string;
  value: string;
  multilineLines?: string[];
  omittedHint?: string;
  truncated: boolean;
  compactEligible: boolean;
};

function serializeDisplayValue(value: unknown): string {
  if (typeof value === "string") return value || '""';
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

function omissionHint(count: number): string {
  return ` (+${count} ${count === 1 ? "char" : "chars"})`;
}

function formatDisplayValue(
  value: unknown,
): Pick<
  DisplayField,
  "value" | "multilineLines" | "omittedHint" | "truncated"
> & { isMultiline: boolean } {
  let serialized = serializeDisplayValue(value);
  if (typeof value === "string") {
    serialized = serialized.trimEnd();
  }
  const sourceValue = sanitizeVisibleText(serialized)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const sourceIsMultiline =
    typeof value === "string" && sourceValue.trim().includes("\n");
  const sourceCharacters = [
    ...(sourceIsMultiline
      ? sourceValue.replaceAll("\t", "\\t")
      : sanitizeInlineText(sourceValue)),
  ];
  const retainedCharacters = sourceCharacters.slice(
    0,
    SINGLE_LINE_DISPLAY_LIMIT,
  );
  const omitted = sourceCharacters.length - retainedCharacters.length;
  const retainedValue = retainedCharacters.join("");
  const suffix = omitted > 0 ? "..." : "";

  if (sourceIsMultiline) {
    const multilineLines = retainedValue.split("\n");
    multilineLines[multilineLines.length - 1] += suffix;
    return {
      value: "|",
      multilineLines,
      omittedHint: omitted > 0 ? omissionHint(omitted) : undefined,
      truncated: omitted > 0,
      isMultiline: true,
    };
  }

  return {
    value: `${retainedValue}${suffix}`,
    omittedHint: omitted > 0 ? omissionHint(omitted) : undefined,
    truncated: omitted > 0,
    isMultiline: false,
  };
}

function isPathField(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes("path") || k === "cwd" || k === "dir" || k === "directory";
}

function getSortWeight(key: string): number {
  const k = key.toLowerCase();
  if (isPathField(key)) return 1;
  if (k === "command") return 2;
  if (k === "topic") return 3;
  if (k === "result") return 4;
  if (k === "error") return 5;
  return 0;
}

export function formatDisplayFields(
  params: unknown,
  options: { toolName?: string } = {},
): DisplayField[] {
  if (!params || typeof params !== "object") return [];

  const fields = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([rawKey, value]) => {
      const { isMultiline, ...formatted } = formatDisplayValue(value);
      const key = sanitizeInlineText(rawKey);
      const width = [
        ...`${key}: ${formatted.value}${formatted.omittedHint ?? ""}`,
      ].length;
      return {
        key,
        ...formatted,
        compactEligible: !isMultiline && width <= 34,
      };
    });

  fields.sort((a, b) => {
    const wA = getSortWeight(a.key);
    const wB = getSortWeight(b.key);
    if (wA !== wB) return wA - wB;
    return a.key.localeCompare(b.key, "en");
  });

  return fields;
}

const MULTILINE_PARAM_MAX_CHARACTERS = 750;
const SINGLE_LINE_PARAM_MAX_CHARACTERS = 150;

function truncateWithOmittedCount(
  value: string,
  maxCharacters: number,
): string {
  const characters = [...value];
  if (characters.length <= maxCharacters) return value;

  const omittedCount = characters.length - maxCharacters;
  const unit = omittedCount === 1 ? "char" : "chars";
  return `${characters.slice(0, maxCharacters).join("")}... ${omittedCount} ${unit} more`;
}

function shouldQuoteYamlString(value: string): boolean {
  return (
    value === "" ||
    value.includes(":") ||
    value.includes("#") ||
    value !== value.trim() ||
    /^[`@*&!|>{}\[\]%,?'"-]/.test(value) ||
    /^(?:yes|no|on|off|true|false|null|~|\.inf|-\.inf|\.nan)$/i.test(value) ||
    /^[-+]?(?:0x[0-9a-f]+|0o[0-7]+|0[0-7]+)$/i.test(value) ||
    /^[-+]?(?:\d+|\d+\.\d+|\.\d+)(?:e[-+]?\d+)?$/i.test(value)
  );
}

function formatYamlScalar(value: string): string {
  return shouldQuoteYamlString(value) ? JSON.stringify(value) : value;
}

export function formatParams(
  params: any,
  indent?: { first: string; rest: string },
): string {
  if (!params || typeof params !== "object") return "";
  const firstPrefix = indent?.first ?? "   - ";
  const restPrefix = indent?.rest ?? "     ";
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v], index) => {
      const keyPrefix = index === 0 ? firstPrefix : restPrefix;
      const valueIndent = " ".repeat(keyPrefix.length + 2);
      let val =
        typeof v === "string" ||
        (Array.isArray(v) && v.every((x) => typeof x === "string"))
          ? typeof v === "string"
            ? v
            : JSON.stringify(v)
          : JSON.stringify(v, null, 5);
      val = val.trim();

      if (val.includes("\n")) {
        const displayVal = truncateWithOmittedCount(
          val,
          MULTILINE_PARAM_MAX_CHARACTERS,
        );
        const lines = displayVal
          .split("\n")
          .map((line) => `${valueIndent}${line.replaceAll(/:/g, "：")}`)
          .join("\n");
        return `${keyPrefix}${k}: |\n${lines}`;
      } else {
        val = truncateWithOmittedCount(val, SINGLE_LINE_PARAM_MAX_CHARACTERS);
        if (typeof v === "string") val = formatYamlScalar(val);
        return `${keyPrefix}${k}: ${val}`;
      }
    })
    .join("\n")
    .replaceAll(/`/g, "ˋ");
}
