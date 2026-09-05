/**
 * event-redact-coverage.spec.ts
 *
 * Regression cover for the six LiveEvent kinds that had NO `ALLOWED_FIELDS`
 * entry and therefore reached the wire as `{t, kind}` with every field stripped
 * by the fail-safe in `redactEvent`:
 *
 *   sprint-plan-committed, ee-timeout, ee-error, disconnect,
 *   stream-retry, grounding-flag
 *
 * That is the "the system reported success for something that did not happen"
 * failure class: the event announces its own kind and carries nothing, so a
 * driving agent reads "it happened" while the payload proving WHAT happened was
 * discarded. `sprint-plan-committed` in particular was relied on during Phase 0
 * verification while its contents were being dropped.
 *
 * Two things are asserted per kind:
 *   1. the declared fields SURVIVE (the bug),
 *   2. a hostile payload is CAPPED and key-SCRUBBED (the reason they cannot
 *      simply be `"pass"`).
 *
 * Field lists here are derived from the LiveEvent union in `protocol.ts` and the
 * emit sites cited in `event-redact.ts` — not invented.
 */

import { describe, expect, it } from "vitest";
import { redactEvent } from "../src/event-redact.js";
import { LIVE_EVENT_KINDS, type LiveEvent } from "../src/protocol.js";

function asRecord(e: LiveEvent): Record<string, unknown> {
  return e as unknown as Record<string, unknown>;
}

// Obviously-fake, non-functional credential shapes — never a real secret.
const FAKE_KEY = `sk-${"F".repeat(48)}`;
const FAKE_BEARER = "A".repeat(40);
const PROVIDER_URL = "https://api.example-provider.com/v1/chat/completions?trace=1";
/**
 * The shape this repo has actually seen escape once: an `AI_APICallError` whose
 * `message` embeds the serialized upstream request/response body (~160KB).
 */
const HOSTILE = `AI_APICallError: 400 at ${PROVIDER_URL} key=${FAKE_KEY} bearer=${FAKE_BEARER} body=${"X".repeat(200_000)}`;

/** No allowlisted field may carry a key-shaped token through to the wire. */
function expectNoCredential(out: LiveEvent): void {
  const wire = JSON.stringify(out);
  expect(wire).not.toContain(FAKE_KEY);
  expect(wire).not.toContain(FAKE_BEARER);
}

// ---------------------------------------------------------------------------
// The regression sentinel: the six kinds that used to arrive content-free.
//
// A generic loop over LIVE_EVENT_KINDS cannot express this — an allowlisted kind
// probed with a field that is NOT on its allowlist also yields exactly
// `{t, kind}`, so such a loop reports every kind as bare and proves nothing. The
// check has to use each kind's real declared payload, below. The compile-time
// guard against a future kind #24 repeating this is the non-partial
// `Record<EventKind, …>` annotation on ALLOWED_FIELDS, enforced by `tsc`.
// ---------------------------------------------------------------------------

const REGRESSION_SAMPLES: LiveEvent[] = [
  {
    t: "event",
    kind: "sprint-plan-committed",
    runId: "r1",
    projectDir: null,
    sprintCount: 1,
    sprintIds: ["sprint-1"],
    source: "auto",
    ts: 1,
  },
  { t: "event", kind: "ee-timeout", source: "s", elapsedMs: 1, budgetMs: 2, ts: 3 },
  { t: "event", kind: "ee-error", source: "s", name: "E", message: "m", ts: 4 },
  { t: "event", kind: "disconnect", reason: "end", ts: 5 },
  { t: "event", kind: "stream-retry", attempt: 1, maxAttempts: 3, errorName: "E", errorMessage: "m", nextDelayMs: 1 },
  { t: "event", kind: "grounding-flag", claims: ["c"], count: 1, ts: 6 },
];

describe("redactEvent — the six previously-unlisted kinds", () => {
  it("is a set of real LiveEvent kinds (guards against a typo'd sample)", () => {
    for (const s of REGRESSION_SAMPLES) {
      expect(LIVE_EVENT_KINDS).toContain((s as { kind: string }).kind);
    }
  });

  it.each(REGRESSION_SAMPLES.map((s) => [(s as { kind: string }).kind, s] as const))(
    "%s does not arrive as a content-free {t, kind}",
    (_kind, sample) => {
      const out = asRecord(redactEvent(sample));
      expect(Object.keys(out).length).toBeGreaterThan(2);
    },
  );
});

// ---------------------------------------------------------------------------
// sprint-plan-committed — protocol.ts:306-319
// emits: src/product-loop/index.ts:465-474, :1051-1060
// ---------------------------------------------------------------------------

describe("redactEvent — sprint-plan-committed", () => {
  const base: Extract<LiveEvent, { kind: "sprint-plan-committed" }> = {
    t: "event",
    kind: "sprint-plan-committed",
    runId: "run-7f2a",
    projectDir: "D:/tmp/proj",
    sprintCount: 3,
    sprintIds: ["sprint-1", "sprint-2", "sprint-3"],
    source: "council",
    ts: 1730000000000,
  };

  it("preserves every declared field", () => {
    const out = asRecord(redactEvent(base));
    expect(out.runId).toBe("run-7f2a");
    expect(out.projectDir).toBe("D:/tmp/proj");
    expect(out.sprintCount).toBe(3);
    expect(out.sprintIds).toEqual(["sprint-1", "sprint-2", "sprint-3"]);
    expect(out.source).toBe("council");
    expect(out.ts).toBe(1730000000000);
  });

  it("keeps projectDir=null (the not-a-scaffolded-project case)", () => {
    const out = asRecord(redactEvent({ ...base, projectDir: null }));
    expect(out.projectDir).toBeNull();
  });

  it("caps + scrubs a hostile projectDir and bounds the sprintIds array", () => {
    const out = redactEvent({
      ...base,
      projectDir: `/home/u/${"deep/".repeat(200)}?k=${FAKE_KEY}`,
      sprintIds: Array.from({ length: 500 }, (_, i) => `sprint-${i}-${FAKE_KEY}`),
    });
    const rec = asRecord(out);
    expect((rec.projectDir as string).length).toBeLessThanOrEqual(300);
    expect((rec.sprintIds as string[]).length).toBe(50);
    expectNoCredential(out);
  });
});

// ---------------------------------------------------------------------------
// ee-timeout / ee-error — protocol.ts:346-353 / :354-361
// emits: src/utils/ee-logger.ts:142-149 / :151-158
// ---------------------------------------------------------------------------

describe("redactEvent — ee-timeout", () => {
  it("preserves source + budget fields", () => {
    const out = asRecord(
      redactEvent({
        t: "event",
        kind: "ee-timeout",
        source: "bridge.classifyViaBrain",
        elapsedMs: 2500,
        budgetMs: 2000,
        ts: 7,
      }),
    );
    expect(out.source).toBe("bridge.classifyViaBrain");
    expect(out.elapsedMs).toBe(2500);
    expect(out.budgetMs).toBe(2000);
    expect(out.ts).toBe(7);
  });

  it("caps + scrubs a hostile source", () => {
    const out = redactEvent({ t: "event", kind: "ee-timeout", source: HOSTILE, ts: 7 });
    expect((asRecord(out).source as string).length).toBeLessThanOrEqual(120);
    expectNoCredential(out);
  });
});

describe("redactEvent — ee-error", () => {
  it("preserves source / name / message / ts", () => {
    const out = asRecord(
      redactEvent({
        t: "event",
        kind: "ee-error",
        source: "pil.pipeline.logInteraction",
        name: "TypeError",
        message: "fetch failed",
        ts: 8,
      }),
    );
    expect(out.source).toBe("pil.pipeline.logInteraction");
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("fetch failed");
    expect(out.ts).toBe(8);
  });

  it("caps a 200KB error message and scrubs keys out of it", () => {
    const out = redactEvent({
      t: "event",
      kind: "ee-error",
      source: HOSTILE,
      name: HOSTILE,
      message: HOSTILE,
      ts: 8,
    });
    const rec = asRecord(out);
    expect((rec.source as string).length).toBeLessThanOrEqual(120);
    expect((rec.name as string).length).toBeLessThanOrEqual(120);
    expect((rec.message as string).length).toBeLessThanOrEqual(500);
    // The whole event must be orders of magnitude smaller than the input.
    expect(JSON.stringify(out).length).toBeLessThan(1_000);
    expectNoCredential(out);
  });
});

// ---------------------------------------------------------------------------
// disconnect — protocol.ts:365-371, emit: tests/harness/helpers.ts:136-146
// ---------------------------------------------------------------------------

describe("redactEvent — disconnect", () => {
  it.each(["end", "close"] as const)("preserves reason=%s and ts", (reason) => {
    const out = asRecord(redactEvent({ t: "event", kind: "disconnect", reason, ts: 9 }));
    expect(out.reason).toBe(reason);
    expect(out.ts).toBe(9);
  });

  it("caps a reason that is not one of the two declared literals", () => {
    const out = redactEvent({
      t: "event",
      kind: "disconnect",
      reason: HOSTILE as unknown as "end",
      ts: 9,
    });
    expect((asRecord(out).reason as string).length).toBeLessThanOrEqual(64);
    expectNoCredential(out);
  });
});

// ---------------------------------------------------------------------------
// stream-retry — protocol.ts:375-384
// emits: orchestrator.ts:1634-1638 (RetryInfo, retry-stream.ts:3-9),
//        tool-engine.ts:984, :3246, :3318, :3485, :4475,
//        batch-turn-runner.ts:385-393  — all the same five fields
// ---------------------------------------------------------------------------

describe("redactEvent — stream-retry", () => {
  it("preserves all five RetryInfo fields", () => {
    const out = asRecord(
      redactEvent({
        t: "event",
        kind: "stream-retry",
        attempt: 2,
        maxAttempts: 3,
        errorName: "AI_APICallError",
        errorMessage: "429 too many requests",
        nextDelayMs: 1000,
      }),
    );
    expect(out.attempt).toBe(2);
    expect(out.maxAttempts).toBe(3);
    expect(out.errorName).toBe("AI_APICallError");
    expect(out.errorMessage).toBe("429 too many requests");
    expect(out.nextDelayMs).toBe(1000);
  });

  it("caps a 200KB errorMessage — the AI_APICallError body-dump shape", () => {
    const out = redactEvent({
      t: "event",
      kind: "stream-retry",
      attempt: 1,
      maxAttempts: 3,
      errorName: HOSTILE,
      errorMessage: HOSTILE,
      nextDelayMs: 500,
    });
    const rec = asRecord(out);
    expect((rec.errorName as string).length).toBeLessThanOrEqual(120);
    expect((rec.errorMessage as string).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(out).length).toBeLessThan(1_000);
    expectNoCredential(out);
  });
});

// ---------------------------------------------------------------------------
// grounding-flag — protocol.ts:389-397, emit: tool-engine.ts:4006-4012
// ---------------------------------------------------------------------------

describe("redactEvent — grounding-flag", () => {
  it("preserves the claim texts and the count", () => {
    const out = asRecord(
      redactEvent({
        t: "event",
        kind: "grounding-flag",
        claims: ["67 tests", "app.tsx:836"],
        count: 2,
        ts: 10,
      }),
    );
    expect(out.claims).toEqual(["67 tests", "app.tsx:836"]);
    expect(out.count).toBe(2);
    expect(out.ts).toBe(10);
  });

  it("bounds a hostile claims array per-element AND by element count", () => {
    const out = redactEvent({
      t: "event",
      kind: "grounding-flag",
      claims: Array.from({ length: 500 }, () => HOSTILE),
      count: 500,
      ts: 10,
    });
    const claims = asRecord(out).claims as string[];
    expect(claims.length).toBe(50);
    for (const c of claims) expect(c.length).toBeLessThanOrEqual(200);
    // 100MB of input must not become a 100MB line on the wire.
    expect(JSON.stringify(out).length).toBeLessThan(20_000);
    expectNoCredential(out);
  });
});
