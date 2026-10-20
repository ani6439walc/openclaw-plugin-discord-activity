import { describe, expect, it } from "vitest";
import { parseLearnedNotice } from "./learned-notice.js";

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
