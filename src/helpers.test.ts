import { describe, expect, it } from "vitest";
import { isEmptyStatusContent } from "./helpers.js";

describe("isEmptyStatusContent", () => {
  it("treats undefined and empty or whitespace-only strings as empty", () => {
    expect(isEmptyStatusContent(undefined)).toBe(true);
    expect(isEmptyStatusContent("")).toBe(true);
    expect(isEmptyStatusContent("   ")).toBe(true);
    expect(isEmptyStatusContent("\n\t  \n")).toBe(true);
  });

  it("treats empty ANSI code block fences as empty", () => {
    expect(isEmptyStatusContent("```ansi\n\n```")).toBe(true);
    expect(isEmptyStatusContent("```ansi\n```")).toBe(true);
    expect(isEmptyStatusContent("```\nansi\n```")).toBe(true);
    expect(isEmptyStatusContent("```ansi```")).toBe(true);
    expect(isEmptyStatusContent("```\n```")).toBe(true);
    expect(isEmptyStatusContent("``````")).toBe(true);
    expect(isEmptyStatusContent("```ansi\r\n\r\n```")).toBe(true);
    expect(isEmptyStatusContent("```ansi\n   \n```")).toBe(true);
    expect(isEmptyStatusContent("````ansi\n\n````")).toBe(true);
  });

  it("treats ANSI escape codes inside empty code fences as empty", () => {
    expect(isEmptyStatusContent("```ansi\n\u001b[0m\n```")).toBe(true);
    expect(isEmptyStatusContent("```ansi\n\u001b[1;36m\u001b[0m\n```")).toBe(
      true,
    );
  });

  it("does not treat fences with meaningful content as empty", () => {
    expect(isEmptyStatusContent("```ansi\n⚙️ bash ✔\n```")).toBe(false);
    expect(isEmptyStatusContent("```ansi\n👥 subagents ▾\n```")).toBe(false);
    expect(isEmptyStatusContent("```ansi\nhello world\n```")).toBe(false);
    expect(isEmptyStatusContent("plain text")).toBe(false);
  });
});
