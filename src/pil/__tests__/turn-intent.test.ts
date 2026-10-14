/**
 * Tests for pil/turn-intent.ts — the shared "does this turn want
 * implementation" signal, lifted out of council/index.ts (109aeef7) so the
 * post-debate recommendation and the settled-synthesis suppression gate
 * (src/orchestrator/settled-synthesis-gate.ts) can never disagree.
 */
import { describe, expect, it } from "vitest";
import { IMPLEMENTATION_TASK_TYPES, turnWantsImplementation } from "../turn-intent.js";

describe("turnWantsImplementation", () => {
  it("is true for coding intent + deliverableKind=code", () => {
    expect(turnWantsImplementation({ intentKind: "task", deliverableKind: "code", taskType: null })).toBe(true);
  });

  it("is true for coding intent + a code-producing taskType, even without deliverableKind=code", () => {
    for (const taskType of IMPLEMENTATION_TASK_TYPES) {
      expect(turnWantsImplementation({ intentKind: "task", deliverableKind: null, taskType })).toBe(true);
    }
  });

  it("is false when intentKind is not 'task', regardless of taskType", () => {
    expect(turnWantsImplementation({ intentKind: "chitchat", deliverableKind: "code", taskType: "generate" })).toBe(
      false,
    );
    expect(turnWantsImplementation({ intentKind: null, deliverableKind: "code", taskType: "generate" })).toBe(false);
  });

  it("is false for coding intent with a non-code-producing taskType and no code deliverable", () => {
    expect(turnWantsImplementation({ intentKind: "task", deliverableKind: "report", taskType: "documentation" })).toBe(
      false,
    );
    expect(turnWantsImplementation({ intentKind: "task", deliverableKind: null, taskType: "plan" })).toBe(false);
    expect(turnWantsImplementation({ intentKind: "task", deliverableKind: null, taskType: "analyze" })).toBe(false);
    expect(turnWantsImplementation({ intentKind: "task", deliverableKind: null, taskType: "general" })).toBe(false);
  });

  it("is false for null/undefined pilCtx (fail-closed — never suppresses a debate on missing signal)", () => {
    expect(turnWantsImplementation(null)).toBe(false);
    expect(turnWantsImplementation(undefined)).toBe(false);
    expect(turnWantsImplementation({})).toBe(false);
  });
});
