/**
 * The council research role had web search and library-docs tooling available
 * and used neither across four `/ideal` runs on a 1,557-file repo (0
 * `web_search`, 0 context7). The repo-first source preference named no external
 * tool at all, and "use web sources only to fill genuine gaps" gave no trigger —
 * so the run emitted NuGet package `Microsoft.CodeAnalysis.Testing`
 * `Version="1.1.1"`, which does not exist (`dotnet restore` → NU1101).
 *
 * These pin the fix at BOTH ends: the builder, and the call site that actually
 * hands a prompt to the research model. A builder assertion alone is not
 * enough — this repo has a documented case where the builder test passed while
 * the call site passed nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { researchWithFallback } from "../debate.js";
import { buildResearchSystemPrompt } from "../prompts.js";
import { buildResearchSourcePreference, decideInternetFirst } from "../research-mode.js";
import type { CouncilLLM } from "../types.js";

describe("buildResearchSourcePreference — repo-first names the external tools", () => {
  const repoFirst = buildResearchSourcePreference(false);

  it("is codebase-first (still prefers the repo)", () => {
    expect(repoFirst).toContain("CODEBASE-FIRST");
    expect(repoFirst).toContain("file:line");
  });

  it("names the always-available web tools by their real tool names", () => {
    expect(repoFirst).toContain("web_search");
    expect(repoFirst).toContain("fetch_url");
  });

  it("names context7 for library/package questions and prefers it over generic search there", () => {
    expect(repoFirst).toContain("context7");
    expect(repoFirst).toContain("mcp_context7__*");
    // The preference must be explicit, not merely a mention.
    expect(/prefer the library-documentation MCP tool[\s\S]*over generic search/i.test(repoFirst)).toBe(true);
  });

  it("states a checkable trigger condition instead of 'genuine gap'", () => {
    // The trigger is the class of claim, ...
    expect(repoFirst).toContain("third-party API");
    expect(repoFirst).toContain("package version");
    // ... and the test for it is syntactic: not citable as file:line in THIS repo.
    expect(repoFirst).toContain("cannot cite as a `file:line` in THIS repo");
    expect(repoFirst).not.toContain("genuine gap");
  });

  it("still names the tools in the internet-first branch", () => {
    const internetFirst = buildResearchSourcePreference(true);
    expect(internetFirst).toContain("INTERNET-FIRST");
    expect(internetFirst).toContain("web_search");
    expect(internetFirst).toContain("fetch_url");
    expect(internetFirst).toContain("context7");
  });
});

describe("both research prompt paths render the SAME source preference", () => {
  it("in-process path: buildResearchSystemPrompt embeds the shared block verbatim", () => {
    expect(buildResearchSystemPrompt(false, false)).toContain(buildResearchSourcePreference(false));
    expect(buildResearchSystemPrompt(false, true)).toContain(buildResearchSourcePreference(true));
  });

  it("CALL SITE — the isolated explore sub-agent prompt embeds the shared block verbatim", async () => {
    const llm = { research: vi.fn() } as unknown as CouncilLLM;
    const runIsolatedTask = vi.fn().mockResolvedValue({ success: true, output: "## Research Findings\nok" });

    await researchWithFallback(
      llm,
      "research-model",
      "topic",
      "ctx",
      undefined,
      () => {},
      { internetFirst: false },
      ["research-model"],
      runIsolatedTask,
    );

    // Assert on the argument actually handed to the research call, not on what
    // the builder returns when called directly.
    expect(llm.research).not.toHaveBeenCalled();
    const prompt = runIsolatedTask.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain(buildResearchSourcePreference(false));
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("context7");
  });

  it("CALL SITE — the isolated prompt flips to the internet-first block when asked", async () => {
    const llm = { research: vi.fn() } as unknown as CouncilLLM;
    const runIsolatedTask = vi.fn().mockResolvedValue({ success: true, output: "## Research Findings\nok" });

    await researchWithFallback(
      llm,
      "research-model",
      "topic",
      "ctx",
      undefined,
      () => {},
      { internetFirst: true },
      ["research-model"],
      runIsolatedTask,
    );

    const prompt = runIsolatedTask.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain(buildResearchSourcePreference(true));
    expect(prompt).not.toContain("CODEBASE-FIRST");
  });
});

describe("decideInternetFirst — the one rule", () => {
  it("is internet-first only when the repo is empty AND a web tier exists", () => {
    expect(decideInternetFirst({ webCapable: true, repoIsEmpty: true })).toBe(true);
  });

  it("never claims internet-first without a working web capability", () => {
    // The old council rule (isEmpty alone) said true here, which rendered
    // "lead with documentation and search" alongside research()'s own
    // "no working web-search capability" gap warning.
    expect(decideInternetFirst({ webCapable: false, repoIsEmpty: true })).toBe(false);
  });

  it("never claims internet-first inside a repo that has source", () => {
    // The old clarifier rule (webTier !== "none" alone) said true here, which
    // told the research role not to grep a 1,557-file repo.
    expect(decideInternetFirst({ webCapable: true, repoIsEmpty: false })).toBe(false);
    expect(decideInternetFirst({ webCapable: false, repoIsEmpty: false })).toBe(false);
  });
});
