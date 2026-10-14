/**
 * Tests for council/prior-synthesis.ts.
 *
 * Session 115a59c9bb9e -> child 49f6b8c1d8d6 (2026-09-23): a parent session's
 * council debate concluded with an "Agreed Integration Architecture". The
 * forked child ran a FRESH debate that reproduced nearly the same conclusion
 * before doing any implementation work.
 *
 * This module's job is narrow now: parse a `[Council Memory]` record and
 * score its topic similarity for observability. The single consumer
 * (`findSettledSynthesisInSessionChain` in orchestrator/settled-synthesis-gate.ts)
 * has its own integration tests against a real DB session chain — see
 * orchestrator/__tests__/settled-synthesis-gate.test.ts. These tests cover
 * the pure parsing/scoring primitives directly and fast, without DB setup.
 *
 * `PARENT_TOPIC`/`CURRENT_TOPIC` are the REAL strings from the incident, not
 * hand-written similar topics — a test built from similar-sounding topics
 * would hide exactly the gap that let an earlier (topic-gated) version of
 * this fix pass its own tests while still being inert on the real defect.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { COUNCIL_MEMORY_MARKER, evaluateCouncilMemoryCandidate, parseCouncilMemoryRecord } from "../prior-synthesis.js";

const PARENT_TOPIC =
  "ok bây giờ bạn đi vào mode council để bàn luận về đề xuất của bạn để có cái nhìn đa chiều hơn nhé " +
  "sau đó tổng hợp lại cho tôi đề xuất đã chỉnh sửa sau…";
const CURRENT_TOPIC = "ok tiến hành implement theo plan kết hợp sub agent";
const SYNTHESIS =
  "Agreed Integration Architecture: AutomationFrameworkConfig maps to TestRunMapping via a subprocess-wrapper " +
  "approach.";

describe("parseCouncilMemoryRecord", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a valid record", () => {
    const content = `${COUNCIL_MEMORY_MARKER}${JSON.stringify({ topic: PARENT_TOPIC, synthesis: SYNTHESIS })}`;

    const candidate = parseCouncilMemoryRecord(content);

    expect(candidate).toEqual({ topic: PARENT_TOPIC, synthesis: SYNTHESIS });
  });

  it("returns null for a string that does not carry the marker", () => {
    const content = JSON.stringify({ topic: PARENT_TOPIC, synthesis: SYNTHESIS });

    expect(parseCouncilMemoryRecord(content)).toBeNull();
  });

  it("logs and returns null on malformed JSON instead of throwing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const candidate = parseCouncilMemoryRecord(`${COUNCIL_MEMORY_MARKER}{not valid json`);

    expect(candidate).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toContain("[council/prior-synthesis]");
  });

  it("returns null for an empty synthesis (debate started but never concluded)", () => {
    const content = `${COUNCIL_MEMORY_MARKER}${JSON.stringify({ topic: PARENT_TOPIC, synthesis: "" })}`;

    expect(parseCouncilMemoryRecord(content)).toBeNull();
  });

  it("returns null for an empty topic", () => {
    const content = `${COUNCIL_MEMORY_MARKER}${JSON.stringify({ topic: "", synthesis: SYNTHESIS })}`;

    expect(parseCouncilMemoryRecord(content)).toBeNull();
  });
});

describe("evaluateCouncilMemoryCandidate", () => {
  it("always reports found:true for a valid candidate — similarity is observability-only, never a veto", () => {
    const evidence = evaluateCouncilMemoryCandidate({ topic: PARENT_TOPIC, synthesis: SYNTHESIS }, CURRENT_TOPIC);

    expect(evidence.found).toBe(true);
    expect(evidence.recordTopic).toBe(PARENT_TOPIC);
    expect(evidence.synthesisExcerpt).toContain("AutomationFrameworkConfig");
  });

  it("computes the measured 0.032-magnitude similarity on the real incident pair", () => {
    const evidence = evaluateCouncilMemoryCandidate({ topic: PARENT_TOPIC, synthesis: SYNTHESIS }, CURRENT_TOPIC);

    expect(evidence.similarity).toBeLessThan(0.1);
  });

  it("computes high similarity when the topics genuinely are the same text", () => {
    const evidence = evaluateCouncilMemoryCandidate({ topic: CURRENT_TOPIC, synthesis: SYNTHESIS }, CURRENT_TOPIC);

    expect(evidence.similarity).toBeGreaterThan(0.9);
  });

  it("truncates a long synthesis to 2000 chars", () => {
    const longSynthesis = "x".repeat(3000);

    const evidence = evaluateCouncilMemoryCandidate({ topic: PARENT_TOPIC, synthesis: longSynthesis }, CURRENT_TOPIC);

    expect(evidence.synthesisExcerpt?.length).toBe(2000);
  });
});
