import { sanitizeInlineText, sanitizeVisibleText } from "./ansi.js";

export function getToolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("web_search")) return "🔎";
  if (n.includes("web_fetch")) return "🗳️";
  if (n.includes("browser")) return "🌎";
  if (n.includes("memory")) return "🧠";
  if (n.includes("wiki")) {
    if (n.includes("search")) return "🕵️";
    if (n.includes("apply")) return "🧱";
    if (n.includes("lint")) return "🧼";
    if (n.includes("status")) return "📡";
    return "📒";
  }
  if (n.includes("context7")) {
    if (n.includes("resolve")) return "🪧";
    return "🗞️";
  }
  if (n.includes("google-developer")) {
    if (n.includes("search") || n.includes("answer")) return "🔭";
    return "📂";
  }
  if (n.includes("read")) return "📖";
  if (n.includes("write")) return "✍️";
  if (n.includes("edit")) return "🛠️";
  if (n.includes("diff")) return "⚖️";
  if (n.includes("exec")) return "🚀";
  if (n.includes("process")) return "⏳";
  if (n.includes("image")) return "🖼️";
  if (n.includes("pdf")) return "📜";
  if (n.includes("message")) return "✉️";
  if (n.includes("session")) {
    if (n.includes("history")) return "🕰️";
    if (n.includes("list")) return "🔖";
    if (n.includes("send")) return "🛸";
    if (n.includes("yield")) return "🏁";
    return "🎬";
  }
  if (n.includes("agent")) return "👥";
  return "⚙️";
}

const SINGLE_LINE_DISPLAY_LIMIT = 70;
const PATH_HEAD_LIMIT = 20;
const PATH_TAIL_LIMIT = 50;

export type DisplayField = {
  key: string;
  value: string;
  multilineLines?: string[];
  omittedHint?: string;
  truncated: boolean;
  compactEligible: boolean;
};

function isPathKey(key: string): boolean {
  return (
    key === "path" ||
    key === "file_path" ||
    key === "filePath" ||
    key === "workdir" ||
    key === "cwd" ||
    /(?:_|-)path$/u.test(key)
  );
}

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

function formatSingleLineValue(
  key: string,
  value: unknown,
): Pick<DisplayField, "value" | "omittedHint" | "truncated"> {
  const serialized = sanitizeInlineText(serializeDisplayValue(value));
  const characters = [...serialized];
  if (characters.length <= SINGLE_LINE_DISPLAY_LIMIT) {
    return { value: serialized, truncated: false };
  }

  if (isPathKey(key)) {
    const omitted = characters.length - PATH_HEAD_LIMIT - PATH_TAIL_LIMIT;
    return {
      value: `${characters.slice(0, PATH_HEAD_LIMIT).join("")}...${characters.slice(-PATH_TAIL_LIMIT).join("")}`,
      omittedHint: omissionHint(omitted),
      truncated: true,
    };
  }

  const omitted = characters.length - SINGLE_LINE_DISPLAY_LIMIT;
  return {
    value: `${characters.slice(0, SINGLE_LINE_DISPLAY_LIMIT).join("")}...`,
    omittedHint: omissionHint(omitted),
    truncated: true,
  };
}

function formatMultilineValue(
  value: string,
): Pick<
  DisplayField,
  "value" | "multilineLines" | "omittedHint" | "truncated"
> {
  const sourceLines = sanitizeVisibleText(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  let omitted = 0;
  const multilineLines = sourceLines.slice(0, 5).map((line) => {
    const characters = [...line];
    const retained = characters.slice(0, 70).join("").replaceAll("\t", "\\t");
    if (characters.length <= 70) return retained;
    omitted += characters.length - 70;
    return `${retained}...`;
  });
  for (const hiddenLine of sourceLines.slice(5)) {
    omitted += [...hiddenLine].length;
  }

  return {
    value: "|",
    multilineLines,
    omittedHint: omitted > 0 ? omissionHint(omitted) : undefined,
    truncated: omitted > 0,
  };
}

export function formatDisplayFields(params: unknown): DisplayField[] {
  if (!params || typeof params !== "object") return [];

  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([rawKey, value]) => {
      const isMultiline =
        typeof value === "string" &&
        (rawKey === "command" || rawKey === "result" || rawKey === "error") &&
        /[\r\n]/u.test(value);
      const formatted = isMultiline
        ? formatMultilineValue(value)
        : formatSingleLineValue(rawKey, value);
      const numericText =
        typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : "";
      return {
        key: sanitizeInlineText(rawKey),
        ...formatted,
        compactEligible:
          !isMultiline &&
          (typeof value === "boolean" ||
            (numericText !== "" && [...numericText].length <= 12)),
      };
    });
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
