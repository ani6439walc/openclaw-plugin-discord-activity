import type { Plugin } from "prettier";
import type { ToolEntry } from "./types.js";

export const MAX_SINGLE_LINE_FORMAT_LENGTH = 8_000;
const PREVIEW_PRINT_WIDTH = 90;

type PrettierBundle = {
  format: (
    source: string,
    options: {
      parser: string;
      plugins: Plugin[];
      printWidth: number;
      tabWidth: number;
    },
  ) => Promise<string>;
  plugins: Plugin[];
};

let prettierBundlePromise: Promise<PrettierBundle> | undefined;

function isFormattableSingleLine(code: string): boolean {
  if (code.length > MAX_SINGLE_LINE_FORMAT_LENGTH) return false;
  const trimmedEnd = code.trimEnd();
  return Boolean(trimmedEnd.trim()) && !/[\r\n\u2028\u2029]/u.test(trimmedEnd);
}

function loadPrettierBundle(): Promise<PrettierBundle> {
  prettierBundlePromise ??= Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
  ])
    .then(([standaloneModule, babelModule, estreeModule]) => {
      const standalone =
        "format" in standaloneModule
          ? standaloneModule
          : (standaloneModule as { default: typeof standaloneModule }).default;
      const babelPlugin = (
        "default" in babelModule ? babelModule.default : babelModule
      ) as Plugin;
      const estreePlugin = (
        "default" in estreeModule ? estreeModule.default : estreeModule
      ) as Plugin;
      return {
        format: standalone.format,
        plugins: [babelPlugin, estreePlugin],
      };
    })
    .catch((error: unknown) => {
      prettierBundlePromise = undefined;
      throw error;
    });
  return prettierBundlePromise;
}

export async function formatCodeModePreviewSource(
  code: string,
  inputKind?: "javascript" | "typescript",
): Promise<string> {
  if (!isFormattableSingleLine(code)) return code;
  try {
    const { format, plugins } = await loadPrettierBundle();
    const formatted = await format(code, {
      parser: inputKind === "javascript" ? "babel" : "babel-ts",
      plugins,
      printWidth: PREVIEW_PRINT_WIDTH,
      tabWidth: 2,
    });
    return formatted.trimEnd();
  } catch {
    return code;
  }
}

export function needsCodeModePreviewPreparation(
  history: readonly ToolEntry[],
): boolean {
  let needsAsyncFormat = false;
  for (const entry of history) {
    const display = entry.codeMode;
    if (!display || display.kind !== "exec") continue;
    const source = display.code;
    if (source === undefined) {
      display.previewCode = undefined;
      display.previewFor = undefined;
      continue;
    }
    if (display.previewFor === source && display.previewCode !== undefined) {
      continue;
    }
    if (!isFormattableSingleLine(source)) {
      display.previewCode = source;
      display.previewFor = source;
      continue;
    }
    needsAsyncFormat = true;
  }
  return needsAsyncFormat;
}

export async function prepareCodeModePreviews(
  history: readonly ToolEntry[],
): Promise<void> {
  if (!needsCodeModePreviewPreparation(history)) return;
  await Promise.all(
    history.map(async (entry) => {
      const display = entry.codeMode;
      if (!display || display.kind !== "exec") return;
      const source = display.code;
      if (source === undefined) return;
      if (display.previewFor === source && display.previewCode !== undefined) {
        return;
      }
      const formatted = await formatCodeModePreviewSource(
        source,
        display.inputKind,
      );
      if (display.code === source) {
        display.previewCode = formatted;
        display.previewFor = source;
      }
    }),
  );
}
