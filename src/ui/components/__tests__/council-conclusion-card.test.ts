/**
 * parseConclusion turns a leader-synthesis JSON body into a structured
 * conclusion (summary / strengths / weaknesses / recommendation / coverage) so
 * the UI can render a scannable card instead of dumping raw JSON as freetext.
 * It must return null for prose / non-JSON so the plain-text path takes over.
 */
import { describe, expect, it } from "vitest";
import { parseConclusion } from "../council-conclusion-card.js";

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

  it("returns null for JSON with no recognizable section", () => {
    expect(parseConclusion(JSON.stringify({ type: "evaluation", foo: "bar" }))).toBeNull();
  });
});
