import { describe, expect, it } from "vitest";
import { pickBestScopeIndex } from "./layer16-clarity.js";

/**
 * Bug (live obs 2026-06-04, deepseek session): the scope askcard hardcoded
 * defaultIndex 0, but buildScopeOptions lists recency-ranked (NOT prompt-matched)
 * bounded contexts first when nothing matches — so the "Recommended" default was
 * an arbitrary subdir (e.g. src/cli) for a repo-wide prompt, with "Entire
 * project" demoted to last. The default must prefer "Entire project" unless the
 * prompt names a specific module.
 */
describe("pickBestScopeIndex", () => {
  const opts = ["src/cli (cli)", "src/council (council)", "Entire project"];

  it("recommends 'Entire project' when the prompt names no specific module", () => {
    expect(pickBestScopeIndex("đánh giá repo này: điểm mạnh, điểm yếu", opts)).toBe(2);
    expect(pickBestScopeIndex("summarize the whole project", opts)).toBe(2);
    expect(pickBestScopeIndex("tóm tắt repo", opts)).toBe(2);
  });

  it("recommends the matching bounded context when the prompt names it", () => {
    expect(pickBestScopeIndex("fix the cli command parser", opts)).toBe(0);
    expect(pickBestScopeIndex("refactor the council debate flow", opts)).toBe(1);
  });

  it("never recommends a ranked (non-matching) bounded context as the default", () => {
    // The core bug: options[0] is arbitrary when nothing matched → must not win.
    expect(pickBestScopeIndex("improve overall quality", opts)).not.toBe(0);
  });

  it("falls back to the last option when 'Entire project' is absent", () => {
    // Prompt names neither module → no match → last option is the safe fallback.
    expect(pickBestScopeIndex("xyz qrs", ["src/auth (auth)", "src/billing (billing)"])).toBe(1);
  });
});
