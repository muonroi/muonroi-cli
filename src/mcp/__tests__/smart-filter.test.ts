import { describe, expect, it } from "vitest";
import { filterMcpServersByMessage } from "../smart-filter.js";

// Minimal shape — the real McpServerConfig has more fields, but the filter only
// reads `.id`. Using a structural stub keeps the test independent of config.
const servers = [
  { id: "filesystem" },
  { id: "muonroi-tools" },
  { id: "muonroi-harness" },
  { id: "context7" },
  { id: "fetch" },
  { id: "tavily" },
  { id: "chrome-devtools" },
  { id: "playwright" },
  { id: "figma" },
];

const ids = (s: Array<{ id: string }>): string[] => s.map((x) => x.id);

describe("filterMcpServersByMessage", () => {
  it("drops browser AND docs/web servers when the message signals neither", () => {
    // A pure code prompt with no docs/web/browser vocabulary should not pay for
    // context7/fetch (docs/web lookup) or chrome/playwright/figma (browser).
    const out = filterMcpServersByMessage(servers, "fix the auth bug in src/auth/login.ts");
    expect(ids(out)).toEqual(["filesystem", "muonroi-tools", "muonroi-harness"]);
  });

  it("keeps browser servers when a browser signal is present", () => {
    const out = filterMcpServersByMessage(servers, "take a screenshot of the dashboard");
    expect(ids(out)).toContain("chrome-devtools");
    expect(ids(out)).toContain("playwright");
    expect(ids(out)).toContain("figma");
  });

  it("keeps docs/web servers when a docs signal is present", () => {
    const out = filterMcpServersByMessage(servers, "how do I use the zod library API?");
    expect(ids(out)).toContain("context7");
    expect(ids(out)).toContain("fetch");
    // web-search server is also an external-lookup server → kept on a docs signal.
    expect(ids(out)).toContain("tavily");
  });

  it("drops the web-search server on a pure code prompt (no external-info signal)", () => {
    const out = filterMcpServersByMessage(servers, "fix the auth bug in src/auth/login.ts");
    expect(ids(out)).not.toContain("tavily");
  });

  it("keeps the web-search server on web-search intent (low-collision terms)", () => {
    for (const msg of [
      "search the web for the release date",
      "look up the latest news on this",
      "what's the weather today",
      "find this online",
      "check the internet for outages",
    ]) {
      const out = filterMcpServersByMessage(servers, msg);
      expect(ids(out), msg).toContain("tavily");
    }
  });

  it("keeps both browser and docs servers when the message has a URL", () => {
    const out = filterMcpServersByMessage(servers, "summarize https://example.com/article");
    expect(ids(out)).toContain("context7");
    expect(ids(out)).toContain("fetch");
    expect(ids(out)).toContain("chrome-devtools");
  });

  it("NEVER drops non-optional domain servers (filesystem / tools / harness)", () => {
    const out = filterMcpServersByMessage(servers, "Reply with exactly one word: PONG");
    expect(ids(out)).toContain("filesystem");
    expect(ids(out)).toContain("muonroi-tools");
    expect(ids(out)).toContain("muonroi-harness");
  });

  it("returns every server unchanged when disabled (MUONROI_DISABLE_SMART_MCP=1)", () => {
    const out = filterMcpServersByMessage(servers, "Reply PONG", { disabled: true });
    expect(ids(out)).toEqual(ids(servers));
  });

  it("preserves the existing browser-gate vocabulary exactly", () => {
    // Regression guard: each token that the original inline regex recognised
    // must still keep browser servers.
    for (const word of ["browser", "playwright", "chrome", "figma", "canva", "render", "navigate", "click", "scrape"]) {
      const out = filterMcpServersByMessage(servers, `please ${word} something`);
      expect(ids(out)).toContain("chrome-devtools");
    }
  });
});
