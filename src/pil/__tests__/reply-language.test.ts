import { describe, expect, it } from "vitest";
import { buildDirective, buildLanguageNudge } from "../../playbook/directives.js";
import { applyReplyLanguageNudge } from "../reply-language.js";
import type { PipelineContext } from "../types.js";

function ctx(over: Partial<PipelineContext>): PipelineContext {
  return { raw: "x", enriched: "x", layers: [], ...over } as unknown as PipelineContext;
}

describe("applyReplyLanguageNudge (host-owned reply language)", () => {
  it("appends the nudge for a detected non-English language", () => {
    const out = applyReplyLanguageNudge(ctx({ replyLanguage: "Vietnamese" }));
    expect(out.enriched).toBe(`x\n${buildLanguageNudge("Vietnamese")}`);
    expect(out.layers.at(-1)).toEqual({ name: "reply-language", applied: true, delta: "lang=Vietnamese" });
  });

  it("is a no-op for English (replyLanguage null/undefined)", () => {
    const english = ctx({ replyLanguage: null });
    expect(applyReplyLanguageNudge(english)).toBe(english);
    const unset = ctx({});
    expect(applyReplyLanguageNudge(unset)).toBe(unset);
  });

  it("does not duplicate a nudge a layer-4 directive already carries", () => {
    const directive = buildDirective({ tier: "standard", phase: null, informational: true, replyLanguage: "Japanese" });
    const before = ctx({ replyLanguage: "Japanese", enriched: `x\n${directive.text}` });
    expect(before.enriched).toContain(buildLanguageNudge("Japanese"));
    expect(applyReplyLanguageNudge(before)).toBe(before);
  });
});
