import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../planner.js";

/**
 * Regression coverage for session e74e820c6417: the leader's synthesis was cut
 * off at the provider's 4096-token completion ceiling, the old greedy
 * `/\{[\s\S]*\}/` match failed, and the prose fallback persisted
 * `summary: "\"type\": \"evaluation\","` with every section empty as the
 * council's recorded decision.
 */
describe("extractJsonObject", () => {
  it("extracts a bare JSON object", () => {
    const r = extractJsonObject('{"type":"evaluation","summary":"ok"}');
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.json!)).toEqual({ type: "evaluation", summary: "ok" });
  });

  it("extracts JSON out of a ```json fence", () => {
    const raw = '```json\n{"type":"decision","summary":"fenced"}\n```\n\nSome trailing markdown.';
    const r = extractJsonObject(raw);
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.json!).summary).toBe("fenced");
  });

  it("stops at the matching brace instead of running to the last } in the prose", () => {
    // The old greedy regex swallowed the markdown braces below and produced
    // invalid JSON even though a perfectly good object was present.
    const raw = '{"type":"decision","summary":"a"}\n\n## Notes\nUse `{ foo: 1 }` in the config.';
    const r = extractJsonObject(raw);
    expect(JSON.parse(r.json!)).toEqual({ type: "decision", summary: "a" });
  });

  it("ignores braces inside strings and escapes", () => {
    const raw = '{"summary":"a } brace and an escaped \\" quote","type":"decision"}';
    const r = extractJsonObject(raw);
    expect(JSON.parse(r.json!).type).toBe("decision");
  });

  it("flags a completion cut off mid-object as truncated", () => {
    const raw = `\u0060\u0060\u0060json\n{\n  "type": "evaluation",\n  "summary": "Muonroi-cli sở hữu kiến trúc`;
    const r = extractJsonObject(raw);
    expect(r.json).toBeNull();
    expect(r.truncated).toBe(true);
  });

  it("reports no-json (not truncated) when the model emitted prose only", () => {
    const r = extractJsonObject("The council recommends shipping the feature.");
    expect(r.json).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it("prefers the half before ---READABLE---", () => {
    const raw = '{"type":"decision","summary":"json half"}\n---READABLE---\n# Report\n{ not json }';
    const r = extractJsonObject(raw);
    expect(JSON.parse(r.json!).summary).toBe("json half");
  });
});
