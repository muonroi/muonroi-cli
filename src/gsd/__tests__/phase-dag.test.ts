import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Phase } from "../../product-loop/types.js";
import { planningArtifact, planningRoot } from "../paths.js";
import { orderPhasesForExecution, topologicalPhaseOrder } from "../phase-dag.js";

const phases: Phase[] = [
  {
    id: "phase-2",
    name: "B",
    goal: "second",
    successCriteria: ["b"],
    scope: "b",
    exitCondition: { type: "criteria-threshold", min: 0.8 },
    dependsOn: ["phase-1"],
    maxSprints: 1,
  },
  {
    id: "phase-1",
    name: "A",
    goal: "first",
    successCriteria: ["a"],
    scope: "a",
    exitCondition: { type: "criteria-threshold", min: 0.8 },
    dependsOn: [],
    maxSprints: 1,
  },
];

describe("phase-dag", () => {
  let tmp: string;
  const prev = process.env.MUONROI_GSD_NATIVE;

  afterEach(() => {
    process.env.MUONROI_GSD_NATIVE = prev;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("topologicalPhaseOrder respects dependsOn", () => {
    const ordered = topologicalPhaseOrder(phases);
    expect(ordered.map((p) => p.id)).toEqual(["phase-1", "phase-2"]);
  });

  it("orderPhasesForExecution uses roadmap analyze when native + ROADMAP.md", () => {
    process.env.MUONROI_GSD_NATIVE = "1";
    tmp = mkdtempSync(join(tmpdir(), "phase-dag-"));
    mkdirSync(planningRoot(tmp), { recursive: true });
    writeFileSync(
      planningArtifact(tmp, "ROADMAP.md"),
      `# Roadmap: Test

## Phases

- [ ] **Phase 1: A**
- [ ] **Phase 2: B**

## Phase Details

### Phase 1: A
**Goal**: first
**Depends on**: Nothing (first phase)

### Phase 2: B
**Goal**: second
**Depends on**: Phase 1
`,
      "utf8",
    );
    const ordered = orderPhasesForExecution(tmp, phases);
    expect(ordered.map((p) => p.id)).toEqual(["phase-1", "phase-2"]);
  });
});
