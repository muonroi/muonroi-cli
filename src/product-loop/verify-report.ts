/**
 * src/product-loop/verify-report.ts
 *
 * The body of `sprints/<n>-verify.md`.
 *
 * MEASURED DEFECT, run `muc2joffe506` sprint 2. The body was built as
 *
 *     (verifyResult.error?.trim() ? verifyResult.error : (verifyResult.output ?? "")).trim()
 *
 * — an either/or. When the stage was cut by the silence watchdog the `error` won
 * and the work the stage had ALREADY done was dropped: the run had brought the
 * Docker stack up, confirmed every service healthy and got a 200 from
 * `/api/health` (Phases 1-3 of the verify prompt's own phase list), and the
 * artifact said `ERROR` and nothing else.
 *
 * A verification that got partway is a PARTIAL verification, and the honest
 * record of one names what it established, what it could not run, and why. It is
 * still not a verdict — the caller's `parseVerifyResult` keeps returning ERROR off
 * the non-empty `error`, so nothing here can launder a partial into a PASS.
 *
 * "Could not run" is NOT a new concept here: `detectGateCouldNotRun` /
 * `GateCouldNotRunSignal` (verify-result.ts, commit 477ab0cf) already distinguish
 * "the gate could not run" from "the gate ran and failed", with an evidence quote.
 * This reuses that classifier on the salvaged payload instead of inventing a
 * second vocabulary for the same fact.
 */

import { detectGateCouldNotRun } from "./verify-result.js";

/** Shown when neither channel produced anything — the pre-existing string. */
const NOTHING = "(no verify output)";

const PARTIAL_HEADER =
  "── PARTIAL verification recovered from the stage that was cut ──\n" +
  "Read what follows as what the stage DID establish and what it could not run — not as a verdict.";

/**
 * Compose the verify report body from the two channels a `ToolResult` carries.
 *
 * Single-channel results are returned byte-identical to the previous behaviour, so
 * every sprint that does not hit a cut keeps the artifact it had before.
 */
export function buildVerifyReportBody(args: { error?: string | null; output?: string | null }): string {
  const error = (args.error ?? "").trim();
  const output = (args.output ?? "").trim();

  if (!error && !output) return NOTHING;
  if (!error) return output;
  if (!output) return error;

  const parts = [error, "", PARTIAL_HEADER];
  const couldNotRun = detectGateCouldNotRun(output);
  if (couldNotRun) {
    // The classification and its evidence, on one line, so a reader (and the next
    // sprint's feedback) sees the fact without parsing prose.
    parts.push(`could-not-run: ${couldNotRun.kind} — ${couldNotRun.evidence}`);
  }
  parts.push("", output);
  return parts.join("\n");
}
