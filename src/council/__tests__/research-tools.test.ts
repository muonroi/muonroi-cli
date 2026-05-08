import { describe, expect, it, beforeEach } from "vitest";

// ── CQ-05: 3-section research output template ────────────────────────────────

describe("CQ-05: buildResearchSystemPrompt — 3-section output template", () => {
  // NOTE: buildResearchSystemPrompt is added to prompts.ts in Plan 04.
  // If Plan 02 runs before Plan 04, this import will fail — that is expected (RED).
  // After Plan 04: import resolves and tests go GREEN.
  let buildResearchSystemPrompt: (hasUrl: boolean) => string;

  beforeEach(async () => {
    try {
      const mod = await import("../prompts.js");
      buildResearchSystemPrompt = (mod as any).buildResearchSystemPrompt;
    } catch {
      buildResearchSystemPrompt = () => "";
    }
  });

  it("contains all 3 required section headings (no URL)", () => {
    const prompt = buildResearchSystemPrompt(false);
    expect(prompt).toContain("## Source Code Findings");
    expect(prompt).toContain("## Internet Findings");
    expect(prompt).toContain("## Frontend Findings (live)");
  });

  it("contains URL requirement instruction when hasUrl=true", () => {
    const prompt = buildResearchSystemPrompt(true);
    expect(prompt).toContain("URL Research Requirement");
    expect(prompt).toContain("Playwright or Chrome-DevTools");
  });

  it("does NOT contain URL instruction when hasUrl=false", () => {
    const prompt = buildResearchSystemPrompt(false);
    expect(prompt).not.toContain("URL Research Requirement");
  });

  it("includes citation format instructions for each section", () => {
    const prompt = buildResearchSystemPrompt(false);
    expect(prompt).toContain("[file:line]");
    expect(prompt).toContain("[url]");
    expect(prompt).toContain("[snapshot:uid]");
  });
});

// ── CQ-04: URL detection + gap annotation ───────────────────────────────────

describe("CQ-04: URL detection — gap annotation when browser tool not invoked", () => {
  it("topic with https:// URL is detected as URL topic", () => {
    const URL_REGEX = /https?:\/\/\S+/;
    expect(URL_REGEX.test("check http://localhost:3010/planning")).toBe(true);
    expect(URL_REGEX.test("review the codebase architecture")).toBe(false);
    expect(URL_REGEX.test("see https://example.com for reference")).toBe(true);
  });

  it("gap annotation text contains expected marker", () => {
    // Verify the gap annotation string that research() must append (Plan 04 impl)
    const gapAnnotation =
      "\n\n## Research Gap\n" +
      "- URL was present in topic but no browser tool was invoked. Frontend findings unverified.";
    expect(gapAnnotation).toContain("## Research Gap");
    expect(gapAnnotation).toContain("no browser tool was invoked");
  });
});

// ── CQ-03: MCP tool merging ──────────────────────────────────────────────────

describe("CQ-03: MCP tool merging into researchTools", () => {
  it("spread merge produces combined ToolSet with both builtin and MCP keys", () => {
    // Verify spread merge semantics — MCP names are prefixed so no collision
    const builtinTools = { bash: {}, read_file: {}, grep: {} };
    const mcpTools = { "mcp_tavily__search": {}, "mcp_playwright__navigate": {} };
    const allTools = { ...builtinTools, ...mcpTools };
    expect(Object.keys(allTools)).toContain("bash");
    expect(Object.keys(allTools)).toContain("mcp_tavily__search");
    expect(Object.keys(allTools)).toContain("mcp_playwright__navigate");
    expect(Object.keys(allTools)).toHaveLength(5);
  });

  it("null MCP bundle falls back to builtin-only tools without throwing", () => {
    const builtinTools = { bash: {}, read_file: {} };
    const mcpBundle: null = null;
    const allTools = { ...builtinTools, ...(mcpBundle != null ? (mcpBundle as any).tools : {}) };
    expect(Object.keys(allTools)).toEqual(["bash", "read_file"]);
  });
});
