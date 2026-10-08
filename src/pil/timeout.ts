import { withDeadlineRace } from "../utils/llm-deadline.js";

export class PilTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`PIL automated preparation exceeded ${budgetMs}ms deadline`);
    this.name = "PilTimeoutError";
  }
}

export interface PilExecutionBudget {
  signal: AbortSignal;
  waitForUser<T>(fn: () => Promise<T>): Promise<T>;
}

/** Bound automated work even when an await ignores abort; only human waits pause the clock. */
export async function withPilExecutionBudget<T>(
  fn: (budget: PilExecutionBudget) => Promise<T>,
  budgetMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let remainingMs = budgetMs;
  let armedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });

  const arm = () => {
    armedAt = Date.now();
    timer = setTimeout(() => controller.abort(new PilTimeoutError(budgetMs)), Math.max(0, remainingMs));
  };
  if (!controller.signal.aborted) arm();
  const budget: PilExecutionBudget = {
    signal: controller.signal,
    waitForUser: async (wait) => {
      controller.signal.throwIfAborted();
      if (timer) clearTimeout(timer);
      remainingMs -= Date.now() - armedAt;
      try {
        return await withDeadlineRace(wait, 0, "PIL user answer", controller.signal, 0);
      } finally {
        if (!finished && !controller.signal.aborted) arm();
      }
    },
  };
  try {
    controller.signal.throwIfAborted();
    return await withDeadlineRace(() => fn(budget), 0, "PIL preparation", controller.signal, 0);
  } catch (err) {
    const reason = controller.signal.aborted ? controller.signal.reason : err;
    console.error(`[pil] preparation stopped: ${reason instanceof Error ? reason.message : String(reason)}`);
    controller.abort(reason);
    throw reason;
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

/** Legacy value timeout helper, also used by callers outside the bounded pipeline. */

export function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
}
