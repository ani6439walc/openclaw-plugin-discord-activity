import { describe, expect, it } from "vitest";
import {
  getDisplayToolName,
  isMcpToolName,
  canonicalToolNameForDedupe,
} from "./tool-name.js";

describe("tool-name", () => {
  describe("isMcpToolName", () => {
    it("returns true for tool names with double underscore", () => {
      expect(isMcpToolName("qmd__query")).toBe(true);
      expect(isMcpToolName("mcp__tool__name")).toBe(true);
      expect(isMcpToolName("some__tool")).toBe(true);
    });

    it("returns false for tool names without double underscore", () => {
      expect(isMcpToolName("bash")).toBe(false);
      expect(isMcpToolName("web_search")).toBe(false);
      expect(isMcpToolName("read")).toBe(false);
    });

    it("returns false for valid openclaw tool names", () => {
      expect(isMcpToolName("openclaw.bash")).toBe(false);
      expect(isMcpToolName("openclaw/read")).toBe(false);
    });
  });

  describe("getDisplayToolName", () => {
    it("formats MCP tool names with underscore and (MCP) suffix", () => {
      expect(getDisplayToolName("qmd__query")).toBe("qmd_query (MCP)");
      expect(getDisplayToolName("mcp__tool__name")).toBe("mcp_tool_name (MCP)");
      expect(getDisplayToolName("some__tool")).toBe("some_tool (MCP)");
    });

    it("returns regular tool names unchanged", () => {
      expect(getDisplayToolName("bash")).toBe("bash");
      expect(getDisplayToolName("web_search")).toBe("web_search");
      expect(getDisplayToolName("read")).toBe("read");
      expect(getDisplayToolName("active-memory")).toBe("active-memory");
    });

    it("returns openclaw suffix for openclaw tools", () => {
      expect(getDisplayToolName("openclaw.bash")).toBe("bash");
      expect(getDisplayToolName("openclaw.read")).toBe("read");
      expect(getDisplayToolName("openclaw.web_search")).toBe("web_search");
    });

    it("handles single underscore as regular name", () => {
      expect(getDisplayToolName("web_search")).toBe("web_search");
      expect(getDisplayToolName("memory_search")).toBe("memory_search");
    });
  });

  describe("canonicalToolNameForDedupe", () => {
    it("normalizes MCP tool names without (MCP) suffix", () => {
      expect(canonicalToolNameForDedupe("qmd__query")).toBe("qmd_query");
      expect(canonicalToolNameForDedupe("mcp__tool__name")).toBe(
        "mcp_tool_name",
      );
      expect(canonicalToolNameForDedupe("Some__Tool")).toBe("some_tool");
    });

    it("normalizes openclaw tool names", () => {
      expect(canonicalToolNameForDedupe("openclaw.bash")).toBe("bash");
      expect(canonicalToolNameForDedupe("openclaw.read")).toBe("read");
    });

    it("normalizes regular tool names", () => {
      expect(canonicalToolNameForDedupe("bash")).toBe("bash");
      expect(canonicalToolNameForDedupe("web_search")).toBe("web_search");
      expect(canonicalToolNameForDedupe("Web_Search")).toBe("web_search");
    });
  });
});
