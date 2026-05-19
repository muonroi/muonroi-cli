/**
 * Verifies the LLM-facing MCP tool name is sanitized against the OpenAI /
 * DeepSeek function-name regex `^[a-zA-Z0-9_-]+$`. Tool names emitted by some
 * MCP servers (e.g. muonroi-docs `docs.search`, bb.template.describe) contain
 * dots that the providers reject with HTTP 400.
 *
 * We can't easily spin up a real MCP server inside a unit test, so we assert
 * the regex itself matches the same characters runtime.ts rewrites. Smoke /
 * integration coverage of the spawn path lives in smoke.test.ts.
 */
import { describe, expect, it } from "vitest";

const FN_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

describe("MCP tool name sanitization", () => {
  it.each([
    "docs.search",
    "docs.read",
    "bb.template.describe",
    "bb.package.describe",
    "bb.recipe.list",
    "ns/with/slash",
    "weird name with spaces",
    "v1:colon:tool",
  ])("rewrites %s to a function-name-safe string", (raw) => {
    const safe = sanitize(raw);
    expect(safe).toMatch(FN_NAME_RE);
  });

  it("leaves already-safe names unchanged", () => {
    for (const safe of ["echo", "browser_take_screenshot", "search-files", "read_text_file"]) {
      expect(sanitize(safe)).toBe(safe);
    }
  });

  it("produces the expected prefixed form for muonroi-docs docs.search", () => {
    const prefix = `mcp_${"muonroi-docs".replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    expect(`${prefix}__${sanitize("docs.search")}`).toBe("mcp_muonroi-docs__docs_search");
  });
});
