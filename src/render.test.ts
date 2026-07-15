import { describe, it, expect } from "vitest";
import {
  createDefaultInternalGroupDisplayState,
  isContentTooLong,
  mergeInternalGroupDisplayStates,
  renderStatusContent,
  renderStatusContentWithState,
} from "./render.js";
import { formatParams, getToolIcon } from "./formatting.js";
import type { ToolEntry } from "./types.js";

function makeEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    toolCallId: "call_001",
    toolName: "bash",
    params: { command: "ls" },
    status: "pending",
    ...overrides,
  };
}

const RESET = "\u001b[0m";
const BOLD_BLUE = "\u001b[1;34m";
const BOLD_CYAN = "\u001b[1;36m";
const MAGENTA = "\u001b[35m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const CYAN = "\u001b[36m";
const LIGHT_GRAY = "\u001b[37m";

function stripAnsi(content: string): string {
  return content.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

describe("internal-group display state", () => {
  it("creates fresh expanded defaults and merges each group monotonically", () => {
    const first = createDefaultInternalGroupDisplayState();
    const second = createDefaultInternalGroupDisplayState();

    expect(first).toEqual({
      activeMemory: "expanded",
      skillHarness: "expanded",
    });
    expect(second).not.toBe(first);
    expect(
      mergeInternalGroupDisplayStates(
        { activeMemory: "collapsed", skillHarness: "expanded" },
        { activeMemory: "expanded", skillHarness: "removed" },
      ),
    ).toEqual({
      activeMemory: "collapsed",
      skillHarness: "removed",
    });
  });

  it("accepts a deep-frozen prior state without mutation", () => {
    const prior = Object.freeze({
      activeMemory: "collapsed" as const,
      skillHarness: "removed" as const,
    });
    const history = [
      makeEntry({
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "memory" },
        status: "completed",
      }),
      makeEntry({
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "hint" },
        status: "completed",
      }),
    ];

    const result = renderStatusContentWithState(history, true, 1_700, prior);

    expect(stripAnsi(result.content)).toContain("active-memory ▸ ✔");
    expect(stripAnsi(result.content)).not.toContain("skill-harness");
    expect(result.displayState).toEqual(prior);
    expect(prior).toEqual({
      activeMemory: "collapsed",
      skillHarness: "removed",
    });
  });
});

describe("tool icon categories", () => {
  it.each([
    // Web & Communication
    ["browser", "🌎"],
    ["web_search", "🔎"],
    ["web_fetch", "📥"],
    ["message", "✉️"],
    // File Operations
    ["read", "📄"],
    ["write", "✍️"],
    ["edit", "✂️"],
    ["apply_patch", "📝"],
    ["diff", "🔀"],
    // Media & Formats
    ["image", "🖼️"],
    ["image_generate", "🖼️"],
    ["pdf", "📜"],
    ["tts", "🔊"],
    // Execution & Process
    ["exec", "🚀"],
    ["process", "⏳"],
    // Knowledge, Memory & Wiki
    ["memory_search", "🧠"],
    ["wiki_search", "📖"],
    ["wiki_apply", "📋"],
    ["wiki_lint", "🧹"],
    ["wiki_status", "📊"],
    ["wiki_get", "📚"],
    // Session & Agent
    ["sessions_history", "🗿"],
    ["sessions_list", "🛰️"],
    ["sessions_send", "🛸"],
    ["sessions_spawn", "💬"],
    ["sessions_yield", "🏁"],
    ["subagents", "👥"],
    // Skill management
    ["skill_search", "🪃"],
    ["skill_view", "🔧"],
    ["skill_manage", "🛠️"],
    ["skill_list", "🛒"],
    // Goal & Plan
    ["create_goal", "🪧"],
    ["update_goal", "🪧"],
    ["update_plan", "🔖"],
    // Scheduling & Infrastructure
    ["cron", "⏰"],
    ["gateway", "🧱"],
    ["nodes", "🔌"],
    // MCP tools (default)
    ["context7_resolve_library_id", "⚙️"],
    ["google-developer-search", "⚙️"],
    ["sequential_thinking", "⚙️"],
  ])("maps %s to %s", (toolName, icon) => {
    expect(getToolIcon(toolName)).toBe(icon);
  });
});

describe("ANSI main-tool contract", () => {
  it("fails open when both JSON and string serialization throw", () => {
    const hostile = {
      toJSON() {
        throw new Error("json failed");
      },
      toString() {
        throw new Error("string failed");
      },
    };

    const result = renderStatusContent(
      [makeEntry({ params: { payload: hostile }, status: "completed" })],
      true,
    );

    expect(stripAnsi(result)).toContain("payload: [unserializable]");
  });

  it("renders a completed main tool as an exact ANSI tree", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          params: { command: "ls", cwd: "/repo" },
          status: "completed",
          durationMs: 1001,
        }),
      ],
      false,
    );

    expect(result).toBe(
      [
        "```ansi",
        `${BOLD_CYAN}⚙️ bash${RESET} ${GREEN}✔${RESET} ${YELLOW}[1s]${RESET}`,
        `    ├─ ${MAGENTA}cwd:${RESET} ${GREEN}/repo${RESET}`,
        `    └─ ${MAGENTA}command:${RESET} ${GREEN}ls${RESET}`,
        "```",
      ].join("\n"),
    );
  });

  it("renders a pending main tool without a duration", () => {
    const result = renderStatusContent(
      [makeEntry({ params: {}, status: "pending" })],
      false,
    );

    expect(result).toBe(
      ["```ansi", `${BOLD_CYAN}⚙️ bash${RESET} ${YELLOW}←${RESET}`, "```"].join(
        "\n",
      ),
    );
  });

  it("renders a failed main tool with an error child", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          params: {},
          status: "error",
          error: "permission denied",
        }),
      ],
      false,
    );

    expect(result).toBe(
      [
        "```ansi",
        `${BOLD_CYAN}⚙️ bash${RESET} ${RED}✘${RESET}`,
        `    └─ ${RED}error:${RESET} ${GREEN}permission denied${RESET}`,
        "```",
      ].join("\n"),
    );
  });

  it("renders an orphan-completed main tool with the recycle glyph", () => {
    const result = renderStatusContent(
      [makeEntry({ params: {}, status: "orphan-completed" })],
      false,
    );

    expect(result).toBe(
      ["```ansi", `${BOLD_CYAN}⚙️ bash${RESET} ${CYAN}♻︎${RESET}`, "```"].join(
        "\n",
      ),
    );
  });
});

describe("display-value formatting", () => {
  it("truncates ordinary values by Unicode code point with an exact hint", () => {
    const value = `${"a".repeat(69)}😀${"b".repeat(2)}`;

    const result = stripAnsi(
      renderStatusContent(
        [makeEntry({ params: { query: value }, status: "completed" })],
        true,
      ),
    );

    expect(result).toContain(`${"a".repeat(69)}😀... (+2 chars)`);
    expect(result).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("keeps truncated string values green and their omission hint light gray", () => {
    const retained = "a".repeat(70);
    const result = renderStatusContent(
      [
        makeEntry({
          params: { query: `${retained}x` },
          status: "completed",
        }),
      ],
      true,
    );

    expect(result).toContain(
      `${GREEN}${retained}...${RESET}${LIGHT_GRAY} (+1 char)${RESET}`,
    );
  });

  it("uses head-tail truncation only for recognized path keys", () => {
    const path = `${"a".repeat(20)}${"m".repeat(10)}${"z".repeat(50)}`;

    const result = stripAnsi(
      renderStatusContent(
        [makeEntry({ params: { path }, status: "completed" })],
        true,
      ),
    );

    expect(result).toContain(
      `path: ${"a".repeat(20)}...${"z".repeat(50)} (+10 chars)`,
    );
  });

  it("sanitizes ANSI, control characters, fences, newlines, and tabs", () => {
    const value = "safe\u001b[31mred\u001b[0m```end\u0000\tline\nnext";

    const result = renderStatusContent(
      [makeEntry({ params: { query: value }, status: "completed" })],
      true,
    );
    const plain = stripAnsi(result);

    expect(plain).toContain("query: saferedˋˋˋend\\tline\\nnext");
    expect(result.match(/```/g)).toHaveLength(2);
    expect(result).not.toContain("\u0000");
    expect(result).not.toContain("\u001b[31mred");
  });
});

describe("compact scalar rows", () => {
  it("moves eligible scalars first and packs at most three per row", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            params: {
              query: "renderStatusContent",
              limit: 50,
              offset: 0,
              caseSensitive: false,
              retries: 2,
              path: "src",
            },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result).toContain(
      "    ├─ limit: 50 · offset: 0 · caseSensitive: false\n" +
        "    ├─ retries: 2\n" +
        "    ├─ query: renderStatusContent\n" +
        "    └─ path: src",
    );
  });

  it("wraps a compact row before its visible content exceeds 70 code points", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            params: {
              firstMetadataKey123456: 1,
              secondMetadataKey12345: 2,
              thirdMetadataKey123456: 3,
            },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result).toContain(
      "    ├─ firstMetadataKey123456: 1 · secondMetadataKey12345: 2\n" +
        "    └─ thirdMetadataKey123456: 3",
    );
  });

  it("keeps the compact separator in the default color", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          params: { limit: 50, enabled: true },
          status: "completed",
        }),
      ],
      true,
    );

    expect(result).toContain(
      `${MAGENTA}limit:${RESET} ${GREEN}50${RESET} · ${MAGENTA}enabled:${RESET} ${GREEN}true${RESET}`,
    );
  });

  it("packs allowlisted topic-triage enums before multiline-capable fields", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolCallId: "skill-harness:run-1:topic-triage",
            toolName: "skill-harness:topic-triage",
            params: {
              changed: false,
              reason: "same-topic",
              domain: "health",
              complexity: "low",
              keywords: ["weight", "clinic"],
              topic: "Update corrected weight tracking",
            },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result).toContain(
      "changed: false · domain: health · complexity: low\n" +
        '        ├─ keywords: ["weight","clinic"]\n' +
        "        ├─ reason: same-topic\n" +
        "        └─ topic: Update corrected weight tracking",
    );
  });

  it("packs allowlisted intent-classify enum fields", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolCallId: "skill-harness:run-1:intent-classify",
            toolName: "skill-harness:intent-classify",
            params: {
              intent: "update",
              complexity: "low",
              reason: "explicit correction",
            },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result).toContain(
      "intent: update · complexity: low\n" +
        "        └─ reason: explicit correction",
    );
  });

  it.each(["memory_search", "active-memory:memory_search"])(
    "packs %s corpus with numeric metadata",
    (toolName) => {
      const result = stripAnsi(
        renderStatusContent(
          [
            makeEntry({
              toolCallId: "active-memory:search",
              toolName,
              params: {
                minScore: 0.2,
                maxResults: 5,
                query: "weight clinic",
                corpus: "memory",
              },
              status: "completed",
            }),
          ],
          true,
        ),
      );

      const compactRow = "minScore: 0.2 · maxResults: 5 · corpus: memory";
      expect(result).toContain(compactRow);
      expect(result.indexOf(compactRow)).toBeLessThan(
        result.indexOf("query: weight clinic"),
      );
    },
  );

  it("does not compact an allowlisted key for an unrelated tool", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolName: "other",
            params: { limit: 5, corpus: "memory" },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result).toContain("    ├─ limit: 5\n    └─ corpus: memory");
    expect(result).not.toContain("limit: 5 · corpus: memory");
  });
});

describe("multiline values", () => {
  it("renders command lines at the bottom with an unbroken connector", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            params: {
              command: "pnpm run typecheck\npnpm run test",
              cwd: "/repo",
            },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result).toContain(
      [
        "    ├─ cwd: /repo",
        "    └─ command: |",
        "        pnpm run typecheck",
        "        pnpm run test",
      ].join("\n"),
    );
  });

  it("sorts multiple multiline-capable fields alphabetically after ordinary fields", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            params: {
              result: "summary",
              cwd: "/repo",
              error: "warning",
              command: "pnpm run test",
              query: "status renderer",
            },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result.indexOf("cwd: /repo")).toBeLessThan(
      result.indexOf("query: status renderer"),
    );
    expect(result.indexOf("query: status renderer")).toBeLessThan(
      result.indexOf("command: pnpm run test"),
    );
    expect(result.indexOf("command: pnpm run test")).toBeLessThan(
      result.indexOf("error: warning"),
    );
    expect(result.indexOf("error: warning")).toBeLessThan(
      result.indexOf("result: summary"),
    );
  });

  it("preserves complete multiline values when the status fits", () => {
    const command = [
      `${"a".repeat(70)}x`,
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "hidden",
    ].join("\r\n");

    const result = stripAnsi(
      renderStatusContent(
        [makeEntry({ params: { command }, status: "completed" })],
        true,
      ),
    );

    expect(result).toContain(`${"a".repeat(70)}x`);
    expect(result).toContain("line 5");
    expect(result).toContain("hidden");
    expect(result).not.toMatch(/\(\+\d+ chars?\)/u);
  });

  it("preserves escaped tabs without applying a local width limit", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            params: { command: `${"\t".repeat(35)}x\nnext` },
            status: "completed",
          }),
        ],
        true,
      ),
    );

    expect(result).toContain(`${"\\t".repeat(35)}x`);
    expect(result).toContain("next");
    expect(result).not.toMatch(/\(\+\d+ chars?\)/u);
  });
});

describe("ANSI internal group contract", () => {
  it("renders child tools, result, and a distinct parent error as complete trees", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "error",
          error: "parent timeout",
        }),
        makeEntry({
          toolCallId: "active-memory:search",
          toolName: "active-memory:memory_search",
          params: { query: "hello", limit: 5 },
          status: "completed",
          durationMs: 100,
        }),
        makeEntry({
          toolCallId: "active-memory:write",
          toolName: "active-memory:memory_write",
          params: {},
          status: "error",
          error: "permission denied",
        }),
        makeEntry({
          toolCallId: "active-memory:result",
          toolName: "active-memory:result",
          params: { text: "first line\nsecond line" },
          status: "completed",
        }),
      ],
      true,
    );

    expect(stripAnsi(result)).toContain(
      [
        "🧩 active-memory ▾ ✘",
        "    ├─ memory_search ✔ [100ms]",
        "    │   ├─ limit: 5",
        "    │   └─ query: hello",
        "    ├─ memory_write ✘",
        "    │   └─ error: permission denied",
        "    ├─ result: |",
        "    │   first line",
        "    │   second line",
        "    └─ error: parent timeout",
      ].join("\n"),
    );
    expect(result).toContain(
      `${BOLD_CYAN}🧩 active-memory${RESET} ${LIGHT_GRAY}▾${RESET} ${RED}✘${RESET}`,
    );
    expect(result).toContain(
      `${CYAN}memory_search${RESET} ${GREEN}✔${RESET} ${YELLOW}[100ms]${RESET}`,
    );
  });

  it("renders a main-agent failure in bold blue with an error child", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          toolCallId: "agent",
          toolName: "agent",
          params: {},
          status: "error",
          error: "provider timeout",
        }),
      ],
      true,
    );

    expect(result).toBe(
      [
        "```ansi",
        `${BOLD_BLUE}💥 agent${RESET} ${RED}✘${RESET}`,
        `    └─ ${RED}error:${RESET} ${GREEN}provider timeout${RESET}`,
        "```",
      ].join("\n"),
    );
  });
});

describe("group wall-clock duration", () => {
  it("prefers an authoritative parent duration over child timings", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolCallId: "active-memory",
            toolName: "active-memory",
            params: {},
            status: "completed",
            durationMs: 9_310,
          }),
          makeEntry({
            toolCallId: "memory-1",
            toolName: "active-memory:memory_search",
            params: {},
            status: "completed",
            startedAtMs: 1_000,
            durationMs: 2_000,
          }),
        ],
        true,
      ),
    );

    expect(result.split("\n")[1]).toBe("🧩 active-memory ▾ ✔ [9.31s]");
  });

  it.each([
    ["pending", "←"],
    ["completed", "✔"],
  ] as const)(
    "does not derive active-memory group duration from children when its parent is %s without a duration",
    (status, suffix) => {
      const result = stripAnsi(
        renderStatusContent(
          [
            makeEntry({
              toolCallId: "active-memory",
              toolName: "active-memory",
              params: {},
              status,
            }),
            makeEntry({
              toolCallId: "memory-1",
              toolName: "active-memory:memory_search",
              params: {},
              status: "completed",
              startedAtMs: 1_000,
              durationMs: 2_000,
            }),
          ],
          status === "completed",
        ),
      );

      expect(result.split("\n")[1]).toBe(`🧩 active-memory ▾ ${suffix}`);
    },
  );

  it("uses the child wall-clock envelope instead of summing durations", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolCallId: "phase-1",
            toolName: "skill-harness:phase-1",
            params: {},
            status: "completed",
            startedAtMs: 1_000,
            durationMs: 1_000,
          }),
          makeEntry({
            toolCallId: "phase-2",
            toolName: "skill-harness:phase-2",
            params: {},
            status: "completed",
            startedAtMs: 1_500,
            durationMs: 2_500,
          }),
        ],
        true,
      ),
    );

    expect(result.split("\n")[1]).toBe("💡 skill-harness ▾ ✔ [3s]");
  });

  it("keeps the group pending while only a child phase has completed", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolCallId: "skill-harness",
            toolName: "skill-harness",
            params: {},
            status: "pending",
            startedAtMs: 900,
          }),
          makeEntry({
            toolCallId: "phase-1",
            toolName: "skill-harness:phase-1",
            params: {},
            status: "completed",
            startedAtMs: 1_000,
            durationMs: 1_500,
          }),
        ],
        false,
      ),
    );

    expect(result.split("\n")[1]).toBe("💡 skill-harness ▾ ←");
  });

  it("uses the completed pipeline parent for final status and duration", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolCallId: "skill-harness",
            toolName: "skill-harness",
            params: {},
            status: "completed",
            durationMs: 2_000,
          }),
          makeEntry({
            toolCallId: "phase-2",
            toolName: "skill-harness:phase-2",
            params: {},
            status: "pending",
            startedAtMs: 2_000,
          }),
        ],
        true,
      ),
    );

    expect(result.split("\n")[1]).toBe("💡 skill-harness ▾ ✔ [2s]");
  });

  it("omits the parent duration when child timing is incomplete", () => {
    const result = stripAnsi(
      renderStatusContent(
        [
          makeEntry({
            toolCallId: "phase-1",
            toolName: "skill-harness:phase-1",
            params: {},
            status: "completed",
            durationMs: 1_000,
          }),
        ],
        true,
      ),
    );

    expect(result.split("\n")[1]).toBe("💡 skill-harness ▾ ✔");
  });
});

describe("renderStatusContent", () => {
  it("reports the exact number of omitted Unicode characters", () => {
    const value = `${"a".repeat(749)}😀\n${"b".repeat(6)}`;

    const result = formatParams({ result: value });

    expect(result).toContain(`😀... 7 chars more`);
    expect(result).not.toContain("(truncated)");
    expect(result).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("reports omitted Unicode characters for single-line values", () => {
    const value = `${"a".repeat(149)}😀${"b".repeat(6)}`;

    const result = formatParams({ query: value });

    expect(result).toContain(`😀... 6 chars more`);
    expect(result).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("renders a single pending tool", () => {
    const result = renderStatusContent([makeEntry()], false);
    expect(result).toContain("bash");
    expect(result).toContain("←");
    expect(result).toContain("```ansi");
  });

  it("renders completed tool with checkmark when final", () => {
    const result = renderStatusContent(
      [makeEntry({ status: "completed" })],
      true,
    );
    expect(result).toContain("bash");
    expect(result).toContain("✔");
  });

  it.each([
    [999, "999ms"],
    [1000, "1,000ms"],
    [1001, "1s"],
    [1494, "1.49s"],
    [1495, "1.5s"],
    [9876, "9.88s"],
    [10_000, "10s"],
    [34_481, "34.5s"],
  ])("formats %ims duration as %s", (durationMs, expected) => {
    const result = renderStatusContent(
      [makeEntry({ status: "completed", durationMs })],
      true,
    );

    expect(stripAnsi(result)).toContain(`[${expected}]`);
  });

  it("renders error tool with x mark", () => {
    const result = renderStatusContent([makeEntry({ status: "error" })], false);
    expect(result).toContain("✘");
  });

  it("renders normal tool error with error message detail", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          status: "error",
          error: "permission denied",
        }),
      ],
      false,
    );
    expect(stripAnsi(result)).toContain("⚙️ bash ✘");
    expect(stripAnsi(result)).toContain("error: permission denied");
  });

  it("leaves single-line string params containing colons unquoted", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          params: { query: "site:example.com status:open" },
          status: "completed",
        }),
      ],
      true,
    );

    expect(stripAnsi(result)).toContain("query: site:example.com status:open");
  });

  it("leaves error messages containing colons unquoted", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          status: "error",
          error: "failed: timeout",
        }),
      ],
      true,
    );

    expect(stripAnsi(result)).toContain("└─ error: failed: timeout");
  });

  it("does not apply YAML quoting to ordinary strings", () => {
    const result = renderStatusContent(
      [
        makeEntry({
          params: {
            quoted: '"already quoted"',
            dash: "- item",
            question: "? key",
            hex: "0x1A",
            octal: "0o77",
          },
          status: "completed",
        }),
      ],
      true,
    );

    const plain = stripAnsi(result);
    expect(plain).toContain('quoted: "already quoted"');
    expect(plain).toContain("dash: - item");
    expect(plain).toContain("question: ? key");
    expect(plain).toContain("hex: 0x1A");
    expect(plain).toContain("octal: 0o77");
  });

  it("renders orphan-completed with recycle mark", () => {
    const result = renderStatusContent(
      [makeEntry({ status: "orphan-completed" })],
      false,
    );
    expect(result).toContain("♻︎");
  });

  it("renders active-memory group with completed suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "am1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "am2",
        toolName: "active-memory:memory_read",
        params: { id: "123" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(stripAnsi(result)).toContain("🧩 active-memory ▾ ✔");
    expect(result).toContain("memory_search");
    expect(result).toContain("memory_read");
  });

  it("renders active-memory result as the last nested item", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "am1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "每日早報重跑已觸發" },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain("memory_search");
    expect(result).toContain("result: 每日早報重跑已觸發");
    expect(result.indexOf("memory_search")).toBeLessThan(
      result.indexOf("result: 每日早報重跑已觸發"),
    );
  });

  it("keeps a long single-line active-memory result complete for Discord to wrap", () => {
    const text = `result-${"x".repeat(240)}-end`;
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain(`result: ${text}`);
    expect(result).not.toMatch(/\(\+\d+ chars?\)/u);
  });

  it("renders subagent result entries after other nested tools regardless of history order", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "NONE" },
        status: "completed",
      },
      {
        toolCallId: "active-memory:mem1",
        toolName: "active-memory:memory_search",
        params: { query: "7-11 賣貨便 出貨" },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: JSON.stringify({ intent: "answer-question" }) },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:topic-triage",
        params: { domain: "tools" },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));

    expect(result.indexOf("memory_search")).toBeLessThan(
      result.indexOf("result: NONE"),
    );
    expect(result.indexOf("topic-triage")).toBeLessThan(
      result.indexOf("intent: answer-question"),
    );
  });

  it("shows up to three entries per subagent group before the main agent starts", () => {
    const activeMemoryEntries: ToolEntry[] = Array.from(
      { length: 7 },
      (_, index) => ({
        toolCallId: `active-memory:mem_${index}`,
        toolName: `active-memory:memory_search_${index}`,
        params: { query: `memory ${index}` },
        status: "completed",
      }),
    );
    const skillHarnessEntries: ToolEntry[] = Array.from(
      { length: 7 },
      (_, index) => ({
        toolCallId: `skill-harness:phase_${index}`,
        toolName: `skill-harness:phase_${index}`,
        params: { result: `hint ${index}` },
        status: "completed",
      }),
    );

    const result = renderStatusContent(
      [...activeMemoryEntries, ...skillHarnessEntries],
      true,
    );

    expect(result).not.toContain("memory_search_3");
    expect(result).toContain("memory_search_4");
    expect(result).not.toContain("phase_3");
    expect(result).toContain("phase_4");
  });

  it("keeps each subagent child limit independent from outer status slots", () => {
    const subagentEntries: ToolEntry[] = [
      ...Array.from({ length: 5 }, (_, index) => ({
        toolCallId: `active-memory:mem_${index}`,
        toolName: `active-memory:memory_search_${index}`,
        params: {},
        status: "completed" as const,
      })),
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:topic-triage",
        params: {},
        status: "completed",
      } as const,
    ];
    const normalEntries = Array.from({ length: 4 }, (_, index) =>
      makeEntry({
        toolCallId: `normal_${index}`,
        toolName: `normal_tool_${index}`,
        status: "completed",
      }),
    );

    const result = renderStatusContent(
      [...subagentEntries, ...normalEntries],
      true,
    );

    expect(stripAnsi(result)).toContain("🧩 active-memory ▾ ✔");
    expect(stripAnsi(result)).toContain("💡 skill-harness ▾ ✔");
    expect(result).not.toContain("memory_search_0");
    expect(result).not.toContain("memory_search_1");
    expect(result).toContain("memory_search_2");
    expect(result).toContain("topic-triage");
    expect(result).toContain("normal_tool_0");
    expect(result).toContain("normal_tool_3");
  });

  it("rolls out whole subagent groups as normal tools fill six outer slots", () => {
    const subagentEntries = [
      makeEntry({
        toolCallId: "active-memory:memory",
        toolName: "active-memory:memory_search",
        status: "completed",
      }),
      makeEntry({
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:topic-triage",
        status: "completed",
      }),
    ];
    const normalEntries = Array.from({ length: 6 }, (_, index) =>
      makeEntry({
        toolCallId: `normal_${index}`,
        toolName: `normal_tool_${index}`,
        status: "completed",
      }),
    );

    const withFiveNormalTools = renderStatusContent(
      [...subagentEntries, ...normalEntries.slice(0, 5)],
      true,
    );
    expect(withFiveNormalTools).not.toContain("🧩 active-memory");
    expect(stripAnsi(withFiveNormalTools)).toContain("💡 skill-harness ▾ ✔");
    expect(withFiveNormalTools).toContain("topic-triage");
    expect(withFiveNormalTools).toContain("normal_tool_4");

    const withSixNormalTools = renderStatusContent(
      [...subagentEntries, ...normalEntries],
      true,
    );
    expect(withSixNormalTools).not.toContain("🧩 active-memory");
    expect(withSixNormalTools).not.toContain("💡 skill-harness");
    expect(withSixNormalTools).toContain("normal_tool_0");
    expect(withSixNormalTools).toContain("normal_tool_5");
  });

  it("keeps subagent result entries at the end when limiting child entries", () => {
    const entries: ToolEntry[] = [
      ...Array.from({ length: 7 }, (_, index) => ({
        toolCallId: `active-memory:mem_${index}`,
        toolName: `active-memory:memory_search_${index}`,
        params: { query: `memory ${index}` },
        status: "completed" as const,
      })),
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "final result" },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));

    expect(result).not.toContain("memory_search_3");
    expect(result).toContain("memory_search_4");
    expect(result).toContain("memory_search_5");
    expect(result.indexOf("memory_search_6")).toBeLessThan(
      result.indexOf("result: final result"),
    );
  });

  it("renders active-memory group with pending suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "pending",
      },
    ];
    const result = renderStatusContent(entries, false);
    expect(stripAnsi(result)).toContain("🧩 active-memory ▾ ←");
  });

  it("renders skill-harness group with pending suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        params: {},
        status: "pending",
      },
    ];
    const result = renderStatusContent(entries, false);
    expect(stripAnsi(result)).toContain("💡 skill-harness ▾ ←");
  });

  it.each([
    ["topic-triage", "topic checker returned no context"],
    ["intent-classify", "classifier returned no result"],
    ["hint-generate", "instruction writer produced no text"],
  ])("renders %s failure under its phase exactly once", (phase, error) => {
    const entries: ToolEntry[] = [
      {
        toolCallId: `skill-harness:run-1:${phase}`,
        toolName: `skill-harness:${phase}`,
        params: { error },
        status: "error",
        error,
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));

    expect(result).toContain("💡 skill-harness ▾ ✘");
    expect(result).toContain(`${phase} ✘`);
    expect(result).toContain(`error: ${error}`);
    expect(result.split(error)).toHaveLength(2);
  });

  it("keeps multiple skill-harness errors associated with their phases", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:run-1:topic-triage",
        toolName: "skill-harness:topic-triage",
        params: { error: "topic checker returned no context" },
        status: "error",
        error: "topic checker returned no context",
      },
      {
        toolCallId: "skill-harness:run-1:intent-classify",
        toolName: "skill-harness:intent-classify",
        params: { error: "classifier returned no result" },
        status: "error",
        error: "classifier returned no result",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));

    expect(result).toContain("topic-triage ✘");
    expect(result).toContain("error: topic checker returned no context");
    expect(result).toContain("intent-classify ✘");
    expect(result).toContain("error: classifier returned no result");
    expect(result.match(/topic checker returned no context/g)).toHaveLength(1);
    expect(result.match(/classifier returned no result/g)).toHaveLength(1);
  });

  it("renders skill-harness plain text result with a result label", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "INTENT:RESEARCH | GOAL: docs" },
        status: "completed",
      },
    ];
    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain("💡 skill-harness ▾ ✔");
    expect(result).toContain("result: INTENT:RESEARCH | GOAL: docs");
  });

  it("renders skill-harness JSON object strings containing colons", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({
            intent: "skill-lifecycle",
            reason: "User said: keep templates separate",
          }),
        },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain("intent: skill-lifecycle");
    expect(result).toContain("reason: User said: keep templates separate");
  });

  it("renders skill-harness result as key-value when JSON object", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({ intent: "RESEARCH", confidence: 0.9 }),
        },
        status: "completed",
      },
    ];
    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain("💡 skill-harness ▾ ✔");
    expect(result).toContain("intent: RESEARCH");
    expect(result).toContain("confidence: 0.9");
  });

  it("renders multiple skill-harness JSON results without result wrappers", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result:1",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({
            keywords: ["收巡", "codex"],
            topic: "user requesting to check or review codex",
            topicChanged: true,
            topicChangeReason: "keyword_delta",
            complexity: "low",
          }),
        },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result:2",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({
            intent: "code-review",
            reason: "User is asking to check or review codex.",
            confidence: 0.75,
            complexity: "low",
          }),
        },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain("💡 skill-harness ▾ ✔");
    expect(result).toContain('keywords: ["收巡","codex"]');
    expect(result).toContain("topic: user requesting to check or review codex");
    expect(result).toContain("intent: code-review");
    expect(result).toContain("confidence: 0.75");
    expect(result).not.toContain("result:");
  });

  it("renders string array skill-harness fields inline", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:topic-continuity-check",
        params: {
          domain: "follow-up",
          keywords: ["再看", "一次"],
          topic: "User is asking to view something again.",
        },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain('keywords: ["再看","一次"]');
    expect(result).not.toContain("keywords: |");
  });

  it("indents multiline phase result under the result key", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:instruction-hint-generation",
        params: {
          result: "Intent: memory-recent\n\nSuggested workflow",
        },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain(
      [
        "        └─ result: |",
        "            Intent: memory-recent",
        "            ",
        "            Suggested workflow",
      ].join("\n"),
    );
  });

  it("renders skill-harness multiline-capable phase fields alphabetically", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:phase",
        toolName: "skill-harness:topic-triage",
        params: {
          topic: "topic line 1\ntopic line 2",
          confidence: 0.9,
          result: "result line 1\nresult line 2",
          reason: "reason line 1\nreason line 2",
          basis: "basis line 1\nbasis line 2",
        },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    const orderedFields = [
      "confidence: 0.9",
      "basis: |",
      "reason: |",
      "result: |",
      "topic: |",
    ];

    for (let index = 1; index < orderedFields.length; index += 1) {
      expect(result.indexOf(orderedFields[index - 1])).toBeLessThan(
        result.indexOf(orderedFields[index]),
      );
    }
  });

  it("applies skill-harness multiline fields to flattened JSON results", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: {
          text: JSON.stringify({
            topic: "topic line 1\ntopic line 2",
            basis: "basis line 1\nbasis line 2",
            reason: "reason line 1\nreason line 2",
            result: "result line 1\nresult line 2",
          }),
        },
        status: "completed",
      },
    ];

    const result = stripAnsi(renderStatusContent(entries, true));
    expect(result).toContain("basis: |");
    expect(result).toContain("reason: |");
    expect(result).toContain("result: |");
    expect(result).toContain("topic: |");
  });

  it("renders active-memory group with error suffix", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "error",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(stripAnsi(result)).toContain("🧩 active-memory ▾ ✘");
  });

  it("renders active-memory error with error message detail", () => {
    const entries: ToolEntry[] = [
      {
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "error",
        error: "timed out after 15000ms",
      },
    ];
    const result = renderStatusContent(entries, true);
    expect(stripAnsi(result)).toContain("🧩 active-memory ▾ ✘");
    expect(stripAnsi(result)).toContain("error: timed out after 15000ms");
  });

  it("renders mixed normal and active-memory entries", () => {
    const entries: ToolEntry[] = [
      makeEntry({ toolName: "web_search", status: "completed" }),
      {
        toolCallId: "am1",
        toolName: "active-memory:search",
        params: {},
        status: "completed",
      },
      makeEntry({ toolName: "read", status: "pending" }),
    ];
    const result = renderStatusContent(entries, false);
    expect(result).toContain("web_search");
    expect(result).toContain("active-memory");
    expect(result).toContain("read");
  });

  it("renders subagent groups first sorted by ascending name", () => {
    const entries: ToolEntry[] = [
      makeEntry({ toolName: "read", status: "pending" }),
      {
        toolCallId: "active-memory:mem1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "active-memory:result",
        toolName: "active-memory:result",
        params: { text: "result" },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "INTENT:RESEARCH" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    const amPos = result.indexOf("active-memory");
    const ihPos = result.indexOf("skill-harness");
    const readPos = result.indexOf("read");
    expect(amPos).toBeLessThan(ihPos);
    expect(ihPos).toBeLessThan(readPos);
    expect(amPos).toBeGreaterThanOrEqual(0);
    expect(ihPos).toBeGreaterThanOrEqual(0);
    expect(readPos).toBeGreaterThanOrEqual(0);
  });

  it("renders subagent groups first sorted by ascending name regardless of input order", () => {
    const entries: ToolEntry[] = [
      makeEntry({ toolName: "bash", status: "completed" }),
      {
        toolCallId: "active-memory:mem1",
        toolName: "active-memory:memory_search",
        params: { query: "test" },
        status: "completed",
      },
      {
        toolCallId: "skill-harness:result",
        toolName: "skill-harness:result",
        params: { text: "INTENT:RESEARCH" },
        status: "completed",
      },
    ];
    const result = renderStatusContent(entries, true);
    const amPos = result.indexOf("active-memory");
    const ihPos = result.indexOf("skill-harness");
    const bashPos = result.indexOf("bash");
    expect(amPos).toBeLessThan(ihPos);
    expect(ihPos).toBeLessThan(bashPos);
    expect(amPos).toBeGreaterThanOrEqual(0);
    expect(ihPos).toBeGreaterThanOrEqual(0);
    expect(bashPos).toBeGreaterThanOrEqual(0);
  });
});

describe("isContentTooLong", () => {
  it("returns true when content exceeds max length", () => {
    expect(isContentTooLong("x".repeat(1701), 1)).toBe(true);
  });

  it("does not use aggregate entry count for content length checks", () => {
    expect(isContentTooLong("short", 7)).toBe(false);
  });

  it("returns false when within limits", () => {
    expect(isContentTooLong("short", 1)).toBe(false);
  });
});
