/**
 * src/reporter/__tests__/query-router.test.ts
 *
 * Tests for deterministic query classification — no LLM, no I/O.
 */

import { describe, expect, it } from "vitest";
import { classifyQuery } from "../query-router.js";

describe("classifyQuery", () => {
  // ── Progress ──────────────────────────────────────────────────────────────

  it("classifies 'progress?' as progress", () => {
    expect(classifyQuery("progress?").kind).toBe("progress");
  });

  it("classifies 'status' as progress", () => {
    expect(classifyQuery("status").kind).toBe("progress");
  });

  it("classifies '/status' as progress", () => {
    expect(classifyQuery("/status").kind).toBe("progress");
  });

  it("classifies 'how is it going' as progress", () => {
    expect(classifyQuery("how is it going").kind).toBe("progress");
  });

  it('classifies "how\'s it going" as progress', () => {
    expect(classifyQuery("how's it going").kind).toBe("progress");
  });

  it("classifies Vietnamese 'tiến độ' as progress", () => {
    expect(classifyQuery("tiến độ").kind).toBe("progress");
  });

  it("classifies Vietnamese 'báo cáo' as progress", () => {
    expect(classifyQuery("báo cáo").kind).toBe("progress");
  });

  it("classifies 'progress' (no question mark) as progress", () => {
    expect(classifyQuery("progress").kind).toBe("progress");
  });

  // ── Sprint ────────────────────────────────────────────────────────────────

  it("classifies 'show sprint 2' as sprint with sprintNumber=2", () => {
    const result = classifyQuery("show sprint 2");
    expect(result.kind).toBe("sprint");
    expect(result.sprintNumber).toBe(2);
  });

  it("classifies 'sprint 5' as sprint with sprintNumber=5", () => {
    const result = classifyQuery("sprint 5");
    expect(result.kind).toBe("sprint");
    expect(result.sprintNumber).toBe(5);
  });

  it("classifies 'Sprint 1' (uppercase) as sprint", () => {
    const result = classifyQuery("Sprint 1");
    expect(result.kind).toBe("sprint");
    expect(result.sprintNumber).toBe(1);
  });

  // ── Item ──────────────────────────────────────────────────────────────────

  it("classifies 'tell me about item login' as item", () => {
    const result = classifyQuery("tell me about item login");
    expect(result.kind).toBe("item");
    expect(result.itemQuery).toBe("login");
  });

  it("classifies 'explain feature checkout' as item", () => {
    const result = classifyQuery("explain feature checkout");
    expect(result.kind).toBe("item");
    expect(result.itemQuery).toBe("checkout");
  });

  it("classifies 'show task authentication' as item", () => {
    const result = classifyQuery("show task authentication");
    expect(result.kind).toBe("item");
    expect(result.itemQuery).toBe("authentication");
  });

  // ── Freeform ──────────────────────────────────────────────────────────────

  it("classifies 'is this multi-tenant?' as freeform", () => {
    expect(classifyQuery("is this multi-tenant?").kind).toBe("freeform");
  });

  it("classifies empty string as freeform", () => {
    expect(classifyQuery("").kind).toBe("freeform");
  });

  it("classifies whitespace-only as freeform", () => {
    expect(classifyQuery("   ").kind).toBe("freeform");
  });

  it("classifies a Vietnamese free-form question as freeform", () => {
    expect(classifyQuery("tại sao sprint 1 chậm vậy?").kind).toBe("freeform");
  });

  it("classifies a long English question as freeform", () => {
    expect(classifyQuery("explain the architecture decision made in sprint 1").kind).toBe("freeform");
  });

  // ── rawText preservation ──────────────────────────────────────────────────

  it("preserves rawText for all kinds", () => {
    const inputs = ["progress?", "sprint 3", "show item login", "random question"];
    for (const input of inputs) {
      expect(classifyQuery(input).rawText).toBe(input.trim());
    }
  });
});
