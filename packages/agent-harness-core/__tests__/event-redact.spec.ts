/**
 * event-redact.spec.ts — Unit tests for Phase 4.3 / Phase 6.6.
 *
 * Verifies the per-kind payload allowlist redaction:
 * - API key patterns in answerText → "[redacted]"
 * - toast.text longer than 500 chars → truncated
 * - council-step with no forbidden fields → passes through unchanged
 * - Unknown kind → only t + kind survive
 * - Fields not in the allowlist for a given kind are stripped
 */

import { describe, expect, it } from "vitest";
import { redactEvent } from "../src/event-redact.js";
import type { LiveEvent } from "../src/protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(e: LiveEvent): Record<string, unknown> {
  return e as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// answerText redaction
// ---------------------------------------------------------------------------

describe("redactEvent — askcard-answered (API key redaction)", () => {
  it('replaces sk-... key in answerText with "[redacted]"', () => {
    const e: Extract<LiveEvent, { kind: "askcard-answered" }> = {
      t: "event",
      kind: "askcard-answered",
      questionId: "q-1",
      answerKind: "freetext",
      answerText: "my key is sk-1234567890abcdefghij",
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "askcard-answered" }>;
    expect(out.answerText).toBe("my key is [redacted]");
  });

  it("keeps safe answerText unchanged", () => {
    const e: Extract<LiveEvent, { kind: "askcard-answered" }> = {
      t: "event",
      kind: "askcard-answered",
      questionId: "q-2",
      answerKind: "choice",
      answerText: "React",
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "askcard-answered" }>;
    expect(out.answerText).toBe("React");
  });

  it("redacts 32+ char base64 string", () => {
    // Construct a 32-char alphanumeric string at runtime to avoid triggering
    // static secret scanners while still exercising the regex path.
    // "A-Z" × 26 + "a-f" × 6 = 32 chars (no padding), matches base64 pattern.
    const secret = `${"ABCDEFGHIJKLMNOPQRSTUVWXYZ".substring(0, 26)}${"abcdef".substring(0, 6)}`;
    const e: Extract<LiveEvent, { kind: "askcard-answered" }> = {
      t: "event",
      kind: "askcard-answered",
      questionId: "q-3",
      answerKind: "freetext",
      answerText: `token=${secret}`,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "askcard-answered" }>;
    expect(out.answerText).toBe("token=[redacted]");
  });
});

// ---------------------------------------------------------------------------
// toast.text length cap
// ---------------------------------------------------------------------------

describe("redactEvent — toast (text cap at 500 chars)", () => {
  it("truncates toast.text longer than 500 chars", () => {
    // Use a string with spaces to avoid base64 pattern match replacing it with "[redacted]".
    const segment = "error detail "; // 13 chars, contains spaces
    const longText = segment.repeat(50); // 650 chars
    const e: Extract<LiveEvent, { kind: "toast" }> = {
      t: "event",
      kind: "toast",
      level: "error",
      text: longText,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "toast" }>;
    expect(out.text.length).toBe(500);
  });

  it("keeps toast.text <= 500 chars unchanged", () => {
    const e: Extract<LiveEvent, { kind: "toast" }> = {
      t: "event",
      kind: "toast",
      level: "info",
      text: "short message",
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "toast" }>;
    expect(out.text).toBe("short message");
  });

  it("strips API key in toast.text", () => {
    const e: Extract<LiveEvent, { kind: "toast" }> = {
      t: "event",
      kind: "toast",
      level: "warn",
      text: "Auth failed for sk-abcdefghijklmnopqrstuv",
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "toast" }>;
    expect(out.text).toBe("Auth failed for [redacted]");
  });
});

// ---------------------------------------------------------------------------
// council-step — no forbidden fields
// ---------------------------------------------------------------------------

describe("redactEvent — council-step (safe fields pass through)", () => {
  it("passes all council-step fields unchanged when no sensitive data", () => {
    const e: Extract<LiveEvent, { kind: "council-step" }> = {
      t: "event",
      kind: "council-step",
      phaseId: "ph-1",
      phaseKind: "debate",
      state: "active",
      label: "Round 1 debate",
      elapsedMs: 1500,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "council-step" }>;
    expect(out.phaseId).toBe("ph-1");
    expect(out.phaseKind).toBe("debate");
    expect(out.state).toBe("active");
    expect(out.label).toBe("Round 1 debate");
    expect(out.elapsedMs).toBe(1500);
  });
});

describe("redactEvent — council-turn-length (safe fields pass through)", () => {
  it("passes all council-turn-length fields unchanged", () => {
    const e: Extract<LiveEvent, { kind: "council-turn-length" }> = {
      t: "event",
      kind: "council-turn-length",
      role: "architect",
      round: 2,
      charCount: 1234,
      wordCount: 210,
      model: "grok-4.3",
      correlationId: "sess-abc",
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "council-turn-length" }>;
    expect(out.role).toBe("architect");
    expect(out.round).toBe(2);
    expect(out.charCount).toBe(1234);
    expect(out.wordCount).toBe(210);
    expect(out.model).toBe("grok-4.3");
    expect(out.correlationId).toBe("sess-abc");
  });

  it("strips an unlisted field (closed allowlist — telemetry text can't leak)", () => {
    const e = {
      t: "event",
      kind: "council-turn-length",
      role: "qa",
      round: 0,
      charCount: 10,
      wordCount: 2,
      model: "m",
      correlationId: "c",
      rawText: "should not leak",
    } as unknown as Extract<LiveEvent, { kind: "council-turn-length" }>;
    const out = asRecord(redactEvent(e));
    expect(out.rawText).toBeUndefined();
    expect(out.charCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Unknown kind — fail-safe strips all fields except t + kind
// ---------------------------------------------------------------------------

describe("redactEvent — unknown kind (fail-safe)", () => {
  it("strips all fields except t and kind for unknown kinds", () => {
    const e = {
      t: "event" as const,
      kind: "future-event" as "toast", // cast to satisfy type, but unknown at runtime
      sensitiveField: "secret-value",
      publicField: "ok",
    } as Extract<LiveEvent, { kind: "toast" }>;
    const out = redactEvent(e);
    const raw = asRecord(out);
    expect(raw.t).toBe("event");
    expect(raw.kind).toBe("future-event");
    expect(raw.sensitiveField).toBeUndefined();
    expect(raw.publicField).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// llm-token — delta cap at 500 chars
// ---------------------------------------------------------------------------

describe("redactEvent — llm-token (delta cap)", () => {
  it("caps delta to 500 chars", () => {
    // Use a non-alphanumeric-only string to avoid triggering the API key regex.
    // The cap applies before the regex scan; a 600-char mix of spaces and chars is safe.
    const chunk = "hello world "; // 12 chars
    const longDelta = chunk.repeat(50); // 600 chars, but contains spaces (not base64-matchable)
    const e: Extract<LiveEvent, { kind: "llm-token" }> = {
      t: "event",
      kind: "llm-token",
      correlationId: "call-1",
      delta: longDelta,
      tokenIndex: 0,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "llm-token" }>;
    expect(out.delta.length).toBe(500);
  });

  it("keeps correlationId and tokenIndex unchanged", () => {
    const e: Extract<LiveEvent, { kind: "llm-token" }> = {
      t: "event",
      kind: "llm-token",
      correlationId: "call-abc",
      delta: "hello",
      tokenIndex: 42,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "llm-token" }>;
    expect(out.correlationId).toBe("call-abc");
    expect(out.tokenIndex).toBe(42);
    expect(out.delta).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// askcard-open — question cap + API key scan
// ---------------------------------------------------------------------------

describe("redactEvent — askcard-open (question cap + scrub)", () => {
  it("caps question to 300 chars", () => {
    // Use a non-alphanumeric-only string to avoid triggering the API key regex.
    const longQuestion = "What is your choice? ".repeat(20); // 420 chars, contains spaces
    const e: Extract<LiveEvent, { kind: "askcard-open" }> = {
      t: "event",
      kind: "askcard-open",
      questionId: "q-long",
      question: longQuestion,
      phase: "clarify",
      optionCount: 3,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "askcard-open" }>;
    expect(out.question.length).toBe(300);
  });

  it("strips API key from question text", () => {
    const e: Extract<LiveEvent, { kind: "askcard-open" }> = {
      t: "event",
      kind: "askcard-open",
      questionId: "q-key",
      question: "Use key sk-1234567890abcdefghij for auth",
      phase: "preflight",
      optionCount: 2,
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "askcard-open" }>;
    expect(out.question).toBe("Use key [redacted] for auth");
  });
});

// ---------------------------------------------------------------------------
// route-decision — numeric forceCouncil (boolean passes through)
// ---------------------------------------------------------------------------

describe("redactEvent — route-decision", () => {
  it("keeps all allowlisted fields", () => {
    const e: Extract<LiveEvent, { kind: "route-decision" }> = {
      t: "event",
      kind: "route-decision",
      path: "council",
      complexity: "high",
      forceCouncil: true,
      runId: "run-001",
    };
    const out = redactEvent(e) as Extract<LiveEvent, { kind: "route-decision" }>;
    expect(out.path).toBe("council");
    expect(out.complexity).toBe("high");
    expect(out.forceCouncil).toBe(true);
    expect(out.runId).toBe("run-001");
  });

  it("strips extra fields not in allowlist", () => {
    const e = {
      t: "event" as const,
      kind: "route-decision" as const,
      path: "hot-path" as const,
      complexity: "low",
      forceCouncil: false,
      runId: "r",
      systemPrompt: "you are a hacker", // should be stripped
      apiKey: "sk-secret", // should be stripped
    };
    const out = redactEvent(e as Extract<LiveEvent, { kind: "route-decision" }>) as Record<string, unknown>;
    expect(out.systemPrompt).toBeUndefined();
    expect(out.apiKey).toBeUndefined();
    expect(out.path).toBe("hot-path");
  });
});

// ---------------------------------------------------------------------------
// steer-inject — count/atStep/runId survive; unknown fields stripped
// ---------------------------------------------------------------------------

describe("redactEvent — steer-inject", () => {
  it("keeps steer-inject count/atStep/runId and strips unknown fields", () => {
    const out = redactEvent({
      t: "event",
      kind: "steer-inject",
      count: 2,
      atStep: 3,
      runId: "run-xyz",
      // biome-ignore lint/suspicious/noExplicitAny: testing extra-field stripping
      extra: "dropme" as any,
    } as never);
    expect(out).toEqual({ t: "event", kind: "steer-inject", count: 2, atStep: 3, runId: "run-xyz" });
  });
});

// ---------------------------------------------------------------------------
// idle pseudo-event passthrough
// ---------------------------------------------------------------------------

describe("redactEvent — idle pseudo-event", () => {
  it("passes idle events through unchanged", () => {
    const e: LiveEvent = { t: "idle" };
    const out = redactEvent(e);
    expect(out).toEqual({ t: "idle" });
  });
});
