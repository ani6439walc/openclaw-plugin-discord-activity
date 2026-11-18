import { describe, expect, it } from "vitest";
import {
  formatCodeModePreviewSource,
  MAX_SINGLE_LINE_FORMAT_LENGTH,
  prepareCodeModePreviews,
} from "./code-mode-format.js";
import type { ToolEntry } from "./types.js";

describe("formatCodeModePreviewSource", () => {
  it("formats single-line multi-statement JavaScript with top-level await and return", async () => {
    const code =
      "const h=await catalog.search('skill view skill_view and skill_search visible skill'); const v=h.find(x=>x.callableName==='skill_view');const s=h.find(x=>x.callableName==='skill_search');if(v){const r=await v({name:'clawhub-publishing'});text(r);}";
    const formatted = await formatCodeModePreviewSource(code, "javascript");
    const lines = formatted.split("\n");
    expect(lines.length).toBeGreaterThan(4);
    expect(lines[0]).toBe(
      'const h = await catalog.search("skill view skill_view and skill_search visible skill");',
    );
    expect(lines[1]).toBe(
      'const v = h.find((x) => x.callableName === "skill_view");',
    );
    expect(formatted).toContain("if (v) {\n  const r = await v(");
  });

  it("formats single-line TypeScript annotations and trailing newline", async () => {
    const code = "const label: string = `skill`; return label;\n";
    const formatted = await formatCodeModePreviewSource(code, "typescript");
    expect(formatted).toBe("const label: string = `skill`;\nreturn label;");
  });

  it("preserves authored multiline layout verbatim without running Prettier", async () => {
    const code = "const first = 'keep-single-quotes';\n    return first";
    const formatted = await formatCodeModePreviewSource(code);
    expect(formatted).toBe(code);
  });

  it("falls back to original code when single-line JavaScript has a SyntaxError", async () => {
    const code = 'const value = "a;b";'.repeat(7) + "await broken({";
    const formatted = await formatCodeModePreviewSource(code);
    expect(formatted).toBe(code);
  });

  it("skips formatting when single-line input exceeds the length guard", async () => {
    const code = `const x = "${"a".repeat(MAX_SINGLE_LINE_FORMAT_LENGTH)}"; return x;`;
    const formatted = await formatCodeModePreviewSource(code);
    expect(formatted).toBe(code);
  });
});

describe("prepareCodeModePreviews", () => {
  it("hydrates exec entries in place, caches unchanged code, and refreshes on update", async () => {
    const entry: ToolEntry = {
      toolCallId: "cell-1",
      toolName: "exec",
      params: {},
      status: "pending",
      codeMode: {
        kind: "exec",
        state: "running",
        code: "const a=1;return a;",
      },
    };
    await prepareCodeModePreviews([entry]);
    expect(entry.codeMode?.code).toBe("const a=1;return a;");
    expect(entry.codeMode?.previewCode).toBe("const a = 1;\nreturn a;");
    expect(entry.codeMode?.previewFor).toBe("const a=1;return a;");

    // Mutating raw code (e.g. steering/after adjustment) refreshes previewCode
    entry.codeMode!.code = "const b=2;return b;";
    await prepareCodeModePreviews([entry]);
    expect(entry.codeMode?.previewCode).toBe("const b = 2;\nreturn b;");
    expect(entry.codeMode?.previewFor).toBe("const b=2;return b;");
  });

  it("does not overwrite previewCode if raw code mutates while formatting is in flight", async () => {
    const entry: ToolEntry = {
      toolCallId: "cell-race",
      toolName: "exec",
      params: {},
      status: "pending",
      codeMode: {
        kind: "exec",
        state: "running",
        code: "const stale=1;return stale;",
      },
    };
    const pending = prepareCodeModePreviews([entry]);
    entry.codeMode!.code = "return 2;";
    await pending;
    expect(entry.codeMode?.previewFor).toBeUndefined();
    expect(entry.codeMode?.previewCode).toBeUndefined();
  });
});
