import { describe, expect, it } from "vitest";
import { ANSI } from "./ansi.js";
import { renderStatusContent, renderStatusContentWithState } from "./render.js";
import type { ToolEntry } from "./types.js";

type CodeDisplay = {
  kind: "exec" | "wait";
  state: "running" | "waiting" | "completed" | "failed" | "unknown";
  code?: string;
  previewCode?: string;
  previewFor?: string;
  title?: string;
  error?: string;
};

function codeEntry(
  codeMode: CodeDisplay,
  overrides: Partial<ToolEntry> = {},
): ToolEntry {
  return {
    toolCallId: "cell",
    toolName: "exec",
    params: {
      title: "Load skill",
      code: codeMode.code,
      command: codeMode.code,
    },
    status: "completed",
    durationMs: 711,
    codeMode,
    ...overrides,
  } as ToolEntry;
}

function plain(content: string): string {
  return content.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

describe("Code Mode activity display", () => {
  it("renders formatted previewCode across bounded rows while keeping raw code intact", () => {
    const code =
      "const a=1;const b=2;const c=3;const d=4;const e=5;const f=6;return a+b+c+d+e+f;";
    const previewCode = [
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
      "const f = 6;",
      "return a + b + c + d + e + f;",
    ].join("\n");
    const result = plain(
      renderStatusContent(
        [
          codeEntry({
            kind: "exec",
            state: "completed",
            code,
            previewCode,
            previewFor: code,
          }),
        ],
        false,
      ),
    );
    const rows = result.split("\n").filter((line) => /^    [│╰] /u.test(line));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toBe("    │ const a = 1;");
    expect(rows[4]).toBe("    │ const e = 5;");
    expect(rows[5]).toBe("    ╰ … 2 more lines");
  });

  it("renders unformatted invalid single-line source directly without hard-wrapping tokens", () => {
    const code = 'const value = "a;b";'.repeat(7) + "await broken({";
    const result = plain(
      renderStatusContent(
        [
          codeEntry({
            kind: "exec",
            state: "failed",
            code,
            previewCode: code,
            previewFor: code,
            error: "SyntaxError",
          }),
        ],
        false,
      ),
    );
    const rows = result.split("\n").filter((line) => /^    [│╰] /u.test(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(`    │ ${[...code].slice(0, 89).join("")}…`);
    expect(rows[1]).toBe("    ╰ SyntaxError");
  });

  it("shows one source preview and a code title while actual tool rows stay flat", () => {
    const code = 'return await skill_view({ name: "example" });';
    const result = plain(
      renderStatusContent(
        [
          codeEntry({
            kind: "exec",
            state: "completed",
            code,
            title: "Load skill",
          }),
          {
            toolCallId: "child",
            toolName: "skill_view",
            params: { name: "example" },
            status: "completed",
          },
        ],
        false,
      ),
    );
    expect(result).toContain("💻 code · Load skill");
    expect(result.split(code)).toHaveLength(2);
    expect(result).not.toContain("command");
    expect(result).toContain("🔧 skill_view");
  });

  it("renders red error text with a gray connector and no second error cross", () => {
    const error = "TypeError: tools.slice is not a function";
    const result = renderStatusContent(
      [
        codeEntry(
          {
            kind: "exec",
            state: "failed",
            code: "return tools.slice();",
            error,
          },
          { status: "error", error },
        ),
      ],
      false,
    );
    expect(result).toContain(`${ANSI.red}${error}${ANSI.reset}`);
    expect(result).toContain(`${ANSI.lightGray}╰${ANSI.reset}`);
    expect(plain(result).match(/✘/g)).toHaveLength(1);
    expect(plain(result)).not.toContain("error TypeError");
  });

  it.each(["running", "waiting", "unknown"] as const)(
    "does not show a success check for %s",
    (state) => {
      const result = plain(
        renderStatusContent(
          [codeEntry({ kind: "exec", state, title: "Collect results" })],
          false,
        ),
      );
      expect(result).not.toContain("✔");
      if (state === "waiting") expect(result).toContain("waiting");
      if (state === "unknown") expect(result).toContain("?");
    },
  );

  it("bounds source by lines and Unicode characters while preserving indentation", () => {
    const code = [
      '  const title = "' + "界💻".repeat(80) + '";',
      ...Array.from({ length: 9 }, (_, i) => `  step${i}();`),
    ].join("\r\n");
    const result = plain(
      renderStatusContent(
        [codeEntry({ kind: "exec", state: "completed", code })],
        false,
      ),
    );
    const sourceLines = result
      .split("\n")
      .filter((line) => /^\s+[│╰]/u.test(line));
    expect(sourceLines.length).toBeLessThanOrEqual(6);
    expect(result).toContain("  step0();");
    expect(result).not.toContain("step8");
    expect(result).toMatch(/….*lines/u);
    expect(result).not.toContain("\ufffd");
    for (const line of sourceLines)
      expect([...line.replace(/^\s+[│╰] /u, "")].length).toBeLessThanOrEqual(
        90,
      );
  });

  it("sanitizes controls and code fences without allowing source to color later rows", () => {
    const result = renderStatusContent(
      [
        codeEntry({
          kind: "exec",
          state: "completed",
          title: "A\nB",
          code: "\tconsole.log(`x`);\u001b[31m\n```",
        }),
      ],
      false,
    );
    expect(result.match(/```/g)).toHaveLength(2);
    expect(plain(result)).toContain("code · A B");
    expect(result).not.toContain("\u001b[31m");
    expect(result).not.toContain("\t");
  });

  it("keeps a bounded failure summary when the failed Code is collapsed before a newer tool", () => {
    const error = "TypeError: missing field";
    const history = [
      codeEntry(
        {
          kind: "exec",
          state: "failed",
          title: "Collect results",
          code: "x".repeat(800),
          error,
        },
        { status: "error" as const },
      ),
      {
        toolCallId: "child",
        toolName: "read",
        params: { path: "source.ts", text: "y".repeat(800) },
        status: "completed" as const,
      },
    ];
    const result = renderStatusContentWithState(history, false, 470);
    expect(result.content.length).toBeLessThanOrEqual(470);
    expect(plain(result.content)).toContain(error);
    const collapsed = renderStatusContentWithState(history, false, 470, {
      "tool:cell": "collapsed",
    });
    expect(plain(collapsed.content)).toContain("💻 code · Collect results");
    expect(plain(collapsed.content)).toContain(error);
  });

  it("preserves protected agent failure when a Code failure cannot also fit", () => {
    const agentFailure: ToolEntry = {
      toolCallId: "agent",
      toolName: "agent",
      params: { error: "Root execution failed" },
      status: "error",
      error: "Root execution failed",
    };
    const baseline = renderStatusContent([agentFailure], true, 260);
    expect(plain(baseline)).toContain("Root execution failed");
    const result = renderStatusContent(
      [
        codeEntry(
          {
            kind: "exec",
            state: "failed",
            title: "Long title ".repeat(20),
            code: "return value;",
            error: "TypeError: ".repeat(30),
          },
          { status: "error" },
        ),
        agentFailure,
      ],
      true,
      260,
    );
    expect(result.length).toBeLessThanOrEqual(260);
    expect(plain(result)).toContain("Root execution failed");
    expect(plain(result)).not.toBe("```ansi\n\n```");
  });

  it("retains a minimal Code failure and red error at the legal 100-character budget", () => {
    const result = renderStatusContent(
      [
        codeEntry(
          {
            kind: "exec",
            state: "failed",
            title: "Long title ".repeat(20),
            code: "return value;",
            error: "TypeError: ".repeat(30),
          },
          { status: "error" },
        ),
      ],
      false,
      100,
    );
    expect(result.length).toBeLessThanOrEqual(100);
    expect(plain(result)).toContain("💻 code");
    expect(plain(result)).toContain("TypeError");
    expect(result).toContain(ANSI.red);
    expect(plain(result)).not.toContain("return value;");
  });

  it("shows wait compactly without duplicating the original source", () => {
    const result = plain(
      renderStatusContent(
        [
          codeEntry(
            {
              kind: "wait",
              state: "waiting",
              title: "Collect results",
              code: "doNotRepeat();",
            },
            { toolName: "wait" },
          ),
        ],
        false,
      ),
    );
    expect(result).toContain("💻 code");
    expect(result).toContain("waiting");
    expect(result).not.toContain("doNotRepeat");
  });

  it("leaves ordinary shell exec rendering unchanged", () => {
    const result = plain(
      renderStatusContent(
        [
          {
            toolCallId: "shell",
            toolName: "exec",
            params: { command: "git status" },
            status: "completed",
          },
        ],
        false,
      ),
    );
    expect(result).toContain("🚀 exec");
    expect(result).toContain("command git status");
    expect(result).not.toContain("💻");
  });
});
