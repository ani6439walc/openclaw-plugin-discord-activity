export const ANSI = {
  reset: "\u001b[0m",
  boldBlue: "\u001b[1;34m",
  blue: "\u001b[34m",
  boldCyan: "\u001b[1;36m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  gray: "\u001b[30m",
  lightGray: "\u001b[37m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
} as const;

export function ansiSpan(style: string, text: string): string {
  return `${style}${text}${ANSI.reset}`;
}

export function sanitizeVisibleText(value: string): string {
  return value
    .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\u001b", "")
    .replaceAll(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g,
      "",
    )
    .replaceAll("`", "ˋ");
}

export function sanitizeInlineText(value: string): string {
  return sanitizeVisibleText(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n");
}
