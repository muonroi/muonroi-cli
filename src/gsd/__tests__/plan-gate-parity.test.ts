import { describe, expect, it } from "vitest";
import type { CouncilContextBundle } from "../council-context.js";
import { buildDebateTopic, buildPerspectivePrompt, PLAN_PERSPECTIVES } from "../plan-council-prompts.js";
import { PLAN_GATE_DIMENSIONS, renderGateAxes } from "../plan-gate-vocabulary.js";
import { VERDICT_OUTPUT_CONTRACT } from "../verdict-schema.js";

/**
 * Parity lock (council decision 2026-07-11): the interactive debate gate and the
 * headless perspective gate must judge a plan against the SAME criteria and emit
 * the SAME verdict contract. These tests fail if either path drifts — a new axis
 * added to only one prompt, a perspective that stops mapping to a shared
 * dimension, or a builder that reintroduces its own verdict contract.
 */
const BUNDLE: CouncilContextBundle = {
  state: { phase: "plan", depth: "full", planVerified: false, raw: "" },
  workflowKind: "phase",
  depth: "full",
  contextMd: "",
  researchMd: "",
  assessment: "",
  priorConcerns: [],
  acceptanceCriteria: [],
  totalChars: 0,
  hadPriorConcerns: false,
  revisionCycle: 0,
};

describe("plan-gate parity — interactive debate vs headless perspective", () => {
  it("both gate paths render the SAME evaluation axes from the shared source", () => {
    const axes = renderGateAxes();
    const debate = buildDebateTopic("# Plan\n1. do a thing", BUNDLE);
    // Every headless perspective prompt embeds the shared axes verbatim...
    for (const p of PLAN_PERSPECTIVES) {
      const persp = buildPerspectivePrompt(p, "# Plan\n1. do a thing");
      expect(persp, p.id).toContain(axes);
    }
    // ...and so does the interactive debate topic. Same string → cannot drift.
    expect(debate).toContain(axes);
  });

  it("both gate paths emit the SAME verdict contract (single schema)", () => {
    const debate = buildDebateTopic("# Plan", BUNDLE);
    expect(debate).toContain(VERDICT_OUTPUT_CONTRACT);
    for (const p of PLAN_PERSPECTIVES) {
      expect(buildPerspectivePrompt(p, "# Plan"), p.id).toContain(VERDICT_OUTPUT_CONTRACT);
    }
  });

  it("the full perspective set covers every shared gate dimension (no orphan axis)", () => {
    const covered = new Set(PLAN_PERSPECTIVES.map((p) => p.dimension));
    for (const dim of PLAN_GATE_DIMENSIONS) {
      expect(covered.has(dim.id), `dimension "${dim.id}" is not owned by any perspective`).toBe(true);
    }
  });

  it("every perspective maps to a real shared dimension (no shadow criteria)", () => {
    const ids = new Set(PLAN_GATE_DIMENSIONS.map((d) => d.id));
    for (const p of PLAN_PERSPECTIVES) {
      expect(ids.has(p.dimension), `perspective "${p.id}" → unknown dimension "${p.dimension}"`).toBe(true);
    }
  });

  it("the axes list names each shared dimension's label (rendering stays in sync)", () => {
    const axes = renderGateAxes();
    for (const d of PLAN_GATE_DIMENSIONS) {
      expect(axes, d.id).toContain(d.label);
    }
  });
});
