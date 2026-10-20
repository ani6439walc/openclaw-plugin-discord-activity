import { describe, expect, it } from "vitest";
import { formatLearnedNotice, parseLearnedNotice } from "./learned-notice.js";

const notice = (body: string) =>
  `💾 Learned: ${body}. Say "undo" to revert this skill change.`;

describe("parseLearnedNotice", () => {
  it("parses one skill with a summary", () => {
    expect(
      parseLearnedNotice(notice("updated `deploy-staging` (added tag check)")),
    ).toEqual([
      {
        verb: "updated",
        skillName: "deploy-staging",
        summary: "added tag check",
      },
    ]);
  });

  it("parses several skills in order, including a created skill and an empty summary", () => {
    expect(
      parseLearnedNotice(
        notice(
          "created `alpha` (new flow); archived `beta`; restored `gamma` (x)",
        ),
      ),
    ).toEqual([
      { verb: "created", skillName: "alpha", summary: "new flow" },
      { verb: "archived", skillName: "beta", summary: "" },
      { verb: "restored", skillName: "gamma", summary: "x" },
    ]);
  });

  it("keeps parentheses and semicolons inside a summary", () => {
    expect(
      parseLearnedNotice(
        notice("updated `alpha` (use pnpm (not npm); retry once)"),
      ),
    ).toEqual([
      {
        verb: "updated",
        skillName: "alpha",
        summary: "use pnpm (not npm); retry once",
      },
    ]);
  });

  it.each([
    'Here is how it looks: 💾 Learned: updated `a` (x). Say "undo" to revert this skill change.',
    notice("updated `a` (x)") + " Anything else?",
    "💾 Learned: updated `a` (x).",
    notice("rewrote `a` (x)"),
    notice("updated `a` trailing"),
    notice("updated `Bad_Name` (x)"),
    "plain reply",
    "",
  ])("leaves non-notice text alone: %s", (text) => {
    expect(parseLearnedNotice(text)).toBeUndefined();
  });
});

describe("formatLearnedNotice", () => {
  it("formats one clause per skill joined with a full-width semicolon", () => {
    expect(
      formatLearnedNotice([
        { verb: "created", skillName: "alpha", summary: "new flow" },
        { verb: "updated", skillName: "beta", summary: "" },
        { verb: "archived", skillName: "gamma", summary: "unused" },
        { verb: "restored", skillName: "delta", summary: "back" },
      ]),
    ).toBe(
      "已新增技能 `alpha`（new flow）；已更新技能 `beta`；已封存技能 `gamma`（unused）；已還原技能 `delta`（back）。跟我說還原就可以改回去。",
    );
  });

  it("prefers a provided summary and falls back to the original", () => {
    expect(
      formatLearnedNotice(
        [
          { verb: "updated", skillName: "alpha", summary: "orig a" },
          { verb: "updated", skillName: "beta", summary: "orig b" },
        ],
        new Map([
          ["alpha", "部署前會先檢查標籤"],
          ["beta", "  "],
        ]),
      ),
    ).toBe(
      "已更新技能 `alpha`（部署前會先檢查標籤）；已更新技能 `beta`（orig b）。跟我說還原就可以改回去。",
    );
  });
});
