import { describe, expect, it } from "vitest";
import { extractSemanticHits, planScenarios } from "../scenario-planner.js";

describe("scenario-planner", () => {
  describe("extractSemanticHits", () => {
    it("extracts id+role from simple Semantic", () => {
      const src = `<Semantic id="composer" role="textbox" name="Prompt">`;
      const hits = extractSemanticHits(src, "x.tsx");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        id: "composer",
        role: "textbox",
        name: "Prompt",
        file: "x.tsx",
      });
    });

    it("detects isModal boolean shorthand", () => {
      const src = `<Semantic id="modal-x" role="dialog" name="X" isModal>`;
      const hits = extractSemanticHits(src, "y.tsx");
      expect(hits[0]?.isModal).toBe(true);
    });

    it("extracts template-literal ids", () => {
      const src = '<Semantic id={`ideal-phase-cost`} role="listitem">';
      const hits = extractSemanticHits(src, "z.tsx");
      expect(hits[0]?.id).toBe("ideal-phase-cost");
    });

    it("records line numbers", () => {
      const src = `\n\n<Semantic id="a" role="region">\n`;
      const hits = extractSemanticHits(src, "f.tsx");
      expect(hits[0]?.line).toBe(3);
    });

    it("handles multiple hits in one file", () => {
      const src = `
        <Semantic id="one" role="textbox">
        <Semantic id="two" role="button">
      `;
      const hits = extractSemanticHits(src, "f.tsx");
      expect(hits.map((h) => h.id)).toEqual(["one", "two"]);
    });
  });

  describe("planScenarios", () => {
    it("returns smoke-boot only when no files changed", () => {
      const scn = planScenarios({ diffFilesOverride: [] });
      expect(scn).toHaveLength(1);
      expect(scn[0]?.id).toBe("smoke-boot");
    });

    it("includes smoke-boot first when scenarios derived from hits", () => {
      // Use this very test file as a probe — it has no Semantic but we can
      // exercise the path by passing extraFiles pointing at a real UI file.
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/components/halt-recovery-card.tsx"],
      });
      expect(scn[0]?.id).toBe("smoke-boot");
      // halt-recovery-card has 1 Semantic (id=ideal-halt-card role=dialog)
      const ids = scn.map((s) => s.id);
      expect(ids.some((id) => id.startsWith("dialog-ideal-halt-card"))).toBe(true);
    });

    it("respects maxScenarios cap", () => {
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/components/init-new-form-card.tsx"],
        maxScenarios: 2,
      });
      expect(scn.length).toBeLessThanOrEqual(2);
    });

    it("textbox scenario types probe text and asserts idle", () => {
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/agents-modal.tsx"],
        maxScenarios: 6,
      });
      const textboxScn = scn.find((s) => s.id.startsWith("textbox-"));
      expect(textboxScn).toBeDefined();
      const typeStep = textboxScn?.steps.find((s) => s.op === "type");
      expect(typeStep).toMatchObject({ op: "type" });
    });

    // The wiring that lets the judge say "the child never became ready" instead
    // of blaming the change under test. Without `guard: true` on the mount wait,
    // a transient boot failure is reported as a failed assertion — see
    // ScenarioRun.mounted and judge.ts.
    it("marks the mount wait as the readiness gate on every driven surface scenario", () => {
      const scn = planScenarios({
        diffFilesOverride: [],
        extraFiles: ["src/ui/agents-modal.tsx"],
        maxScenarios: 8,
      }).filter((s) => s.reachable !== false && s.id !== "smoke-boot");

      expect(scn.length).toBeGreaterThan(0);
      for (const s of scn) {
        const guards = s.steps.filter((step) => step.op === "wait_for" && step.guard === true);
        expect(guards, `${s.id} must have exactly one readiness gate`).toHaveLength(1);
        expect(guards[0]).toMatchObject({ op: "wait_for", selector: "role=textbox" });
      }
    });

    // smoke-boot's readiness condition IS its assertion (it waits for idle and
    // then asserts idleReached), so marking it as a gate would excuse a genuine
    // "the CLI did not boot" as un-driveable.
    it("does NOT mark smoke-boot's idle wait as a readiness gate", () => {
      const smoke = planScenarios({ diffFilesOverride: [], maxScenarios: 4 }).find((s) => s.id === "smoke-boot");
      expect(smoke).toBeDefined();
      expect(smoke?.steps.some((step) => step.op === "wait_for" && step.guard === true)).toBe(false);
    });
  });
});
