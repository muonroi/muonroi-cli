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
  // DECISION (Defect 3, site 10/10): log, retry, and NEVER throw from here.
  //
  // Same `finally` hazard as the two above, with a sharper edge: the try block
  // decides this spike's EXIT CODE (`process.exit(1)` on too few loop points). A
  // throw from `finally` would replace both a clean exit and a deliberate failure
  // with an unrelated ENOTEMPTY stack trace, so the one thing the spike reports
  // would be wrong. Non-fatal but logged: `tmp` is a scratch dir, and a dev spike
  // leaking one is worth a line, not a failure.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (err) {
    console.error(
      `[spike-gsd-boot] temp dir cleanup failed (${tmp}); a scratch tree is left behind: ${
        (err as Error)?.message ?? String(err)
      }`,
    );
  }
}
