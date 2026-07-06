/**
 * parseConclusion turns a leader-synthesis JSON body into a structured
 * conclusion (summary / strengths / weaknesses / recommendation / coverage) so
 * the UI can render a scannable card instead of dumping raw JSON as freetext.
 * It must return null for prose / non-JSON so the plain-text path takes over.
 */
import { describe, expect, it } from "vitest";
import { parseConclusion, salvageJson } from "../council-conclusion-card.js";

describe("parseConclusion", () => {
  it("extracts sections from an evaluation JSON body", () => {
    const body = JSON.stringify({
      type: "evaluation",
      summary: "The harness has clear structure but no direct protocol tests.",
      strengths: ["Clear module separation", "Has error-injection specs"],
      weaknesses: ["Zero protocol-contract specs"],
      recommendation: "Needs-hardening. Add wrapper-rejection specs.",
      coverage_matrix: [{ contract: "Protocol handshake", coverage: "Untested", evidence: "no imports" }],
    });
    const c = parseConclusion(body);
    expect(c).not.toBeNull();
    expect(c?.summary).toContain("clear structure");
    expect(c?.strengths).toHaveLength(2);
    expect(c?.weaknesses).toEqual(["Zero protocol-contract specs"]);
    expect(c?.recommendation).toContain("Needs-hardening");
    expect(c?.coverage[0]).toContain("Protocol handshake");
  });

  it("strips a ```json fence before parsing", () => {
    const body = "```json\n" + JSON.stringify({ summary: "hi", pros: ["a"] }) + "\n```";
    const c = parseConclusion(body);
    expect(c?.summary).toBe("hi");
    expect(c?.strengths).toEqual(["a"]); // `pros` aliases strengths
  });

  it("maps decision-shaped aliases (decision → recommendation, cons → weaknesses)", () => {
    const c = parseConclusion(JSON.stringify({ summary: "s", decision: "Go with A", cons: ["risk"] }));
    expect(c?.recommendation).toBe("Go with A");
    expect(c?.weaknesses).toEqual(["risk"]);
  });

  it("returns null for a `---READABLE---` prose tail (plain-text path handles it)", () => {
    expect(parseConclusion('{"summary":"x"}\n---READABLE---\n# Nice prose')).toBeNull();
  });

  it("returns null for non-JSON prose", () => {
    expect(parseConclusion("The council decided to go with option A because it is simpler.")).toBeNull();
  });

  it("returns null for JSON carrying only noise keys (nothing renderable)", () => {
    expect(parseConclusion(JSON.stringify({ type: "evaluation", nextActions: [{ action: "x" }] }))).toBeNull();
  });

  it("renders unknown string keys as generic sections instead of dropping to raw JSON", () => {
    const c = parseConclusion(JSON.stringify({ type: "evaluation", foo: "bar" }));
    expect(c).not.toBeNull();
    expect(c?.sections).toEqual([{ title: "Foo", items: ["bar"] }]);
  });
});

describe("salvageJson", () => {
  it("parses valid JSON unchanged", () => {
    expect(salvageJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("salvages JSON truncated mid-string inside a nested array", () => {
    const truncated = '{"summary": "ok", "nextActions": [{"action": "continue"}, {"action": "ask';
    const out = salvageJson(truncated);
    expect(out).not.toBeNull();
    expect(out?.summary).toBe("ok");
  });

  it("salvages JSON truncated between members", () => {
    const truncated = '{"summary": "ok", "risks": ["r1", "r2"],';
    const out = salvageJson(truncated);
    expect(out?.summary).toBe("ok");
    expect(out?.risks).toEqual(["r1", "r2"]);
  });

  it("returns null for hopeless input", () => {
    expect(salvageJson("not json at all")).toBeNull();
  });
});

describe("parseConclusion — implementation_plan shape", () => {
  const implPlan = JSON.stringify({
    type: "implementation_plan",
    summary: "Ship a progressive rollout.",
    agreed_architecture: "Flag served from a polled config endpoint.",
    phases: [
      { phase: "1 Canary", traffic_pct: "1%", gate: "error budget" },
      { phase: "2 Ramp", traffic_pct: "5%", gate: "same" },
    ],
    acceptance_criteria: ["Flag ships dark", "Rollback in 6 minutes"],
    risks: [{ risk: "SW cache", mitigation: "TTL floor", residual: "Medium" }],
  });

  it("extracts summary and generic sections instead of returning null-equivalent content", () => {
    const c = parseConclusion(implPlan);
    expect(c).not.toBeNull();
    expect(c?.summary).toBe("Ship a progressive rollout.");
    const titles = c?.sections.map((s) => s.title) ?? [];
    expect(titles).toContain("Agreed Architecture");
    expect(titles).toContain("Phases");
    expect(titles).toContain("Acceptance Criteria");
  });

  it("flattens object-list rows to ' · '-joined key/value cells", () => {
    const c = parseConclusion(implPlan);
    const phases = c?.sections.find((s) => s.title === "Phases");
    expect(phases?.items[0]).toBe("phase: 1 Canary · traffic_pct: 1% · gate: error budget");
  });

  it("puts object-shaped risks into the generic risks handling, not silently dropped", () => {
    const c = parseConclusion(implPlan);
    const all = JSON.stringify(c);
    expect(all).toContain("SW cache");
  });

  it("parses a TRUNCATED implementation_plan via salvage", () => {
    const truncated = implPlan.slice(0, implPlan.length - 30);
    const c = parseConclusion(truncated);
    expect(c).not.toBeNull();
    expect(c?.summary).toBe("Ship a progressive rollout.");
  });

  it("skips noise keys: type, nextActions, sections", () => {
    const c = parseConclusion(
      JSON.stringify({ summary: "s", type: "decision", nextActions: [{ action: "x" }], sections: { a: 1 } }),
    );
    const titles = c?.sections.map((s) => s.title) ?? [];
    expect(titles).not.toContain("Type");
    expect(titles).not.toContain("Next Actions");
    expect(titles).not.toContain("Sections");
  });
});
