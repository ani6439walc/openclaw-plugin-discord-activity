import { describe, expect, it } from "vitest";
import { ANSI } from "./ansi.js";
import { getToolIcon } from "./formatting.js";
import { renderStatusContent, renderStatusContentWithState } from "./render.js";
import type { ToolEntry } from "./types.js";

function entry(
  overrides: Partial<ToolEntry> & { result?: unknown } = {},
): ToolEntry {
  return {
    toolCallId: "decision",
    toolName: "decision_evaluate",
    params: {
      state: null,
      questions: {
        reply: {
          type: "boolean",
          instructions: "是否需要回覆？",
          criteria: { true: "有直接提問", false: "不需要回應" },
        },
      },
    },
    status: "completed",
    durationMs: 952,
    ...overrides,
  };
}

function outcome(answers: Record<string, unknown>): unknown {
  return { status: "ok", result: { model: "test", answers } };
}

function visible(e: ToolEntry, maxLength = 12_000): string {
  return renderStatusContent([e], true, maxLength).replaceAll(
    /\u001b\[[0-9;]*m/g,
    "",
  );
}

const booleanResult = outcome({
  reply: { type: "boolean", probabilityTrue: 0.82 },
});

describe("decision_evaluate rendering", () => {
  it("renders boolean instructions, both descriptions and complementary probabilities", () => {
    const e = entry({ result: booleanResult });
    expect(visible(e)).toBe(`\`\`\`ansi
⚖️ decision_evaluate ▾ ✔ [952ms]
    » 是否需要回覆？
    ├─ true: 有直接提問 → 82.0%
    ╰─ false: 不需要回應 → 18.0%
\`\`\``);
    const colored = renderStatusContent([e], true, 12_000);
    expect(colored).toContain(
      `${ANSI.boldCyan}⚖️ decision_evaluate${ANSI.reset}`,
    );
    expect(colored).toContain(`${ANSI.magenta}true:${ANSI.reset}`);
    expect(colored).toContain(`${ANSI.green}有直接提問${ANSI.reset}`);
    expect(colored).toContain(`${ANSI.yellow}[952ms]${ANSI.reset}`);
    expect(colored).toContain(`${ANSI.yellow}» 是否需要回覆？${ANSI.reset}`);
  });

  it("renders choice and score criteria in input order, including fractional score", () => {
    const e = entry({
      params: {
        questions: {
          route: {
            type: "choice",
            instructions: "交給哪個部門？",
            criteria: {
              support: "技術問題",
              billing: "帳務問題",
              sales: "購買諮詢",
            },
          },
          urgency: {
            type: "score",
            instructions: "有多緊急？",
            criteria: ["一般", "部分受影響", "服務中斷"],
          },
        },
      },
      result: outcome({
        route: {
          type: "choice",
          choice: "billing",
          probabilities: { sales: 0.05, billing: 0.8, support: 0.15 },
        },
        urgency: { type: "score", score: 1.7, probabilities: [0.1, 0.1, 0.8] },
      }),
    });
    expect(visible(e)).toContain(`» 交給哪個部門？ → billing
    ├─ support: 技術問題 → 15.0%
    ├─ billing: 帳務問題 → 80.0%
    ╰─ sales: 購買諮詢 → 5.0%
    » 有多緊急？ → score: 1.70 / 2
    ├─ 0: 一般 → 10.0%
    ├─ 1: 部分受影響 → 10.0%
    ╰─ 2: 服務中斷 → 80.0%`);
    const colored = renderStatusContent([e], true, 12_000);
    expect(colored).toContain(
      `    ${ANSI.yellow}» 交給哪個部門？${ANSI.reset} → ${ANSI.green}billing${ANSI.reset}`,
    );
    expect(colored).toContain(
      `    ${ANSI.yellow}» 有多緊急？${ANSI.reset} → ${ANSI.magenta}score:${ANSI.reset} ${ANSI.green}1.70 / 2${ANSI.reset}`,
    );
    expect(colored).toContain(
      `    ├─ ${ANSI.magenta}support:${ANSI.reset} ${ANSI.green}技術問題${ANSI.reset} → ${ANSI.green}15.0%${ANSI.reset}`,
    );
  });

  it.each([
    "openclawdecision_evaluate",
    "openclaw.decision_evaluate",
    "openclaw:decision_evaluate",
    "DECISION_EVALUATE",
  ])("recognizes canonical alias %s", (toolName) => {
    expect(getToolIcon(toolName)).toBe("⚖️");
    expect(visible(entry({ toolName, result: booleanResult }))).toContain(
      "true: 有直接提問 → 82.0%",
    );
  });

  it.each([
    { details: booleanResult, content: [] },
    { structuredContent: booleanResult },
    { content: [{ type: "text", text: JSON.stringify(booleanResult) }] },
  ])("reads supported result wrappers", (result) => {
    expect(visible(entry({ result }))).toContain("true: 有直接提問 → 82.0%");
  });

  it.each([undefined, null, "", "  ", "\u001b[31m\u001b[0m"])(
    "falls back to ID for absent instructions: %s",
    (instructions) => {
      const e = entry({
        params: { questions: { reply: { type: "boolean", instructions } } },
        result: booleanResult,
      });
      expect(visible(e)).toContain("» reply\n");
      expect(visible(e)).toContain("true: 未提供描述 → 82.0%");
      expect(visible(e)).toContain("false: 未提供描述 → 18.0%");
    },
  );

  it("preserves sanitized multiline strings and serializes object and array descriptions", () => {
    const e = entry({
      params: {
        questions: {
          reply: {
            type: "boolean",
            instructions: "第一行\n第二行`\u001b[31m",
            criteria: {
              true: { text: "`\u001b[31m直接" },
              false: ["忽略", "閒聊"],
            },
          },
        },
      },
      result: booleanResult,
    });
    const text = visible(e);
    expect(text).toContain("第一行\n      第二行ˋ");
    expect(text).toContain('true: {"text":"ˋ直接"} → 82.0%');
    expect(text).toContain('false: ["忽略","閒聊"] → 18.0%');
    expect(text).not.toContain("\u001b");
  });

  it("handles blank/null descriptions for choice and score", () => {
    const e = entry({
      params: {
        questions: {
          route: { type: "choice", criteria: { a: null, b: "" } },
          rating: { type: "score", criteria: [null, " "] },
        },
      },
      result: outcome({
        route: { type: "choice", choice: "a", probabilities: { a: 1, b: 0 } },
        rating: { type: "score", score: 0, probabilities: [1, 0] },
      }),
    });
    expect(visible(e)).toContain("a: 未提供描述 → 100.0%");
    expect(visible(e)).toContain("b: 未提供描述 → 0.0%");
    expect(visible(e)).toContain("0: 未提供描述 → 100.0%");
    expect(visible(e)).toContain("1: 未提供描述 → 0.0%");
  });

  it("shows pending without consuming a stale result", () => {
    const text = visible(entry({ status: "pending", result: booleanResult }));
    expect(text).toContain("等待結果…");
    expect(text).not.toContain("82.0%");
  });

  it("shows unavailable reason and ignores stale answers", () => {
    const text = visible(
      entry({
        result: {
          status: "unavailable",
          reason: "timeout`\u001b[31m",
          result: {
            answers: { reply: { type: "boolean", probabilityTrue: 0.82 } },
          },
        },
      }),
    );
    expect(text).toContain("timeoutˋ");
    expect(text).not.toContain("82.0%");
  });

  it("shows a terminal error without stale probabilities", () => {
    const text = visible(
      entry({
        status: "error",
        error: "broken`\u001b[31m",
        result: booleanResult,
      }),
    );
    expect(text).toContain("error: brokenˋ");
    expect(text).not.toContain("82.0%");
  });

  it.each([
    undefined,
    "arbitrary text",
    { state: booleanResult },
    { status: "ok", result: { answers: [] } },
    outcome({ reply: { type: "choice", probabilityTrue: 0.82 } }),
    ...[-1, 1.1, Infinity, NaN, "0.82"].map((probabilityTrue) =>
      outcome({ reply: { type: "boolean", probabilityTrue } }),
    ),
  ])("does not invent probabilities from malformed results", (result) => {
    const text = visible(entry({ result }));
    expect(text).toContain("結果未提供");
    expect(text).not.toContain("%");
  });

  it.each([
    { type: "choice", choice: "missing", probabilities: { a: 0.8, b: 0.2 } },
    { type: "choice", choice: "a", probabilities: { a: 0.8 } },
    { type: "choice", choice: "a", probabilities: { a: 0, b: 0 } },
    { type: "choice", choice: "a", probabilities: { a: 0.8, b: -0.2 } },
    { type: "score", score: 3, probabilities: [0.2, 0.8] },
    { type: "score", score: 0.8, probabilities: [0.2] },
    { type: "score", score: 0.8, probabilities: [0, 0] },
    { type: "score", score: 0.8, probabilities: [0.2, Infinity] },
  ])("rejects invalid choice/score results", (answer) => {
    const criteria = answer.type === "choice" ? { a: "A", b: "B" } : ["A", "B"];
    const text = visible(
      entry({
        params: { questions: { q: { type: answer.type, criteria } } },
        result: outcome({ q: answer }),
      }),
    );
    expect(text).toContain("結果未提供");
    expect(text).not.toContain("%");
  });

  it("bounds large inputs and keeps monotonic collapse on later results", () => {
    const questions = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `q${i}`,
        {
          type: "boolean",
          instructions: "描述".repeat(100),
          criteria: { true: "標準".repeat(100) },
        },
      ]),
    );
    const e = entry({ params: { questions }, status: "pending" });
    const first = renderStatusContentWithState([e], false, 450);
    expect(first.content.length).toBeLessThanOrEqual(450);
    expect(first.displayState["tool:decision"]).toBe("collapsed");
    const next = renderStatusContentWithState(
      [entry({ result: booleanResult })],
      true,
      450,
      first.displayState,
    );
    expect(next.displayState["tool:decision"]).toBe("collapsed");
    expect(next.content).not.toContain("82.0%");
    expect(
      visible(
        entry({
          params: { questions: { q: questions.q0 } },
          status: "pending",
        }),
      ),
    ).toContain("(+130 chars)");
  });

  it.each([{ details: { structuredContent: booleanResult } }])(
    "accepts structured content within details",
    (result) => {
      expect(visible(entry({ result }))).toContain("true: 有直接提問 → 82.0%");
    },
  );

  it.each([
    { details: null },
    { details: { status: "unavailable", reason: "authoritative timeout" } },
    { details: { status: "ok", result: { answers: {} } } },
    {
      structuredContent: {
        status: "unavailable",
        reason: "authoritative timeout",
      },
    },
    { isError: true },
  ])(
    "does not replace authoritative missing/error results with stale text",
    (wrapper) => {
      const text = visible(
        entry({
          result: {
            ...wrapper,
            content: [{ type: "text", text: JSON.stringify(booleanResult) }],
          },
        }),
      );
      expect(text).not.toContain("82.0%");
      expect(text).not.toContain("18.0%");
    },
  );

  it("retains valid answers when a separate question has no answer", () => {
    const e = entry({
      params: {
        questions: {
          first: {
            type: "boolean",
            instructions: { prompt: "是否回覆？" },
            criteria: { true: "第一行\n第二行", false: null },
          },
          second: { type: "boolean", instructions: ["問題", "補充"] },
        },
      },
      result: outcome({ first: { type: "boolean", probabilityTrue: 0.82 } }),
    });
    const text = visible(e);
    expect(text).toContain('{"prompt":"是否回覆？"}');
    expect(text).toContain("true: 第一行\n    │   第二行 → 82.0%");
    expect(text).toContain("false: 未提供描述 → 18.0%");
    expect(text).toContain('["問題","補充"]');
    expect(text).toContain("結果未提供");
  });

  it("sanitizes and bounds question IDs, option labels and selected choices", () => {
    const malicious = "`\u001b[31m選項";
    const e = entry({
      params: {
        questions: {
          "`\u001b[31m題目": {
            type: "choice",
            criteria: { [malicious]: "描述", b: "其他" },
          },
        },
      },
      result: outcome({
        "`\u001b[31m題目": {
          type: "choice",
          choice: malicious,
          probabilities: { [malicious]: 1, b: 0 },
        },
      }),
    });
    const text = visible(e);
    expect(text).toContain("ˋ題目 → ˋ選項");
    expect(text).toContain("ˋ選項: 描述 → 100.0%");
    expect(text).not.toContain("\u001b");
  });

  it("bounds removal and never resurrects a removed decision block", () => {
    const e = entry({ result: booleanResult });
    const tiny = renderStatusContentWithState([e], true, 15);
    expect(tiny.content.length).toBeLessThanOrEqual(15);
    expect(tiny.displayState["tool:decision"]).toBe("removed");
    const next = renderStatusContentWithState(
      [e],
      true,
      12_000,
      tiny.displayState,
    );
    expect(next.content).not.toContain("decision_evaluate");
  });

  it("falls back safely when a description cannot serialize to visible JSON", () => {
    const e = entry({
      params: {
        questions: {
          reply: {
            type: "boolean",
            criteria: { true: { toJSON: () => undefined }, false: "" },
          },
        },
      },
      result: booleanResult,
    });
    expect(visible(e)).toContain("true: 未提供描述 → 82.0%");
  });

  it("accepts rounded distributions without forcing their sum to one", () => {
    const e = entry({
      params: {
        questions: { q: { type: "choice", criteria: { a: "A", b: "B" } } },
      },
      result: outcome({
        q: { type: "choice", choice: "a", probabilities: { a: 0.66, b: 0.33 } },
      }),
    });
    expect(visible(e)).toContain("a: A → 66.0%");
    expect(visible(e)).toContain("b: B → 33.0%");
  });

  it("leaves ordinary tools unchanged", () => {
    expect(
      visible(
        entry({
          toolName: "custom_tool",
          params: { query: "hello" },
          result: booleanResult,
        }),
      ),
    ).toContain("⚙️ custom_tool ▾ ✔ [952ms]\n    ╰─ query: hello");
  });
});

describe("decision_evaluate shared state", () => {
  function withState(state: unknown): ToolEntry {
    return entry({
      params: { ...entry().params, state },
      result: booleanResult,
    });
  }

  it("flattens state in input order with a context marker, default color and skill-harness indentation", () => {
    const e = withState({
      zContext: "Shared context",
      aSample: "Short sample",
    });
    const baseline = renderStatusContent([withState(null)], true);
    const lines = baseline.split("\n");
    lines.splice(
      2,
      0,
      "    ≡ zContext: Shared context",
      "    ≡ aSample: Short sample",
    );
    expect(renderStatusContent([e], true)).toBe(lines.join("\n"));
    expect(visible(e)).not.toContain("├─ state");
    expect(visible(e)).not.toContain("├─ zContext");
  });

  it.each([undefined, 2])(
    "renders JSON object strings exactly like object state (JSON indent: %s)",
    (indent) => {
      const state = {
        game: "boxed pigs / pig game",
        players: { small_pig: "烤雞堡", big_pig: "the other pig" },
        payoffs: {
          units: "food net of the run cost",
          neither_presses: { small: 0, big: 0 },
          only_small_presses: { small: 1, big: 4 },
          only_big_presses: { small: 4, big: 9 },
          both_press: { small: -1, big: 5 },
        },
        question:
          "If both play the dominant strategy of the classic one-shot game, who gets more food?",
      };
      const serialized = ` \n${JSON.stringify(state, null, indent)}\n `;
      expect(renderStatusContent([withState(serialized)], true)).toBe(
        renderStatusContent([withState(state)], true),
      );
      const text = visible(withState(serialized));
      expect(text).toContain("    ≡ game: boxed pigs / pig game\n");
      expect(text).toContain(
        '    ≡ players: {"small_pig":"烤雞堡","big_pig":"the other pig"}\n',
      );
      expect(text.match(/^    ≡ /gm)).toHaveLength(4);
    },
  );

  it("normalizes and sanitizes parsed fields before their individual Unicode limits", () => {
    const state = {
      "`\u001b[31mcontext": "a\n  b",
      detail: { text: "a\r\n  b", notes: ["c\nd"] },
      emoji: "😀".repeat(64),
      count: 0,
      flag: false,
      absent: null,
      blank: " \n ",
    };
    const serialized = JSON.stringify(state);
    const actual = renderStatusContent([withState(serialized)], true);
    expect(actual).toBe(renderStatusContent([withState(state)], true));
    expect(actual).toContain("    ≡ ˋcontext: a b\n");
    expect(actual).toContain('    ≡ detail: {"text":"a b","notes":["c d"]}\n');
    expect(actual).toContain(
      `    ≡ emoji: ${"😀".repeat(63)}...${ANSI.lightGray} (+1 char)${ANSI.reset}`,
    );
  });

  it.each([
    "ordinary text",
    '{"game": broken}',
    '{"game":"unfinished"',
    "null",
    "false",
    "0",
    '"quoted text"',
    '["one","two"]',
  ])("preserves non-object or invalid JSON text: %s", (state) => {
    expect(visible(withState(state))).toContain(`    ≡ ${state}\n`);
  });

  it("omits an empty JSON object and parses only the outermost string", () => {
    expect(renderStatusContent([withState("{}")], true)).toBe(
      renderStatusContent([withState({})], true),
    );
    expect(
      visible(withState('{"detail":"{\\"note\\":\\"context\\"}"}')),
    ).toContain('    ≡ detail: {"note":"context"}\n');
  });

  it("normalizes CRLF, CR, blank lines and indentation recursively without changing the input", () => {
    const state = {
      context: "First  sentence.\r\n    Second.\n\n  Third.\r Fourth.",
      detail: {
        speaker: "yuu\n（姊姊）",
        notes: ["a\r\nb", { text: "c\n\td" }],
      },
      literal: "a\\nb\nc",
    };
    const original = JSON.stringify(state);
    const text = visible(withState(state));
    expect(text).toContain(
      "≡ context: First  sentence. Second. Third. Fourth.\n",
    );
    expect(text).toContain(
      '≡ detail: {"speaker":"yuu （姊姊）","notes":["a b",{"text":"c d"}]}\n',
    );
    expect(text).toContain("≡ literal: a\\nb c\n");
    expect(text).not.toContain("\r");
    expect(JSON.stringify(state)).toBe(original);
  });

  it("uses ordinary Unicode-aware truncation and a gray omission hint", () => {
    const e = withState({ context: "😀".repeat(71) });
    const colored = renderStatusContent([e], true);
    expect(colored).toContain(
      `≡ context: ${"😀".repeat(61)}...${ANSI.lightGray} (+10 chars)${ANSI.reset}`,
    );
  });

  it("counts the key, colon and space in the 70-code-point limit", () => {
    const text = visible(
      withState({
        exact: "a".repeat(63),
        extra: "a".repeat(64),
      }),
    );
    expect(text).toContain(`    ≡ exact: ${"a".repeat(63)}\n`);
    expect(text).toContain(`    ≡ extra: ${"a".repeat(63)}... (+1 char)\n`);
  });

  it("bounds long Unicode keys and counts sanitized characters", () => {
    const key = "😀".repeat(71);
    const text = visible(
      withState({
        [key]: "value",
        "\u001b[31mkey\u001b[0m": "a".repeat(66),
      }),
    );
    expect(text).toContain(`    ≡ ${"😀".repeat(70)}... (+8 chars)\n`);
    expect(text).toContain(`    ≡ key: ${"a".repeat(65)}... (+1 char)\n`);
  });

  it("normalizes before counting omitted characters", () => {
    const text = visible(
      withState({ context: "a".repeat(35) + "\n    " + "b".repeat(36) }),
    );
    expect(text).toContain(
      `≡ context: ${"a".repeat(35)} ${"b".repeat(25)}... (+11 chars)`,
    );
  });

  it("normalizes nested JSON before applying the ordinary value limit", () => {
    const text = visible(
      withState({
        detail: { text: "a".repeat(50) + "\n\n    " + "b".repeat(40) },
      }),
    );
    const normalized =
      '{"text":"' + "a".repeat(50) + " " + "b".repeat(40) + '"}';
    expect(text).toContain(
      `≡ detail: ${normalized.slice(0, 62)}... (+${normalized.length - 62} chars)`,
    );
  });

  it("sanitizes state keys and nested text before displaying JSON", () => {
    const e = withState({
      "`\u001b[31mcontext": "safe`\u001b[31m\nnext",
      nested: { note: "safe`\u001b[31m\nnext" },
    });
    const text = visible(e);
    expect(text).toContain("≡ ˋcontext: safeˋ next");
    expect(text).toContain('≡ nested: {"note":"safeˋ next"}');
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\\u001b");
  });

  it.each([
    ["first\nsecond", "≡ first second"],
    [
      ["first\nsecond", { text: "third\nfourth" }],
      '≡ ["first second",{"text":"third fourth"}]',
    ],
  ])(
    "handles string and array state without adding a container label",
    (state, expected) => {
      expect(visible(withState(state))).toContain(expected);
    },
  );

  it("preserves ordinary empty-field behavior and shows zero and false", () => {
    const text = visible(
      withState({
        empty: " \n ",
        absent: null,
        missing: undefined,
        count: 0,
        flag: false,
      }),
    );
    expect(text).toContain("≡ count: 0");
    expect(text).toContain("≡ flag: false");
    expect(text).not.toMatch(/≡ (empty|absent|missing):/);
  });

  it("keeps all three question/result displays unchanged when adding state", () => {
    const params = {
      state: null as unknown,
      questions: {
        boolean: {
          type: "boolean",
          instructions: "First\nsecond",
          criteria: { true: "Yes\nindeed", false: "No" },
        },
        choice: { type: "choice", criteria: { a: "A", b: "B" } },
        score: { type: "score", criteria: ["Low", "High"] },
      },
    };
    const result = outcome({
      boolean: { type: "boolean", probabilityTrue: 0.82 },
      choice: {
        type: "choice",
        choice: "a",
        probabilities: { a: 0.8, b: 0.2 },
      },
      score: { type: "score", score: 0.7, probabilities: [0.3, 0.7] },
    });
    const baseline = renderStatusContent([entry({ params, result })], true);
    const lines = baseline.split("\n");
    lines.splice(2, 0, "    ≡ context: Shared context");
    for (const state of [
      { context: "Shared\ncontext" },
      JSON.stringify({ context: "Shared\ncontext" }),
    ]) {
      const actual = renderStatusContent(
        [entry({ params: { ...params, state }, result })],
        true,
      );
      expect(actual).toBe(lines.join("\n"));
      expect(actual).toContain(
        `${ANSI.yellow}» First${ANSI.reset}\n      ${ANSI.yellow}second${ANSI.reset}`,
      );
    }
  });

  it("handles nonserializable state without hiding valid question results", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const text = visible(
      withState({ detail: cycle, absent: { toJSON: () => undefined } }),
    );
    expect(text).toContain("≡ detail: [unserializable]");
    expect(text).not.toContain("≡ absent:");
    expect(text).toContain("true: 有直接提問 → 82.0%");
  });

  it("stays bounded when shared state exceeds the message budget", () => {
    const e = withState(
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`field${i}`, "a".repeat(100)]),
      ),
    );
    const first = renderStatusContentWithState([e], false, 250);
    expect(first.content.length).toBeLessThanOrEqual(250);
    expect(first.displayState["tool:decision"]).toBe("collapsed");
    const next = renderStatusContentWithState(
      [withState(null)],
      true,
      1700,
      first.displayState,
    );
    expect(next.displayState["tool:decision"]).toBe("collapsed");
    expect(next.content).not.toContain("82.0%");
  });
});
