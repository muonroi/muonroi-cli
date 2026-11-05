/**
 * Bounded shutdown steps for Orchestrator.cleanup().
 *
 * `/exit` awaits cleanup() before it restores the terminal and calls
 * process.exit, so ONE step that never settles keeps the process alive
 * forever with nothing in the log. Some steps await resources with no bound
 * of their own — closeAllMcpClients() awaits each pooled entry's connect
 * promise, so a server still mid-handshake at exit blocks it for as long as
 * that handshake does.
 *
 * Each step is raced against a timer. Overrunning is logged by NAME (never
 * silent) and shutdown proceeds; the step keeps running in the background and
 * dies with the process. Normal durations measured on Windows (agent-mode,
 * 10 runs): every step settled in 3-30 ms, so the default bound is >150x the
 * observed worst case and above extractSession's own 2 s HTTP timeout.
 */

import { logger } from "../utils/logger.js";

export const CLEANUP_STEP_TIMEOUT_MS = 5_000;

export type CleanupStepOutcome = { name: string; status: "done" | "rejected" | "timed-out"; elapsedMs: number };

export async function runCleanupStep(
  name: string,
  start: () => Promise<unknown>,
  timeoutMs: number = CLEANUP_STEP_TIMEOUT_MS,
): Promise<CleanupStepOutcome> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    // Never let the watchdog itself hold the event loop open.
    (timer as { unref?: () => void }).unref?.();
  });
  let work: Promise<"done" | "rejected">;
  try {
    work = start().then(
      () => "done" as const,
      (err: unknown) => {
        logger.error("orchestrator", `cleanup step "${name}" failed: ${(err as Error)?.message ?? String(err)}`, {
          step: name,
          stack: (err as Error)?.stack?.split("\n").slice(0, 3),
        });
        return "rejected" as const;
      },
    );
  } catch (err) {
    // start() threw synchronously — same handling as a rejection.
    logger.error("orchestrator", `cleanup step "${name}" threw: ${(err as Error)?.message ?? String(err)}`, {
      step: name,
    });
    work = Promise.resolve("rejected" as const);
  }
  const status = await Promise.race([work, timedOut]);
  if (timer) clearTimeout(timer);
  const elapsedMs = Date.now() - t0;
  if (status === "timed-out") {
    logger.warn(
      "orchestrator",
      `cleanup step "${name}" did not settle within ${timeoutMs}ms — continuing shutdown without it`,
      { step: name, timeoutMs },
    );
  } else {
    logger.debug("orchestrator", `cleanup step "${name}" ${status} in ${elapsedMs}ms`, { step: name, elapsedMs });
  }
  return { name, status, elapsedMs };
}

export async function runCleanupSteps(
  steps: Array<[name: string, start: () => Promise<unknown>]>,
  timeoutMs: number = CLEANUP_STEP_TIMEOUT_MS,
): Promise<CleanupStepOutcome[]> {
  return Promise.all(steps.map(([name, start]) => runCleanupStep(name, start, timeoutMs)));
}
