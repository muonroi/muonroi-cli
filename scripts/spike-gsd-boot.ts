#!/usr/bin/env bun
/**
 * Phase 0 spike: verify @opengsd/gsd-core loads in-process and gsd-tools progress works.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePlanningWorkspace } from "../src/gsd/config-bridge.js";
import { allLoopHostPoints, loadLoopHostContract } from "../src/gsd/gsd-runtime.js";
import { readProgress, readState } from "../src/gsd/workflow-engine.js";

const tmp = mkdtempSync(join(tmpdir(), "gsd-spike-"));
try {
  ensurePlanningWorkspace(tmp, "spike-model");
  const contract = loadLoopHostContract();
  const points = allLoopHostPoints();
  const state = readState(tmp);
  const progress = readProgress(tmp);

  console.log(
    JSON.stringify(
      {
        ok: true,
        contractSteps: contract.length,
        loopPoints: points.length,
        statePhase: state.phase,
        progressKeys: Object.keys(progress),
      },
      null,
      2,
    ),
  );
  if (points.length < 12) {
    console.error(`expected >=12 loop points, got ${points.length}`);
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
