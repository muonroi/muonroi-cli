/**
 * detached-slash-interrupt.test.ts — regression for P0-4.
 *
 * `interruptActiveRun` (src/ui/use-app-logic.tsx) bails on
 * `if (!isProcessingRef.current) return false;` before it ever reaches
 * `agent.abort()`. Slash commands that own a long-running turn are dispatched
 * through a DETACHED `dispatchSlash(...).then(...)` promise, so the submit
 * handler returns — and its `.finally()` resets `isProcessing` — before the
 * branch body runs. A branch that does not RE-ARM the ref is therefore
 * uncancellable: Escape is swallowed with no abort and no feedback.
 *
 * `/council` hit this and fixed it in place. `/ideal` (`__PRODUCT_LOOP__`) had
 * the identical shape and never re-armed, so Escape during a live — or wedged —
 * `/ideal` turn did nothing (measured 2026-09-03: no toast, no `sprint-halt`).
 *
 * A full E2E is impractical: reproducing it needs a live multi-minute
 * `/ideal` run against a real provider, and `use-app-logic.tsx` is a single
 * ~9k-line React hook with no seam to drive the branch in isolation. This is a
 * build-time structural guard instead — the same technique
 * `src/pil/__tests__/renderer-coverage.test.ts` already uses for a UI invariant
 * that no unit test can reach. It pins the ordering that makes Escape work:
 * re-arm BEFORE the generator, release in the `finally`.
 *
 * NOTE: use-app-logic.tsx is `@ts-nocheck`, so the compiler watches none of
 * this. This test is the only thing that does.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve("src/ui/use-app-logic.tsx"), "utf8");

/** Slice from `startNeedle` up to the next `endNeedle` after it. */
function branchBody(startNeedle: string, endNeedle: string): string {
  const start = SRC.indexOf(startNeedle);
  expect(start, `could not locate ${startNeedle}`).toBeGreaterThan(-1);
  const end = SRC.indexOf(endNeedle, start + startNeedle.length);
  expect(end, `could not locate ${endNeedle} after ${startNeedle}`).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("Escape must reach abort() for detached slash runs (P0-4)", () => {
  it("interruptActiveRun still bails on !isProcessingRef — the reason re-arming matters", () => {
    // If this guard is ever removed the branch assertions below stop being
    // load-bearing; fail loudly rather than silently passing forever.
    expect(SRC).toContain("if (!isProcessingRef.current) return false;");
    const guard = SRC.indexOf("if (!isProcessingRef.current) return false;");
    const abort = SRC.indexOf("activeAgent.abort();", guard);
    expect(abort, "abort() should follow the isProcessingRef guard").toBeGreaterThan(guard);
  });

  const branches: Array<{ label: string; start: string; end: string; run: string }> = [
    {
      label: "/ideal (__PRODUCT_LOOP__)",
      start: 'result.startsWith("__PRODUCT_LOOP__")',
      end: 'result.startsWith("__COUNCIL__")',
      run: "runProductLoopV1",
    },
    {
      label: "/council (__COUNCIL__)",
      start: 'result.startsWith("__COUNCIL__")',
      end: ".catch((err: unknown) => {",
      run: "runCouncilV2",
    },
  ];

  for (const b of branches) {
    describe(b.label, () => {
      const body = branchBody(b.start, b.end);

      it("re-arms isProcessingRef BEFORE starting the run", () => {
        const arm = body.indexOf("isProcessingRef.current = true;");
        const run = body.indexOf(b.run);
        expect(arm, `${b.label} never re-arms isProcessingRef — Escape cannot reach abort()`).toBeGreaterThan(-1);
        expect(run, `${b.label} should call ${b.run}`).toBeGreaterThan(-1);
        expect(arm, `${b.label} must re-arm isProcessingRef before ${b.run}`).toBeLessThan(run);
      });

      it("also mirrors the ref into isProcessing state (drives the 'esc to interrupt' affordance)", () => {
        const arm = body.indexOf("isProcessingRef.current = true;");
        const setState = body.indexOf("setIsProcessing(true);", arm);
        expect(setState).toBeGreaterThan(arm);
      });

      it("releases the flag in its finally so the composer returns to idle", () => {
        const fin = body.lastIndexOf("} finally {");
        expect(fin, `${b.label} should tear down in a finally`).toBeGreaterThan(-1);
        const release = body.indexOf("isProcessingRef.current = false;", fin);
        expect(release, `${b.label} must release isProcessingRef in its finally`).toBeGreaterThan(fin);
        expect(body.indexOf("setIsProcessing(false);", release)).toBeGreaterThan(release);
      });
    });
  }
});
