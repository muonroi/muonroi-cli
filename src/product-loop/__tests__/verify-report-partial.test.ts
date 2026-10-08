/**
 * A partial verification must be RECORDED as partial.
 *
 * MEASURED DEFECT, run `muc2joffe506` sprint 2. The verify stage had genuinely
 * brought the Docker stack up, confirmed every service healthy and got a 200 from
 * `/api/health` — Phases 1-3 of the prompt's own phase list. Phase 4 (browser QA)
 * could not run: `agent-browser` is absent from this Windows host, measured on it:
 *
 *     $ which agent-browser
 *     which: no agent-browser in (/mingw64/bin:/usr/bin:...)
 *     $ agent-browser --version
 *     /usr/bin/bash: line 1: agent-browser: command not found
 *
 * `sprints/2-outcome.json` recorded `verify: "ERROR"` and `sprints/2-verify.md`
 * recorded nothing but the watchdog's timeout text, because the report body took
 * `error` OR `output`, never both:
 *
 *     const verifyReport =
 *       (verifyResult.error?.trim() ? verifyResult.error : (verifyResult.output ?? "")).trim()
 *
 * "Could not run" already has a name in this codebase — `gate-could-not-run` /
 * `GateCouldNotRunSignal` (verify-result.ts, commit 477ab0cf) — so the classifier
 * is reused rather than a second vocabulary invented.
 */

import { describe, expect, it } from "vitest";
import { buildVerifyReportBody } from "../verify-report.js";
import { detectGateCouldNotRun } from "../verify-result.js";

/** Verbatim from `sprints/2-verify.md` of run muc2joffe506 (head of the block). */
const REAL_TIMEOUT =
  "verify-timeout: verify stage reported nothing for 600s (sprint 2, run muc2joffe506) and was aborted after 600.0s " +
  "— this was a SILENCE budget, not a total; budget = the 600s floor; cause not diagnosed — only the observations " +
  "above were measured";

/** The report the stage HAD produced, in the prompt's own section shape. */
const REAL_PARTIAL = [
  "## Summary",
  "Ran the inferred recipe on the host.",
  "## Results",
  "Phase 1 setup OK. Phase 2 build + test OK. Phase 3 app started — Docker stack up, all services healthy, /api/health OK.",
  "Phase 4 browser QA: NOT RUN.",
  "## Blockers",
  "`agent-browser` is not installed on this Windows host:",
  "/usr/bin/bash: line 1: agent-browser: command not found",
].join("\n");

describe("buildVerifyReportBody", () => {
  it("keeps BOTH the abort reason and the partial report the stage produced", () => {
    const body = buildVerifyReportBody({ error: REAL_TIMEOUT, output: REAL_PARTIAL });

    // The abort reason survives — it is why there is no verdict.
    expect(body).toContain("this was a SILENCE budget, not a total");
    // And so does every phase the stage actually established.
    expect(body).toContain("Phase 2 build + test OK");
    expect(body).toContain("all services healthy");
    expect(body).toContain("/api/health OK");
    // Including the one that could not run, and why.
    expect(body).toContain("Phase 4 browser QA: NOT RUN");
    expect(body).toContain("agent-browser: command not found");
  });

  it("labels the partial as PARTIAL so it is never read as a verdict", () => {
    const body = buildVerifyReportBody({ error: REAL_TIMEOUT, output: REAL_PARTIAL });
    expect(body).toMatch(/PARTIAL verification/);
    expect(body).toMatch(/not as a verdict/i);
  });

  it("classifies the missing tool with the existing gate-could-not-run vocabulary", () => {
    const body = buildVerifyReportBody({ error: REAL_TIMEOUT, output: REAL_PARTIAL });
    expect(body).toContain("launcher_missing");
    expect(body).toContain("agent-browser: command not found");
  });

  it("is byte-identical to the old behaviour when there is only an error", () => {
    expect(buildVerifyReportBody({ error: REAL_TIMEOUT, output: "" })).toBe(REAL_TIMEOUT);
  });

  it("is byte-identical to the old behaviour when there is only output", () => {
    expect(buildVerifyReportBody({ error: "", output: REAL_PARTIAL })).toBe(REAL_PARTIAL);
    expect(buildVerifyReportBody({ error: null, output: REAL_PARTIAL })).toBe(REAL_PARTIAL);
  });

  it("says so when there is nothing at all", () => {
    expect(buildVerifyReportBody({ error: "", output: "" })).toBe("(no verify output)");
  });
});

describe("detectGateCouldNotRun — the measured absent-binary strings", () => {
  it("classifies a bare invocation of a missing tool", () => {
    // Measured on this host, verbatim.
    const signal = detectGateCouldNotRun("/usr/bin/bash: line 1: agent-browser: command not found");
    expect(signal?.kind).toBe("launcher_missing");
    expect(signal?.evidence).toContain("agent-browser: command not found");
  });

  it("classifies GNU which's answer without dragging the whole PATH into the evidence", () => {
    // Measured on this host, verbatim (PATH truncated here only for readability —
    // the real line is ~3KB, which is exactly why the evidence must not include it).
    const signal = detectGateCouldNotRun("which: no agent-browser in (/mingw64/bin:/usr/bin:/c/Users/phila/bin)");
    expect(signal?.kind).toBe("launcher_missing");
    expect(signal?.evidence).toBe("which: no agent-browser");
  });

  it("still refuses to steal a real test failure", () => {
    const ran = ["Tests  3 failed | 40 passed", "which: no agent-browser in (/usr/bin)"].join("\n");
    expect(detectGateCouldNotRun(ran)).toBeNull();
  });
});
