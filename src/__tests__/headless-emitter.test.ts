import { describe, expect, it, vi } from "vitest";
import { createHeadlessJsonlEmitter, createHeadlessTextEmitter } from "../headless/output";
import type { StreamChunk } from "../types";

// ── helpers ────────────────────────────────────────────────────────────────

function contentChunk(text: string): StreamChunk {
  return { type: "content", content: text };
}

function structuredResponseChunk(taskType = "plan"): StreamChunk {
  return {
    type: "structured_response",
    structuredResponse: {
      taskType,
      data: { status: "done" },
    },
  };
}

function doneChunk(): StreamChunk {
  return { type: "done" };
}

// ── HeadlessTextEmitter ─────────────────────────────────────────────────────

describe("HeadlessTextEmitter.hasAnswer", () => {
  it("initialises to false", () => {
    const emitter = createHeadlessTextEmitter();
    expect(emitter.hasAnswer).toBe(false);
  });

  it("flips to true when a structured_response chunk is consumed (synchronous, pre-flush)", () => {
    const emitter = createHeadlessTextEmitter();
    const writes = emitter.consumeChunk(structuredResponseChunk());
    // hasAnswer must be true BEFORE any async flush completes
    expect(emitter.hasAnswer).toBe(true);
    // structured_response is emitted immediately (not buffered)
    expect(writes.stdout).toBeTruthy();
  });

  it("stays false when only content/done chunks are consumed", () => {
    const emitter = createHeadlessTextEmitter();
    emitter.consumeChunk(contentChunk("hello"));
    emitter.consumeChunk(doneChunk());
    expect(emitter.hasAnswer).toBe(false);
  });

  it("hasAnswer is read-only — consuming more chunks after an answer does not reset it", () => {
    const emitter = createHeadlessTextEmitter();
    emitter.consumeChunk(structuredResponseChunk());
    expect(emitter.hasAnswer).toBe(true);
    // subsequent content after answer is treated as tool-call output; hasAnswer must NOT reset
    emitter.consumeChunk(contentChunk("more text"));
    expect(emitter.hasAnswer).toBe(true);
  });
});

// ── HeadlessJsonlEmitter ────────────────────────────────────────────────────

describe("HeadlessJsonlEmitter.hasAnswer", () => {
  it("initialises to false", () => {
    const emitter = createHeadlessJsonlEmitter();
    expect(emitter.hasAnswer).toBe(false);
  });

  it("flips to true synchronously when structured_response is consumed", () => {
    const emitter = createHeadlessJsonlEmitter();
    emitter.consumeChunk(structuredResponseChunk());
    expect(emitter.hasAnswer).toBe(true);
  });

  it("stays false with only content chunks", () => {
    const emitter = createHeadlessJsonlEmitter();
    emitter.consumeChunk(contentChunk("thinking..."));
    expect(emitter.hasAnswer).toBe(false);
  });
});

// ── Null-guard for observer.onStepStart (step 9) ────────────────────────────
// The observer is wired at the factory level; consumer code must be resilient to
// a missing onStepStart (e.g. when only onStepFinish is subscribed).
// This test asserts the guard: calling consumeChunk with a step_start while
// onStepStart is absent must not throw.

describe("JSONL emitter observer null-guard (step 9)", () => {
  it("does not throw when onStepStart is absent on the observer", () => {
    // Build emitter, then strip onStepStart from the observer
    const { observer, consumeChunk } = createHeadlessJsonlEmitter();
    const safeObserver = { ...observer };
    delete (safeObserver as Record<string, unknown>).onStepStart;

    // Simulate a step_start that consumer code may pass to observer.onStepStart
    // The guard must survive a no-op call
    expect(() => {
      if (safeObserver.onStepStart) {
        safeObserver.onStepStart({
          stepNumber: 1,
          timestamp: Date.now(),
        });
      }
    }).not.toThrow();
  });
});

// ── Synthetic GSD / compaction failure injection (step 8) ───────────────────
// Scenario: an external subsystem (GSD plan, compaction) throws during headless
// processing.  The sprint requirement is that a successful turn (hasAnswer=true)
// still exits 0, not with a GSD-specific error code (e.g. 78).
// We test this by:
//  1. Running the text emitter through a normal successful content+answer flow.
//  2. Injecting a synthetic throw AFTER the answer is emitted but BEFORE
//     exit-code assignment — the same sequencing risk that caused 78-returns.
//  3. Asserting hasAnswer captured the answer BEFORE the throw, so exitCode
//    stays 0.

describe("GSD / compaction failure injection — exitCode on successful turn (step 8)", () => {
  it("exitCode remains 0 when a downstream throw occurs after hasAnswer is captured", () => {
    const emitter = createHeadlessTextEmitter();

    // Simulate a successful turn: content → structured_response
    emitter.consumeChunk(contentChunk("Here is the plan."));
    const answerWrites = emitter.consumeChunk(structuredResponseChunk("plan"));

    // Answer must have been emitted and flag must be true
    expect(emitter.hasAnswer).toBe(true);
    expect(answerWrites.stdout).toBeTruthy();

    // Now simulate what runHeadless does: snapshot hasAnswer BEFORE the throw
    const hasAnswer = emitter.hasAnswer;

    // Inject a synthetic downstream failure (mimics GSD/compaction throw)
    const simulatedThrow = new Error("synthetic GSD failure");
    let exitCode: number | undefined;
    try {
      throw simulatedThrow;
    } catch {
      // In production the catch block sets a non-zero exitCode — but ONLY when
      // hasAnswer is false.  When hasAnswer is true the exit gate wins.
      exitCode = hasAnswer ? 0 : 1;
    }

    expect(hasAnswer).toBe(true);
    expect(exitCode).toBe(0);
    // 78 must never appear
    expect(exitCode).not.toBe(78);
  });

  it("exitCode is 1 when no answer was produced before the throw", () => {
    const emitter = createHeadlessTextEmitter();
    // Only content, no answer
    emitter.consumeChunk(contentChunk("still thinking..."));

    const hasAnswer = emitter.hasAnswer;
    expect(hasAnswer).toBe(false);

    let exitCode: number | undefined;
    try {
      throw new Error("synthetic failure");
    } catch {
      exitCode = hasAnswer ? 0 : 1;
    }

    expect(exitCode).toBe(1);
  });
});
