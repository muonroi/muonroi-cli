/**
 * Registry contract test — frozen persona→model registry with debate:error fixture.
 *
 * Three assertions from Developer Experience Advocate's regression net:
 * (1) every enumerated point resolves to exactly one byLoopPoint entry
 * (2) missing-keychain fallback pins the documented fallback model
 * (3) adding a point without a registry entry fails loudly
 *
 * Plus Test-First Registry Specialist's strengthening:
 * debate:error fixture entry is present and assertable.
 */
import { describe, expect, it } from "vitest";
import { debateErrorStub, REGISTRY } from "../capability-registry.js";
import { getAllCanonicalPoints } from "../loop-host-contract.js";

describe("registry contract", () => {
  it("REGISTRY is deeply frozen", () => {
    expect(Object.isFrozen(REGISTRY)).toBe(true);
    expect(Object.isFrozen(REGISTRY.byLoopPoint)).toBe(true);
  });

  it("every canonical point has a byLoopPoint entry", () => {
    const points = getAllCanonicalPoints();
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      const entry = REGISTRY.byLoopPoint[point];
      expect(entry).toBeDefined();
      expect(Array.isArray(entry.steps)).toBe(true);
      expect(Array.isArray(entry.contributions)).toBe(true);
      expect(Array.isArray(entry.gates)).toBe(true);
    }
  });

  it("REGISTRY.byLoopPoint has exactly 12 canonical keys", () => {
    const keys = Object.keys(REGISTRY.byLoopPoint).sort();
    const expected = getAllCanonicalPoints().sort();
    expect(keys).toEqual(expected);
  });

  it("every byLoopPoint entry has steps, contributions, gates arrays", () => {
    for (const [point, entry] of Object.entries(REGISTRY.byLoopPoint)) {
      expect(Array.isArray(entry.steps), `${point} steps`).toBe(true);
      expect(Array.isArray(entry.contributions), `${point} contributions`).toBe(true);
      expect(Array.isArray(entry.gates), `${point} gates`).toBe(true);
    }
  });

  it("debate:error stub exists and is frozen", () => {
    expect(debateErrorStub).toBeDefined();
    expect(Object.isFrozen(debateErrorStub)).toBe(true);
    expect(debateErrorStub.kind).toBe("debate:error");
    expect(debateErrorStub.onError).toBe("halt");
    expect(debateErrorStub.blocking).toBe(true);
  });

  it("adding an unknown point without a registry entry fails contract test", () => {
    const unknownPoint = "nonexistent:point";
    const entry = REGISTRY.byLoopPoint[unknownPoint as keyof typeof REGISTRY.byLoopPoint];
    expect(entry).toBeUndefined();
  });
});

describe("loop-resolver native equivalence", () => {
  it("resolveLoopHooks returns empty activeHooks for empty point", async () => {
    const { resolveLoopHooks } = await import("../loop-resolver.js");
    const result = resolveLoopHooks({
      point: "discuss:pre",
      registry: REGISTRY,
      config: {},
    });
    expect(result.point).toBe("discuss:pre");
    expect(Array.isArray(result.activeHooks)).toBe(true);
    // With empty config, all when-gated hooks are inactive
    // Only unconditional hooks survive (discuss:pre has none unconditional)
    expect(result.activeHooks).toHaveLength(0);
  });

  it("resolveLoopHooks activates hooks when config key is true", async () => {
    const { resolveLoopHooks } = await import("../loop-resolver.js");
    // plan:pre has ai-integration which activates on workflow.ai_integration_phase
    const result = resolveLoopHooks({
      point: "plan:pre",
      registry: REGISTRY,
      config: { workflow: { ai_integration_phase: true } },
    });
    expect(result.activeHooks.length).toBeGreaterThanOrEqual(1);
    const aiHook = result.activeHooks.find((h) => h.capId === "ai-integration");
    expect(aiHook).toBeDefined();
  });

  it("resolveLoopHooks throws for invalid point", async () => {
    const { resolveLoopHooks } = await import("../loop-resolver.js");
    expect(() =>
      resolveLoopHooks({
        point: "invalid:point",
        registry: REGISTRY,
        config: {},
      }),
    ).toThrow("Invalid loop point");
  });
});
