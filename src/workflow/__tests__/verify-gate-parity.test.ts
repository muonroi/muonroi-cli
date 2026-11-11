import { describe, expect, it } from "vitest";
import type { CouncilContextBundle } from "../council-context.js";
import { VERDICT_OUTPUT_CONTRACT } from "../verdict-schema.js";
import type { VerifyContextBundle } from "../verify-context.js";
import {
  buildVerifyDebateTopic,
  buildVerifyPerspectivePrompt,
  NO_DIFF_DELIVERABLE_SECTION,
  VERIFY_PERSPECTIVES,
} from "../verify-council-prompts.js";
import { renderVerifyGateAxes, VERIFY_GATE_DIMENSIONS } from "../verify-gate-vocabulary.js";

/**
 * Parity lock for the verify twin gate (PR 2). The interactive verify debate and
 * the headless perspective review must judge an implementation against the SAME
 * criteria and emit the SAME verdict contract — mirrors plan-gate-parity.
 */
const BASE: CouncilContextBundle = {
  state: { phase: "verify", depth: "full", planVerified: true, raw: "" },
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
const BUNDLE: VerifyContextBundle = {
  base: BASE,
  diff: "+ added a line",
  diffChars: 14,
  evidence: "all tests pass",
  hostEvidence: "",
  planVerdict: "pass",
};

describe("verify-gate parity — interactive debate vs headless perspective", () => {
  it("both verify paths render the SAME evaluation axes from the shared source", () => {
    const axes = renderVerifyGateAxes();
    expect(buildVerifyDebateTopic(BUNDLE)).toContain(axes);
    for (const p of VERIFY_PERSPECTIVES) {
      expect(buildVerifyPerspectivePrompt(p, BUNDLE), p.id).toContain(axes);
    }
  });

  it("both verify paths emit the SAME verdict contract (single schema)", () => {
    expect(buildVerifyDebateTopic(BUNDLE)).toContain(VERDICT_OUTPUT_CONTRACT);
    for (const p of VERIFY_PERSPECTIVES) {
      expect(buildVerifyPerspectivePrompt(p, BUNDLE), p.id).toContain(VERDICT_OUTPUT_CONTRACT);
    }
  });

  it("the full perspective set covers every shared verify dimension (no orphan axis)", () => {
    const covered = new Set(VERIFY_PERSPECTIVES.map((p) => p.dimension));
    for (const dim of VERIFY_GATE_DIMENSIONS) {
      expect(covered.has(dim.id), `dimension "${dim.id}" is not owned by any perspective`).toBe(true);
    }
  });

  it("every perspective maps to a real shared dimension (no shadow criteria)", () => {
    const ids = new Set(VERIFY_GATE_DIMENSIONS.map((d) => d.id));
    for (const p of VERIFY_PERSPECTIVES) {
      expect(ids.has(p.dimension), `perspective "${p.id}" → unknown dimension "${p.dimension}"`).toBe(true);
    }
  });

  it("an empty diff renders the no-diff analysis section in BOTH paths, never the diff block", () => {
    const empty: VerifyContextBundle = { ...BUNDLE, diff: "", diffChars: 0 };
    const prompts = [
      buildVerifyDebateTopic(empty),
      ...VERIFY_PERSPECTIVES.map((p) => buildVerifyPerspectivePrompt(p, empty)),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(NO_DIFF_DELIVERABLE_SECTION);
      expect(prompt).toContain("is NOT a concern by itself");
      expect(prompt).not.toContain("Implementation diff under review");
      expect(prompt).not.toContain("(no diff supplied)");
    }
  });

  it("a non-empty diff keeps the diff block and omits the no-diff section", () => {
    for (const prompt of [
      buildVerifyDebateTopic(BUNDLE),
      ...VERIFY_PERSPECTIVES.map((p) => buildVerifyPerspectivePrompt(p, BUNDLE)),
    ]) {
      expect(prompt).toContain("### Implementation diff under review");
      expect(prompt).toContain("+ added a line");
      expect(prompt).not.toContain(NO_DIFF_DELIVERABLE_SECTION);
    }
  });

  it("the axes list names each shared dimension's label (rendering stays in sync)", () => {
    const axes = renderVerifyGateAxes();
    for (const d of VERIFY_GATE_DIMENSIONS) {
      expect(axes, d.id).toContain(d.label);
    }
  });

  // Session 36185ebf61a8: F4 was re-raised in verify rounds 1, 3 and 4 although a worker had
  // already produced that proof; main's capped (4k) evidence left it out. The host block is
  // rendered in BOTH verify paths, separately from main's evidence.
  it("host-recorded worker evidence reaches both verify paths, after main's evidence", () => {
    const withHost = {
      ...BUNDLE,
      hostEvidence: "- steady-teal-otter [general, complete] E2E dual-home byte-compare proof",
    };
    const topic = buildVerifyDebateTopic(withHost);
    expect(topic).toContain("### Host-recorded worker evidence");
    expect(topic).toContain("steady-teal-otter");
    expect(topic.indexOf("all tests pass")).toBeLessThan(topic.indexOf("### Host-recorded worker evidence"));
    for (const p of VERIFY_PERSPECTIVES)
      expect(buildVerifyPerspectivePrompt(p, withHost)).toContain("steady-teal-otter");
    expect(buildVerifyDebateTopic(BUNDLE)).not.toContain("### Host-recorded worker evidence");
  });
});
