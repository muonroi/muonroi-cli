import { describe, expect, it } from "vitest";
import { buildCompactResumeMessage, detectProactiveCompactRequest } from "../proactive-compact-detector.js";

describe("proactive-compact-detector", () => {
  it("detects /compact with instructions on its own line", () => {
    const r = detectProactiveCompactRequest("some text\n/compact summarize tests and keep the plan\nmore");
    expect(r.detected).toBe(true);
    expect(r.instructions).toBe("summarize tests and keep the plan");
  });

  it("detects /compact with no instructions", () => {
    const r = detectProactiveCompactRequest("/compact   ");
    expect(r.detected).toBe(true);
    expect(r.instructions).toBe(null);
  });

  it("ignores bare mentions inside prose", () => {
    const r = detectProactiveCompactRequest("I think you should run /compact now to save tokens.");
    expect(r.detected).toBe(false);
  });

  it("ignores inside code blocks (still matches if at start of line)", () => {
    const r = detectProactiveCompactRequest("```bash\n/compact foo\n```");
    // Our regex is ^ start-of-line, so this will match the inner line. Acceptable for now (caller context decides).
    expect(r.detected).toBe(true);
    expect(r.instructions).toBe("foo");
  });

  it("builds resume message with focus", () => {
    const msg = buildCompactResumeMessage("keep the edit flow");
    expect(msg).toContain("Compact done. Resume previous task focusing on: keep the edit flow.");
    expect(msg).toContain("Continue the work until complete. Do not stop.");
  });

  it("builds resume message default when no instructions", () => {
    const msg = buildCompactResumeMessage(null);
    expect(msg).toContain("the original task");
  });
});
