/**
 * Build the `halt_card_open` interaction-log payload for a `/ideal`
 * product-loop run that broke with a thrown error (use-app-logic.tsx's
 * top-level catch around the product-loop `for await`).
 *
 * Before this existed, the ONLY thing persisted for this halt was
 * `{reason:"sprint_failed", trigger:"loop_throw", sprintN}` — the error text
 * itself was computed (`errMsg`), shown on screen
 * (`buildAssistantEntry(\`Product loop error: ${errMsg}\`)`), and then dropped
 * three lines later at the `logUIInteraction` call. A post-mortem on a run
 * that broke this way (measured: session 1f9f57415170, run mu3ks8zwe8d5) had
 * no error text in the DB at all — diagnosing it required asking a human for
 * a terminal screenshot.
 *
 * Extracted as a plain function (not inlined in the hook) because
 * `use-app-logic.tsx` is `@ts-nocheck` with no existing unit-test harness —
 * this is testable in isolation without standing up the hook itself.
 *
 * Truncated per the same convention `logSprintImplError`
 * (product-loop/sprint-runner.ts) already uses: a runaway message or stack
 * must not blow a single `interaction_logs` row. The message is an internal
 * error string, not a secret — still capped defensively (No Silent Catch:
 * log with context, but bounded).
 */

const MAX_ERROR_MESSAGE_CHARS = 2_000;
const MAX_ERROR_STACK_LINES = 5;

export interface SprintFailedHaltData {
  reason: "sprint_failed";
  trigger: string;
  sprintN: number | null;
  errorMessage: string;
  errorStack?: string;
}

export function buildSprintFailedHaltData(
  err: unknown,
  opts: { trigger: string; sprintN: number | null },
): SprintFailedHaltData {
  const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE_CHARS);
  const errorStack =
    err instanceof Error && err.stack ? err.stack.split("\n").slice(0, MAX_ERROR_STACK_LINES).join("\n") : undefined;
  return {
    reason: "sprint_failed",
    trigger: opts.trigger,
    sprintN: opts.sprintN,
    errorMessage,
    ...(errorStack ? { errorStack } : {}),
  };
}
