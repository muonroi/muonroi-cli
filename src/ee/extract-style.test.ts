// src/ee/extract-style.test.ts
//
// Personality / working-style extraction — the WRITE arm that closes the who-am-i loop.
// The READ arm (who-am-i-brain) derives dims FROM experience-behavioral; this arm mines the
// user's style from a session transcript and writes it BACK as natural-language rules. These
// tests cover the gating (confidence floor, length bounds, per-session cap, dedup), the brain
// call contract (systemPrompt override + useExtractModel, mirroring the READ side's live-VPS
// regression), stable merge titles, and fail-open behaviour.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStyleExtractPrompt,
  extractStyleSignals,
  isStyleExtractEnabled,
  parseStyleRules,
  type StyleExtractDeps,
  styleRuleTitle,
  writeStyleSignals,
} from "./extract-style.js";
import type { WriteExperienceResult } from "./search.js";

const GOOD_JSON = JSON.stringify({
  rules: [
    { rule: "The user prefers concise answers — skip preamble and lead with the recommendation.", confidence: 0.86 },
    { rule: "The user decides fast and dislikes being asked to confirm obvious next steps.", confidence: 0.79 },
  ],
});

function depsFrom(classifyOut: string | null): StyleExtractDeps & {
  classifyViaBrain: ReturnType<typeof vi.fn>;
  writeExperience: ReturnType<typeof vi.fn>;
} {
  return {
    classifyViaBrain: vi.fn(async () => classifyOut),
    writeExperience: vi.fn(async (): Promise<WriteExperienceResult> => ({ ok: true, id: "x" })),
  };
}

const LONG_TRANSCRIPT = "User: ".padEnd(200, "x");

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MUONROI_STYLE_EXTRACT;
});

describe("isStyleExtractEnabled — default ON, opt-out with =0", () => {
  it("is enabled by default", () => {
    delete process.env.MUONROI_STYLE_EXTRACT;
    expect(isStyleExtractEnabled()).toBe(true);
  });
  it("is disabled when MUONROI_STYLE_EXTRACT=0", () => {
    process.env.MUONROI_STYLE_EXTRACT = "0";
    expect(isStyleExtractEnabled()).toBe(false);
  });
});

describe("buildStyleExtractPrompt", () => {
  it("asks for the rules JSON schema and embeds the transcript", () => {
    const p = buildStyleExtractPrompt("User: do X\nAssistant: done");
    expect(p).toMatch(/rules/);
    expect(p).toContain("confidence");
    expect(p).toContain("User: do X");
    // must steer toward STYLE not task, and bless the empty answer
    expect(p.toLowerCase()).toContain("working");
    expect(p.toLowerCase()).toContain("empty array");
  });
});

describe("parseStyleRules — gating", () => {
  it("keeps well-formed high-confidence rules", () => {
    const rules = parseStyleRules(GOOD_JSON);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.rule).toContain("concise");
  });

  it("tolerates a ```json fenced block wrapped in prose", () => {
    const noisy = "Here you go:\n```json\n" + GOOD_JSON + "\n```\ndone";
    expect(parseStyleRules(noisy)).toHaveLength(2);
  });

  it("drops rules below the confidence floor (0.7)", () => {
    const low = JSON.stringify({
      rules: [{ rule: "The user might like short replies sometimes here.", confidence: 0.5 }],
    });
    expect(parseStyleRules(low)).toHaveLength(0);
  });

  it("drops too-short (vague) and too-long (task-prose) rules", () => {
    const bad = JSON.stringify({
      rules: [
        { rule: "concise", confidence: 0.9 }, // too short
        { rule: "x".repeat(300), confidence: 0.9 }, // too long
      ],
    });
    expect(parseStyleRules(bad)).toHaveLength(0);
  });

  it("dedups by normalized text", () => {
    const dup = JSON.stringify({
      rules: [
        { rule: "The user prefers concise answers overall here.", confidence: 0.9 },
        { rule: "the   user prefers concise answers overall here.", confidence: 0.85 },
      ],
    });
    expect(parseStyleRules(dup)).toHaveLength(1);
  });

  it("caps at 3 rules per session", () => {
    const many = JSON.stringify({
      rules: Array.from({ length: 6 }, (_, i) => ({
        rule: `The user demonstrates durable style signal number ${i} clearly.`,
        confidence: 0.9,
      })),
    });
    expect(parseStyleRules(many)).toHaveLength(3);
  });

  it("returns [] on garbage / empty / non-array rules (fail-open)", () => {
    expect(parseStyleRules("not json {oops")).toHaveLength(0);
    expect(parseStyleRules("")).toHaveLength(0);
    expect(parseStyleRules(JSON.stringify({ rules: "nope" }))).toHaveLength(0);
    expect(parseStyleRules(JSON.stringify({}))).toHaveLength(0);
  });
});

describe("styleRuleTitle — stable merge key", () => {
  it("derives a deterministic user-style: title from significant words", () => {
    const t = styleRuleTitle("The user prefers concise answers — skip preamble entirely.");
    expect(t).toMatch(/^user-style:/);
    // same rule → same title (merge across sessions)
    expect(styleRuleTitle("The user prefers concise answers — skip preamble entirely.")).toBe(t);
    // stopwords ('the','user','prefers','answers') dropped → content words survive
    expect(t).toContain("concise");
  });
});

describe("extractStyleSignals — brain call contract", () => {
  it("returns [] without calling the brain for a too-short transcript", async () => {
    const deps = depsFrom(GOOD_JSON);
    expect(await extractStyleSignals(deps, "hi")).toHaveLength(0);
    expect(deps.classifyViaBrain).not.toHaveBeenCalled();
  });

  it("passes systemPrompt override + json format + useExtractModel (live-VPS regression)", async () => {
    const deps = depsFrom(GOOD_JSON);
    await extractStyleSignals(deps, LONG_TRANSCRIPT);
    const opts = deps.classifyViaBrain.mock.calls[0]?.[2];
    expect(opts?.systemPrompt).toBeTruthy();
    expect(opts?.responseFormat).toEqual({ type: "json_object" });
    expect(opts?.useExtractModel).toBe(true);
  });

  it("is fail-open: a throwing classifier degrades to [] (never throws)", async () => {
    const deps: StyleExtractDeps = {
      classifyViaBrain: vi.fn(async () => {
        throw new Error("brain down");
      }),
      writeExperience: vi.fn(async () => ({ ok: true, id: "x" }) as WriteExperienceResult),
    };
    await expect(extractStyleSignals(deps, LONG_TRANSCRIPT)).resolves.toHaveLength(0);
  });
});

describe("writeStyleSignals — end-to-end WRITE arm", () => {
  it("writes each gated rule to experience-behavioral with a stable title + confidence", async () => {
    const deps = depsFrom(GOOD_JSON);
    const n = await writeStyleSignals(deps, LONG_TRANSCRIPT, { projectSlug: "muonroi-cli" });
    expect(n).toBe(2);
    const [lesson, opts] = deps.writeExperience.mock.calls[0] ?? [];
    expect(lesson).toContain("concise");
    expect(opts.collection).toBe("experience-behavioral");
    expect(opts.title).toMatch(/^user-style:/);
    expect(opts.projectSlug).toBe("muonroi-cli");
    expect(opts.confidence).toBeCloseTo(0.86);
  });

  it("writes nothing when the flag is off", async () => {
    process.env.MUONROI_STYLE_EXTRACT = "0";
    const deps = depsFrom(GOOD_JSON);
    expect(await writeStyleSignals(deps, LONG_TRANSCRIPT)).toBe(0);
    expect(deps.classifyViaBrain).not.toHaveBeenCalled();
    expect(deps.writeExperience).not.toHaveBeenCalled();
  });

  it("writes nothing when the brain yields no rules", async () => {
    const deps = depsFrom(JSON.stringify({ rules: [] }));
    expect(await writeStyleSignals(deps, LONG_TRANSCRIPT)).toBe(0);
    expect(deps.writeExperience).not.toHaveBeenCalled();
  });

  it("is fail-open per write: one failing write does not abort the rest", async () => {
    const deps = depsFrom(GOOD_JSON);
    deps.writeExperience
      .mockImplementationOnce(async () => {
        throw new Error("qdrant down");
      })
      .mockImplementationOnce(async () => ({ ok: true, id: "y" }) as WriteExperienceResult);
    expect(await writeStyleSignals(deps, LONG_TRANSCRIPT)).toBe(1);
  });

  it("counts only ok writes (a not_stored result does not increment)", async () => {
    const deps = depsFrom(GOOD_JSON);
    deps.writeExperience
      .mockImplementationOnce(async () => ({ ok: false, error: "not_stored" }) as WriteExperienceResult)
      .mockImplementationOnce(async () => ({ ok: true, id: "y" }) as WriteExperienceResult);
    expect(await writeStyleSignals(deps, LONG_TRANSCRIPT)).toBe(1);
  });
});
