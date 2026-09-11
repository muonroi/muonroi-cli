/**
 * src/utils/ideal-run-scope.ts
 *
 * Run-scoped "no limits" switch for `/ideal`.
 *
 * The user's decision (their model usage is sponsored): an `/ideal` run has no
 * budget of any kind — no spend cap, no token/char/tool-output budget, no
 * step/round/sprint effort cap. Normal chat and a standalone `/council` keep
 * every limit they have today.
 *
 * Most of those limits live in SHARED machinery (the top-level tool loop, the
 * `task` sub-agent runner, the model gate, the council LLM) that `/ideal`
 * reaches through `processMessageFn` / `runIsolatedTask`. A flag on the
 * orchestrator instance would leak: it would be read by any chat turn that runs
 * while it is set, and an abandoned generator that never reaches its `finally`
 * would leave it set forever. So the switch is an `AsyncLocalStorage` scope
 * instead. It is carried by the ASYNC CALL CHAIN, not by the process:
 *
 *   - `scopeGeneratorToIdealRun(gen)` enters the scope for every `next()` /
 *     `return()` / `throw()` of the `/ideal` generator, so all work the run does
 *     — including awaits that resume later — sees `isIdealRunUnlimited() === true`.
 *   - The consumer that iterates the generator (the TUI) runs OUTSIDE the scope,
 *     so a chat turn it starts, concurrently or afterwards, sees `false`.
 *   - Nothing to reset: when the run's promises settle the scope is simply gone.
 *
 * Verified under both runtimes this repo uses (Bun 1.3.13 and Node 24): a
 * concurrent non-scoped continuation and a post-run continuation both read no
 * store, while every await inside the scoped generator reads it.
 *
 * Leaf module on purpose (only `node:async_hooks`): providers, orchestrator,
 * council and product-loop all read it without an import cycle.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface IdealRunScope {
  /** Free-form label for diagnostics (e.g. the subcommand). */
  readonly label: string;
}

const storage = new AsyncLocalStorage<IdealRunScope>();

/** True only inside the async call chain of an `/ideal` run. */
export function isIdealRunUnlimited(): boolean {
  return storage.getStore() !== undefined;
}

/** Run `fn` (and everything it awaits) inside the `/ideal` scope. */
export function runInIdealScope<T>(fn: () => T, label = "ideal"): T {
  return storage.run({ label }, fn);
}

/**
 * Wrap an async generator so every resumption runs inside the `/ideal` scope.
 *
 * Wrapping only `next`/`return`/`throw` is what keeps the scope from leaking:
 * the caller's own code between two `next()` calls is not inside `storage.run`,
 * so whatever the caller does with a yielded chunk — including starting a chat
 * turn — is unscoped.
 */
export function scopeGeneratorToIdealRun<T, R, N>(
  gen: AsyncGenerator<T, R, N>,
  label = "ideal",
): AsyncGenerator<T, R, N> {
  const scope: IdealRunScope = { label };
  const wrapped: AsyncGenerator<T, R, N> = {
    next: (...args: [] | [N]) => storage.run(scope, () => gen.next(...args)),
    return: (value: R | PromiseLike<R>) => storage.run(scope, () => gen.return(value)),
    throw: (err: unknown) => storage.run(scope, () => gen.throw(err)),
    [Symbol.asyncIterator]() {
      return wrapped;
    },
  } as AsyncGenerator<T, R, N>;
  return wrapped;
}
