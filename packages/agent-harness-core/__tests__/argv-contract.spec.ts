/**
 * The tui.start argv contract: published == enforced, and the boundary did not
 * move.
 *
 * A graduation-test agent whose entire budget is `tools/list` +
 * `tui.capabilities` failed at the first step because the argv allowlist was
 * enforced but never published: `tui.start` said "sanitized argv" and stopped
 * there. These tests pin the two properties that keep that from returning:
 *
 *  1. DRIFT — every form/example the payload advertises is one the allowlist
 *     actually accepts, and every token it calls rejected is one the allowlist
 *     actually rejects. Prose and behaviour cannot diverge silently.
 *  2. NO WIDENING — the assembled regex source is byte-identical to the literal
 *     it replaced, so "publish the rule" can never become "relax the rule".
 */
import { describe, expect, it } from "vitest";
import {
  ARGV_ALLOW_RE,
  ARGV_CONTRACT,
  ARGV_FORMS,
  ARGV_MAX_ARG_LENGTH,
  ARGV_MAX_ARGS,
  ARGV_REJECTED,
} from "../src/argv-contract.js";
import { buildCapabilitiesPayload, validateStartArgs } from "../src/mcp-server.js";

/**
 * The allowlist exactly as it read at d65a12b3, before it was assembled from
 * the published forms. Any change here is a change to the security boundary and
 * must be argued as one — never as a side effect of editing documentation.
 */
const FROZEN_ALLOW_SOURCE =
  "^(--agent-[a-z-]+(=.*)?|--mock-llm(=.+)?|--profile=[a-zA-Z0-9_-]+|--session=[a-zA-Z0-9_-]+)$";

describe("tui.start argv contract — no widening", () => {
  it("assembles byte-identically to the frozen allowlist literal", () => {
    expect(ARGV_ALLOW_RE.source).toBe(FROZEN_ALLOW_SOURCE);
  });

  it("is assembled FROM the published forms, not restated beside them", () => {
    const assembled = `^(${ARGV_CONTRACT.forms.map((f) => f.pattern).join("|")})$`;
    expect(ARGV_ALLOW_RE.source).toBe(assembled);
  });
});

describe("tui.start argv contract — published matches enforced", () => {
  it.each(
    ARGV_FORMS.flatMap((f) => f.examples.map((ex) => [f.form, ex] as const)),
  )("accepts the advertised example for %s: %s", (_form, example) => {
    expect(validateStartArgs([example])).toEqual({ ok: true });
  });

  it.each(ARGV_REJECTED.map((r) => [r.arg, r.why] as const))("rejects the advertised non-example %s", (arg) => {
    expect(validateStartArgs([arg]).ok).toBe(false);
  });

  it.each(
    ARGV_CONTRACT.callExamples.map((c, i) => [i, c] as const),
  )("accepts published callExamples[%i] verbatim", (_i, call) => {
    expect(validateStartArgs([...call.args])).toEqual({ ok: true });
  });

  it("publishes the same bounds the input schema enforces", () => {
    expect(ARGV_CONTRACT.maxArgs).toBe(ARGV_MAX_ARGS);
    expect(ARGV_CONTRACT.maxArgLength).toBe(ARGV_MAX_ARG_LENGTH);
  });

  it("advertises an empty args array as valid, and it is", () => {
    expect(ARGV_CONTRACT.emptyAllowed).toBe(true);
    expect(validateStartArgs([])).toEqual({ ok: true });
  });
});

describe("tui.capabilities publishes the argv contract", () => {
  it("carries `argv` in the payload, not only in the tool description", () => {
    const payload = buildCapabilitiesPayload({ tools: ["tui.start"] });
    expect(payload.argv).toBe(ARGV_CONTRACT);
    expect(payload.argv.forms.length).toBeGreaterThan(0);
  });

  it("is sufficient: a valid args array is constructible from the payload alone", () => {
    // Simulate an agent that has ONLY the handshake: take the first example of
    // every published form, build one args array, and submit it.
    const { argv } = buildCapabilitiesPayload({ tools: ["tui.start"] });
    const constructed = argv.forms
      .map((f) => f.examples[0])
      .filter((x): x is string => typeof x === "string")
      // --mock-llm bare and --mock-llm=<dir> are alternatives; the bare form is
      // what `examples[0]` gives, and it is accepted.
      .slice(0, argv.maxArgs);
    expect(validateStartArgs(constructed)).toEqual({ ok: true });
  });
});

describe("argv_rejected is instructive", () => {
  // The exact payload the graduation agent built from its budget: the
  // --mock-llm spelling used on a command line, where the directory is its own
  // argv element.
  const GRADUATION_ARGS = ["--agent-mode", "--mock-llm", "tests/harness/fixtures/llm"];

  it("names the offending element by index, not just by value", () => {
    const r = validateStartArgs(GRADUATION_ARGS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.bad).toBe("tests/harness/fixtures/llm");
    expect(r.index).toBe(2);
  });

  it("tells the agent the two ways to repair the call", () => {
    const r = validateStartArgs(GRADUATION_ARGS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("--mock-llm=tests/harness/fixtures/llm");
    expect(r.message).toContain("mockLlmDir");
  });

  it("explains a bare value token that follows no flag", () => {
    const r = validateStartArgs(["some/path"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("flags only");
  });

  it("explains an allowlisted flag written in the wrong shape", () => {
    const r = validateStartArgs(["--profile"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("--profile");
    expect(r.message).toContain("=");
  });

  it("still refuses loader flags, with a message and no widening", () => {
    for (const arg of ["--require", "--preload=evil", "--eval", "-e"]) {
      const r = validateStartArgs([arg]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});
