import { describe, expect, it } from "vitest";
import { heuristicEffort } from "../backlog-builder.js";

// The LLM effort estimate falls back to this keyword heuristic instead of a flat
// 3 when the cheap model returns garbage. Guards that the real gsd-migration
// backlog titles (which ALL scored a uniform 3 live, collapsing the sprint split
// into a mechanical items-per-sprint bucketing) now differentiate by size.
describe("heuristicEffort", () => {
  it("scores creation / migration work large (5)", () => {
    expect(heuristicEffort("Implement native council-workflow modules (types, registry, orchestrator, runtime)")).toBe(
      5,
    );
    expect(heuristicEffort("Rewire dispatch to use native modules")).toBe(5); // "native"
    expect(heuristicEffort("Migrate gsd core off the external dependency")).toBe(5);
  });

  it("scores deletion / inventory / config work small (1)", () => {
    expect(heuristicEffort("Inventory affected .cjs blobs and mapping")).toBe(1);
    expect(heuristicEffort("Remove @opengsd/gsd-core dependency")).toBe(1);
  });

  it("scores unclassified work medium (3)", () => {
    expect(heuristicEffort("Preserve parallel-debate behavior")).toBe(3);
    expect(heuristicEffort("Ensure existing test suite passes")).toBe(3);
  });

  it("no longer returns a uniform score across the real migration backlog", () => {
    const titles = [
      "Inventory affected .cjs blobs and mapping",
      "Implement native council-workflow modules",
      "Rewire dispatch to use native modules",
      "Preserve parallel-debate behavior",
      "Add frozen persona-model registry with test",
      "Ensure existing test suite passes",
      "Remove @opengsd/gsd-core dependency",
    ];
    const scores = titles.map(heuristicEffort);
    // The live run scored all of these 3 (flat). The heuristic must produce >1
    // distinct value so bin-packing reflects real size.
    expect(new Set(scores).size).toBeGreaterThan(1);
  });
});
