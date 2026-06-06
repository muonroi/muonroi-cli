import { afterEach, describe, expect, it } from "vitest";
import { dropRedundantFsMcpTools, filterMcpServersByMessage } from "../smart-filter.js";

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

describe("dropRedundantFsMcpTools", () => {
  const fn = () => ({});
  afterEach(() => {
    delete process.env.MUONROI_KEEP_REDUNDANT_FS_MCP;
  });

  it("drops filesystem-MCP read/write/edit tools when the builtin equivalent is present", () => {
    // Live waste (grok session f5dfab0ce0ca): files re-read via both read_file
    // and mcp_filesystem__read_text_file.
    const mcp = {
      mcp_filesystem__read_text_file: fn,
      mcp_filesystem__read_file: fn,
      mcp_filesystem__read_multiple_files: fn,
      mcp_filesystem__write_file: fn,
      mcp_filesystem__edit_file: fn,
      mcp_filesystem__directory_tree: fn, // NOT a builtin dup — keep
      mcp_filesystem__search_files: fn, // keep
      mcp_other__read_text_file: fn, // different server — keep
    };
    const builtins = new Set(["read_file", "write_file", "edit_file", "bash", "grep", "glob"]);
    const { tools, dropped } = dropRedundantFsMcpTools(mcp, builtins);
    expect(dropped.sort()).toEqual(
      [
        "mcp_filesystem__edit_file",
        "mcp_filesystem__read_file",
        "mcp_filesystem__read_multiple_files",
        "mcp_filesystem__read_text_file",
        "mcp_filesystem__write_file",
      ].sort(),
    );
    expect(Object.keys(tools).sort()).toEqual(
      ["mcp_filesystem__directory_tree", "mcp_filesystem__search_files", "mcp_other__read_text_file"].sort(),
    );
  });

  it("keeps the MCP tool when the builtin equivalent is NOT present (no silent capability loss)", () => {
    const mcp = { mcp_filesystem__read_text_file: fn };
    const { tools, dropped } = dropRedundantFsMcpTools(mcp, new Set(["bash"])); // no builtin read_file
    expect(dropped).toEqual([]);
    expect(Object.keys(tools)).toEqual(["mcp_filesystem__read_text_file"]);
  });

  it("respects MUONROI_KEEP_REDUNDANT_FS_MCP=1 override", () => {
    process.env.MUONROI_KEEP_REDUNDANT_FS_MCP = "1";
    const mcp = { mcp_filesystem__read_text_file: fn };
    const { tools, dropped } = dropRedundantFsMcpTools(mcp, new Set(["read_file"]));
    expect(dropped).toEqual([]);
    expect(Object.keys(tools)).toEqual(["mcp_filesystem__read_text_file"]);
  });
});
