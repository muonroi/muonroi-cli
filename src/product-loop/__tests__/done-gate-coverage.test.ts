import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateDoneGate } from "../done-gate.js";
import type { DoneGateContext, RoleSlot } from "../types.js";
import type { ToolResult } from "../../types/index.js";
import { VERIFY_PASS_MARKER } from "../verify-result.js";

function buildBaseCtx(overrides: Partial<DoneGateContext> = {}): DoneGateContext {
  const roleAssignments = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
  roleAssignments.set("PO", { modelId: "gpt-4", provider: "openai", tier: "pro" });
  roleAssignments.set("Customer", { modelId: "claude-3", provider: "anthropic", tier: "pro" });
  return {
    recipe: { testCommands: ["npm test"], coverage: 0.8, ecosystem: "node" } as any,
    lastVerify: { success: true, output: VERIFY_PASS_MARKER } as ToolResult,
    criteria: [{ id: "f", status: "met", evidence: "src/x.ts:1" }],
    history: [],
    roleAssignments,
    llm: { generate: vi.fn().mockResolvedValue("SHIP") } as any,
    respondToPreflight: vi.fn().mockResolvedValue(true),
    doneThreshold: 0.9,
    ...overrides,
  };
}

describe("evaluateDoneGate — coverage gaps", () => {
  beforeEach(() => {
    delete process.env.MUONROI_DEV;
  });

  it("fails Cond #1 with reason=no_test_commands when recipe has empty testCommands", () => {
    return evaluateDoneGate(
      buildBaseCtx({ recipe: { testCommands: [], coverage: 0.5, ecosystem: "node" } as any }),
    ).then((v) => {
      expect(v.pass).toBe(false);
      expect(v.failedCondition).toBe("engineering_floor");
      expect(v.reason).toBe("no_test_commands");
    });
  });

  it("fails Cond #1 when lastVerify is undefined (no verify run yet)", async () => {
    const v = await evaluateDoneGate(buildBaseCtx({ lastVerify: undefined as any }));
    expect(v.pass).toBe(false);
    expect(v.failedCondition).toBe("engineering_floor");
    expect(v.reason).toBe("verify_FAIL");
  });

  it("clamps doneThreshold below 0.7 up to 0.7", async () => {
    // Build criteria producing exactly 0.7 — would fail with threshold=0.9 but pass when clamped
    const ctx = buildBaseCtx({
      doneThreshold: 0.1, // clamped → 0.7
      criteria: [
        { id: "a", status: "met", evidence: "f.ts:1" },
        { id: "b", status: "met", evidence: "f.ts:2" },
        { id: "c", status: "met", evidence: "f.ts:3" },
        { id: "d", status: "met", evidence: "f.ts:4" },
        { id: "e", status: "met", evidence: "f.ts:5" },
        { id: "f", status: "met", evidence: "f.ts:6" },
        { id: "g", status: "met", evidence: "f.ts:7" },
        { id: "h", status: "unmet" },
        { id: "i", status: "unmet" },
        { id: "j", status: "unmet" },
      ],
      // Tier-different so debate runs (but score 0.7 < 0.85 → R5 skip)
    });
    const v = await evaluateDoneGate(ctx);
    expect(v.score).toBeCloseTo(0.7, 5);
    expect(v.pass).toBe(true); // 0.7 == clamped threshold → not below → passes Cond #3
  });

  it("clamps doneThreshold above 1.0 down to 1.0", async () => {
    const ctx = buildBaseCtx({
      doneThreshold: 5,
      criteria: [{ id: "a", status: "partial", evidence: "f.ts:1" }], // score=0.5
    });
    const v = await evaluateDoneGate(ctx);
    expect(v.pass).toBe(false);
    expect(v.failedCondition).toBe("weighted_score");
  });

  it("returns score=0 when criteria array is empty (still fails Cond #3)", async () => {
    const v = await evaluateDoneGate(buildBaseCtx({ criteria: [], doneThreshold: 0.7 }));
    expect(v.score).toBe(0);
    expect(v.failedCondition).toBe("weighted_score");
  });

  it("Cond #2: criterion with status=unmet does not need evidence", async () => {
    const ctx = buildBaseCtx({
      doneThreshold: 0.7,
      criteria: [
        { id: "a", status: "met", evidence: "f.ts:1" },
        { id: "b", status: "met", evidence: "f.ts:2" },
        { id: "c", status: "met", evidence: "f.ts:3" },
        { id: "d", status: "unmet" }, // no evidence → fine
      ],
    });
    const v = await evaluateDoneGate(ctx);
    expect(v.pass).toBe(true);
    expect(v.score).toBe(0.75);
  });

  it("Cond #4: PO missing returns missing_roles", async () => {
    // Force debate by ensuring score >= 0.85
    const ctx = buildBaseCtx({
      criteria: [
        { id: "a", status: "met", evidence: "f.ts:1" },
        { id: "b", status: "met", evidence: "f.ts:2" },
      ],
    });
    ctx.roleAssignments.delete("PO");
    const v = await evaluateDoneGate(ctx);
    expect(v.pass).toBe(false);
    expect(v.failedCondition).toBe("customer_debate");
    expect(v.reason).toBe("missing_roles");
  });

  it("Cond #4: cross-provider runs single round (1 PO + 1 Customer + 1 final = 3 LLM calls)", async () => {
    const llm = { generate: vi.fn().mockResolvedValue("SHIP") } as any;
    const ctx = buildBaseCtx({ llm });
    const v = await evaluateDoneGate(ctx);
    expect(v.pass).toBe(true);
    expect(llm.generate).toHaveBeenCalledTimes(3);
  });

  it("Cond #4: same-provider different-tier runs 3 rounds (3*2 + 1 = 7 calls)", async () => {
    const llm = { generate: vi.fn().mockResolvedValue("SHIP") } as any;
    const ctx = buildBaseCtx({ llm });
    ctx.roleAssignments.set("PO", { modelId: "gpt-4", provider: "openai", tier: "pro" });
    ctx.roleAssignments.set("Customer", { modelId: "gpt-4o", provider: "openai", tier: "balanced" });
    const v = await evaluateDoneGate(ctx);
    expect(v.pass).toBe(true);
    expect(llm.generate).toHaveBeenCalledTimes(7);
  });

  it("Cond #4: same-provider same-tier different-model runs 5 rounds (5*2 + 1 = 11 calls)", async () => {
    const llm = { generate: vi.fn().mockResolvedValue("SHIP") } as any;
    const ctx = buildBaseCtx({ llm });
    ctx.roleAssignments.set("PO", { modelId: "gpt-4", provider: "openai", tier: "pro" });
    ctx.roleAssignments.set("Customer", { modelId: "gpt-4-32k", provider: "openai", tier: "pro" });
    const v = await evaluateDoneGate(ctx);
    expect(v.pass).toBe(true);
    expect(llm.generate).toHaveBeenCalledTimes(11);
  });

  it("Cond #4: WAIT decision without explicit reason returns customer_dissent", async () => {
    const llm = {
      generate: vi
        .fn()
        .mockResolvedValueOnce("po")
        .mockResolvedValueOnce("cust")
        .mockResolvedValueOnce("WAIT:"), // empty reason
    } as any;
    const v = await evaluateDoneGate(buildBaseCtx({ llm }));
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("customer_dissent");
  });
});
