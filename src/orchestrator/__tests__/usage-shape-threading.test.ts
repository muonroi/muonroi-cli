/**
 * src/orchestrator/__tests__/usage-shape-threading.test.ts
 *
 * Forensics-accuracy regression: the providerOptions SHAPE recorded on each
 * usage_events row must reflect the call that produced THAT event.
 *
 * The old design stashed the shape in mutable `Agent._lastProviderOptionsShape`
 * and cleared it after the first `source==="message"` event. Two failures fell
 * out of that:
 *   1. Multi-step turns emit one usage event PER step (onStepFinish), but the
 *      clear nulled the shape after step 1 → steps 2+ recorded an EMPTY shape
 *      even though the same streamText config (with promptCacheKey) drove them.
 *   2. A `task` sub-agent running mid-turn overwrote the shared field, so the
 *      message turn's later steps recorded the TASK's shape (interleaving race).
 *
 * The fix threads the shape EXPLICITLY into recordUsage per call, so neither the
 * clear nor an interleaved task can corrupt it. These tests drive the private
 * recordUsage directly with a faked session and a spied recordUsageEvent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recordUsageEventSpy = vi.fn();

vi.mock("../../storage/index", () => ({
  appendCompaction: vi.fn(),
  appendMessages: vi.fn(() => []),
  appendSystemMessage: vi.fn(() => 0),
  buildChatEntries: vi.fn(() => []),
  getNextMessageSequence: vi.fn(() => 0),
  getSessionTotalTokens: vi.fn(() => 0),
  loadTranscript: vi.fn(() => []),
  loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
  recordUsageEvent: (...args: unknown[]) => recordUsageEventSpy(...args),
  SessionStore: class {
    getWorkspace() {
      return null;
    }
    openSession() {
      return null;
    }
    createSession() {
      return null;
    }
    setModel() {}
    getRequiredSession() {
      return null;
    }
    setMode() {}
    touchSession() {}
  },
}));

import { loadCatalog } from "../../models/registry.js";
import { Agent } from "../orchestrator.js";

// recordUsageEvent(sessionId, source, model, usage, lastSeq, pilActive,
//                  enrichmentDelta, providerOptionsShape) — shape is the LAST arg.
const SHAPE_ARG = 7;

function makeAgentWithSession(): { recordUsage: (...a: unknown[]) => void; setLastShape: (s: string | null) => void } {
  const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });
  // Fake a live session so recordUsage's `if (this.session)` branch runs.
  (agent as unknown as { session: { id: string } }).session = { id: "sess-threading-test" };
  return {
    recordUsage: (...a: unknown[]) =>
      (agent as unknown as { recordUsage: (...x: unknown[]) => void }).recordUsage(...a),
    setLastShape: (s) => {
      (agent as unknown as { _lastProviderOptionsShape: string | null })._lastProviderOptionsShape = s;
    },
  };
}

const USAGE = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

beforeAll(async () => {
  await loadCatalog();
});

describe("recordUsage threads an explicit providerOptions shape", () => {
  beforeEach(() => recordUsageEventSpy.mockClear());
  afterEach(() => recordUsageEventSpy.mockClear());

  it("records the explicit shape on EVERY message event of a multi-step turn (clear bug)", () => {
    const a = makeAgentWithSession();
    const shape = JSON.stringify({ openai: { promptCacheKey: "string", store: "boolean" } });
    // Two steps of the same turn — both must carry the shape (step 2 used to be
    // null because the first event cleared the shared field).
    a.recordUsage(USAGE, "message", "gpt-5.4-mini", shape);
    a.recordUsage(USAGE, "message", "gpt-5.4-mini", shape);

    expect(recordUsageEventSpy).toHaveBeenCalledTimes(2);
    expect(recordUsageEventSpy.mock.calls[0]?.[SHAPE_ARG]).toBe(shape);
    expect(recordUsageEventSpy.mock.calls[1]?.[SHAPE_ARG]).toBe(shape);
  });

  it("records the message shape even when a task call set the shared field (interleaving race)", () => {
    const a = makeAgentWithSession();
    // Simulate a task sub-agent having stamped the shared field mid-turn.
    a.setLastShape(JSON.stringify({ openai: { instructions: "string" } }));
    const msgShape = JSON.stringify({ openai: { promptCacheKey: "string" } });
    a.recordUsage(USAGE, "message", "gpt-5.4-mini", msgShape);

    expect(recordUsageEventSpy.mock.calls[0]?.[SHAPE_ARG]).toBe(msgShape);
  });

  it("falls back to null (not stale) when no explicit shape is given for a title/other call", () => {
    const a = makeAgentWithSession();
    a.recordUsage(USAGE, "title", "gpt-5.4-mini");
    expect(recordUsageEventSpy.mock.calls[0]?.[SHAPE_ARG]).toBeNull();
  });
});
