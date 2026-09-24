/**
 * src/orchestrator/unattended-turn.ts
 *
 * Process-global "this turn has no human at the composer" scope.
 *
 * Some turns are machine-driven stages of a longer autonomous run. `/ideal`'s
 * VERIFY stage is one: `sprint-runner.buildVerifyAgent.runTaskRequest` runs the
 * verify prompt through `ctx.processMessageFn`, i.e. as a normal top-level turn
 * on the parent session — so it inherits the MAIN turn's tool set, `ask_user`
 * included. That tool blocks inside its AI-SDK `execute()` until a human answers
 * a card.
 *
 * MEASURED (run `muc2joffe506`, sprint 2, sub-session `548913168ae0`): the verify
 * stage called `ask_user` at 14:50:21.922Z asking whether to debug a Playwright
 * script, use the `computer` tool, or mark VERIFY_FAIL, because `agent-browser`
 * was absent from the host. The card opened, nobody was watching it, the stage's
 * 600s silence budget expired at 14:52:34 and `sprints/2-outcome.json` recorded
 * `verify: "ERROR"`. The `tool_calls` row for that `ask_user` completed at
 * 2026-09-24T01:14:10.012Z — 10.5 HOURS later, answered by a much later pass.
 *
 * A verify stage that stops to ask a question is worse than one that reports what
 * it could and could not verify: the question cost the whole stage AND three
 * phases of real verification work. So the tool is not offered on an unattended
 * turn at all, which is the contract `createBuiltinTools` already documents for
 * `opts.askUser` ("Omitted (headless with no answerer) → the tool is absent, so
 * the model never calls a card that can never be answered"). The prompt tells the
 * model what to do instead — see `buildVerifyTaskPrompt`'s unattended directive.
 *
 * Scope shape is copied verbatim from `beginRecallNagSuppression`
 * (`src/ee/recall-ledger.ts`), which solves the same problem for the same turn:
 * a depth counter, declared at the ONE call site that knows the turn is
 * machine-driven, consulted at the point of registration. A counter rather than a
 * boolean so a nested scope's release cannot re-open the outer one.
 *
 * Process-scoped rather than `AsyncLocalStorage` (unlike `ideal-run-scope.ts`)
 * because the orchestrator serialises turns behind the write-mutex, so at most one
 * unattended stage turn is open at a time — the same argument `recall-ledger.ts`
 * makes. The failure mode if that ever stops holding is `ask_user` missing from a
 * chat turn that would have tolerated it, never a card opening on a turn that
 * cannot answer one.
 */

let _unattendedDepth = 0;

/**
 * True while the current turn is a machine-driven stage with no human at the
 * composer. Consulted before registering any tool that blocks on a human.
 */
export function isUnattendedTurn(): boolean {
  return _unattendedDepth > 0;
}

/**
 * Open an unattended-turn scope. Returns a release function that is idempotent —
 * a double-release must not decrement someone else's scope.
 */
export function beginUnattendedTurn(): () => void {
  _unattendedDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _unattendedDepth = Math.max(0, _unattendedDepth - 1);
  };
}

/** Test-only: force the counter back to zero. */
export function __resetUnattendedTurnForTests(): void {
  _unattendedDepth = 0;
}
