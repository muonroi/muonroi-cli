/**
 * R5 — re-entrancy safety of the `/ideal` autonomous-permission elevation.
 *
 * `runProductLoopV1` hands the product loop two closures that each elevate the
 * session from `safe` to `auto-edit` for the duration of their work:
 * `processMessageFn` (the streamed top-level turn) and `runIsolatedTask` (the
 * isolated sprint-implement child). Both mutate the SAME `Agent.permissionMode`
 * field.
 *
 * The original implementation was a per-call save/restore pair (`const prev =
 * self.permissionMode; ... finally { self.permissionMode = prev }`). That is
 * correct only while the scopes strictly nest. They do not: `sprint-runner.ts`
 * races the isolated child against a wall-clock deadline
 * (`runIsolatedImplWithDeadline` -> `withIsolatedImplDeadline` ->
 * `Promise.race([work, deadline])`), and when the deadline wins the caller
 * proceeds while `work` is still live — `controller.abort()` is best-effort and
 * the child was measured still streaming for 220s / 32 steps afterwards. So an
 * abandoned child's `finally` lands at an arbitrary point inside a LATER turn's
 * elevation scope, and the two scopes overlap without nesting.
 *
 * These tests assert the security property directly: whatever the interleaving,
 * once every elevation scope has ended the session is back at the mode it
 * started in. They are written against the two closures the PRODUCTION code
 * path actually builds (captured out of the `runProductLoop` call), not against
 * a helper — this repo has shipped a green helper test over an unwired call
 * site more than once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../types/index.js";
import type { PermissionMode } from "../utils/permission-mode.js";

/** The two elevating closures, as built by the real `runProductLoopV1`. */
interface CapturedClosures {
  processMessageFn: (m: string) => AsyncGenerator<StreamChunk, void, unknown>;
  runIsolatedTask: (
    request: unknown,
    opts?: { abortSignal?: AbortSignal; onActivity?: (d: string) => void },
  ) => Promise<unknown>;
}

let captured: CapturedClosures | null = null;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing awaits these rejections until the test does; keep node quiet.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function importAgentModule() {
  vi.resetModules();
  const { loadCatalog } = await import("../models/registry.js");
  await loadCatalog();
  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    appendSystemMessage: vi.fn(() => 0),
    buildChatEntries: vi.fn(() => []),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadSessionChainTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));
  // Capture the closures the real wiring passes down, then end the run
  // immediately — we drive the closures ourselves.
  vi.doMock("../product-loop/index.js", () => ({
    runProductLoop: (args: CapturedClosures) => {
      captured = { processMessageFn: args.processMessageFn, runIsolatedTask: args.runIsolatedTask };
      return (async function* () {})();
    },
  }));
  return import("./orchestrator");
}

/**
 * Boot an Agent and capture the two elevating closures from a real
 * `runProductLoopV1` invocation. `status` is used so the LLM depth-classify
 * block (gated on `subcommand === "start" && idea`) never runs.
 */
async function bootCapture(permissionMode: PermissionMode) {
  captured = null;
  const { Agent } = await importAgentModule();
  const agent = new Agent(undefined, undefined, undefined, undefined, {
    persistSession: false,
    permissionMode,
  });
  for await (const _chunk of agent.runProductLoopV1({
    subcommand: "status",
    flags: { doneThreshold: 0.8 },
  })) {
    // drain
  }
  // Read through an assertion: the assignment happens inside the `runProductLoop`
  // mock callback, which control-flow analysis cannot see, so TS would otherwise
  // narrow `captured` to `null` from the reset above and then to `never` here.
  const closures = captured as CapturedClosures | null;
  if (!closures) throw new Error("runProductLoop was not reached — closure capture failed");
  return { agent, closures };
}

/** Drive a `processMessageFn` turn, with explicit start/finish control. */
function drivePmfTurn(agent: { processMessage: unknown }, closures: CapturedClosures) {
  const gate = deferred<void>();
  const started = deferred<void>();
  (agent as { processMessage: unknown }).processMessage = async function* () {
    started.resolve();
    await gate.promise;
    yield { type: "content", content: "done" } as StreamChunk;
  };
  const gen = closures.processMessageFn("impl");
  // The first `.next()` runs the generator body past the elevation and then
  // blocks on the gate; the second drains the generator to completion, which is
  // when its `finally` (the restore) runs. `done` therefore settles only after
  // the turn's elevation scope has closed.
  const done = gen.next().then(() => gen.next());
  return { started: started.promise, finish: () => gate.resolve(), done };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../storage/index.js");
  vi.doUnmock("../product-loop/index.js");
  captured = null;
});

describe("/ideal autonomous-permission elevation is re-entrancy safe", { timeout: 60_000 }, () => {
  it("single runIsolatedTask: elevates during, restores after", async () => {
    const { agent, closures } = await bootCapture("safe");
    const inner = deferred<unknown>();
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => inner.promise as never);

    expect(agent.effectivePermissionMode).toBe("safe");
    const task = closures.runIsolatedTask({ agent: "a", description: "d" });
    // Elevated while the work is in flight.
    expect(agent.effectivePermissionMode).toBe("auto-edit");
    inner.resolve({ success: true });
    await task;
    expect(agent.effectivePermissionMode).toBe("safe");
  });

  it("two overlapping runIsolatedTask calls settling out of order restore 'safe'", async () => {
    const { agent, closures } = await bootCapture("safe");
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const calls = [a, b];
    let n = 0;
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => calls[n++]!.promise as never);

    // A starts first, B second — then A settles FIRST and B LAST. With the old
    // per-call save/restore this is the leaking order: B captured the already-
    // elevated "auto-edit" as its `prev`, so B's restore re-elevates the session
    // after A has already put it back to "safe".
    const taskA = closures.runIsolatedTask({ agent: "a", description: "A" });
    const taskB = closures.runIsolatedTask({ agent: "b", description: "B" });
    expect(agent.effectivePermissionMode).toBe("auto-edit");

    a.resolve({ success: true });
    await taskA;
    b.resolve({ success: true });
    await taskB;

    expect(agent.effectivePermissionMode).toBe("safe");
  });

  it("the reachable path: an abandoned child settling inside a later processMessageFn turn", async () => {
    // This is the interleaving `sprint-runner.ts` actually produces. The
    // isolated child is started, the wall-clock deadline fires, the caller
    // moves on and starts a top-level turn through `processMessageFn`, and the
    // abandoned child then settles WHILE that turn is still in its own
    // elevation scope. The turn's restore is what re-elevates the session.
    const { agent, closures } = await bootCapture("safe");
    const child = deferred<unknown>();
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => child.promise as never);

    // 1. Sprint starts the isolated implement child.
    const abandoned = closures.runIsolatedTask({ agent: "impl", description: "sprint 1" });
    expect(agent.effectivePermissionMode).toBe("auto-edit");

    // 2. Deadline wins the Promise.race; the caller proceeds WITHOUT awaiting
    //    `abandoned`, and opens a top-level turn.
    const turn = drivePmfTurn(agent, closures);
    await turn.started;

    // 3. The abandoned child finally settles, mid-turn.
    child.resolve({ success: true });
    await abandoned;

    // 4. The turn ends.
    turn.finish();
    await turn.done;

    expect(agent.effectivePermissionMode).toBe("safe");
  });

  it("the other overlap order (last-started settles first) was already safe — pin it", async () => {
    // Documented deliberately: of the two overlapping orders, only ONE leaked.
    //   A start, B start, A end, B end  -> leaked (covered above)
    //   A start, B start, B end, A end  -> fine, even before the fix
    // In this order B captures the elevated "auto-edit" and restores it while A
    // is still running, then A restores the original "safe" last. An abandoned
    // child that settles strictly AFTER a later turn has both elevated and
    // restored therefore does NOT reproduce the bug — the child must settle
    // INSIDE the later scope. This test exists so that distinction cannot be
    // lost again, and so the fix is shown not to regress the benign order.
    const { agent, closures } = await bootCapture("safe");
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const calls = [a, b];
    let n = 0;
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => calls[n++]!.promise as never);

    const taskA = closures.runIsolatedTask({ agent: "a", description: "A" });
    const taskB = closures.runIsolatedTask({ agent: "b", description: "B" });
    b.resolve({ success: true });
    await taskB;
    a.resolve({ success: true });
    await taskA;

    expect(agent.effectivePermissionMode).toBe("safe");
  });

  it("a processMessageFn turn abandoned by an early exit still restores", async () => {
    // A consumer that breaks out of `for await` (or a `yield*` that unwinds)
    // calls `.return()` on the generator, which runs its `finally`. This is the
    // path `sprint-runner` takes when the impl stage is cut short, so it must
    // not strand an elevation.
    //
    // Known residual, UNCHANGED by this fix: `withImplIdleWatchdog`
    // (sprint-runner.ts) races `it.next()` against its timers and, when a timer
    // wins, throws WITHOUT calling `it.return()` — its own doc notes "the
    // suspended orchestrator promise may leak in the background". Such a turn's
    // `finally` never runs, so its elevation is never released. That is exactly
    // the pre-existing exposure: under the previous save/restore the same
    // abandonment left `permissionMode` at "auto-edit" with nothing able to put
    // it back either, since the only writer that could was that same dead
    // `finally`. Equivalent, and out of scope here.
    const { agent, closures } = await bootCapture("safe");
    const gate = deferred<void>();
    const started = deferred<void>();
    (agent as unknown as { processMessage: unknown }).processMessage = async function* () {
      started.resolve();
      yield { type: "content", content: "partial" } as StreamChunk;
      await gate.promise;
    };
    const gen = closures.processMessageFn("impl");
    await gen.next();
    await started.promise;
    expect(agent.effectivePermissionMode).toBe("auto-edit");

    await gen.return(undefined);
    expect(agent.effectivePermissionMode).toBe("safe");
    gate.resolve();
  });

  it("a throw from the inner task still restores", async () => {
    const { agent, closures } = await bootCapture("safe");
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => {
      throw new Error("inner blew up");
    });
    await expect(closures.runIsolatedTask({ agent: "a", description: "d" })).rejects.toThrow("inner blew up");
    expect(agent.effectivePermissionMode).toBe("safe");
  });

  it("a throw from one of two overlapping tasks still restores", async () => {
    const { agent, closures } = await bootCapture("safe");
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const calls = [a, b];
    let n = 0;
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => calls[n++]!.promise as never);

    const taskA = closures.runIsolatedTask({ agent: "a", description: "A" });
    const taskB = closures.runIsolatedTask({ agent: "b", description: "B" });
    a.reject(new Error("A failed"));
    await expect(taskA).rejects.toThrow("A failed");
    b.resolve({ success: true });
    await taskB;

    expect(agent.effectivePermissionMode).toBe("safe");
  });

  it("a throwing subagent-status listener does not strand the elevation", async () => {
    // `runIsolatedTask`'s `finally` calls `emitSubagentStatus(null)`, which
    // synchronously invokes externally-registered UI listeners with no guard.
    // A listener that throws propagates out of the `finally`; if the restore is
    // sequenced after that call it is skipped and the session stays elevated
    // forever. The restore therefore runs first.
    const { agent, closures } = await bootCapture("safe");
    vi.spyOn(agent, "runTaskRequest").mockResolvedValue({ success: true } as never);
    agent.onSubagentStatus(() => {
      throw new Error("UI listener blew up");
    });

    await expect(closures.runIsolatedTask({ agent: "a", description: "d" })).rejects.toThrow("UI listener blew up");
    expect(agent.effectivePermissionMode).toBe("safe");
  });

  it("does not downgrade a session that is already auto-edit", async () => {
    const { agent, closures } = await bootCapture("auto-edit");
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const calls = [a, b];
    let n = 0;
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => calls[n++]!.promise as never);

    const taskA = closures.runIsolatedTask({ agent: "a", description: "A" });
    const taskB = closures.runIsolatedTask({ agent: "b", description: "B" });
    expect(agent.effectivePermissionMode).toBe("auto-edit");
    a.resolve({ success: true });
    await taskA;
    b.resolve({ success: true });
    await taskB;

    expect(agent.effectivePermissionMode).toBe("auto-edit");
  });

  it("does not downgrade a yolo session — elevation is a 'safe'-only promotion", async () => {
    const { agent, closures } = await bootCapture("yolo");
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const calls = [a, b];
    let n = 0;
    vi.spyOn(agent, "runTaskRequest").mockImplementation(() => calls[n++]!.promise as never);

    const taskA = closures.runIsolatedTask({ agent: "a", description: "A" });
    // yolo must never be knocked down to auto-edit by the elevation.
    expect(agent.effectivePermissionMode).toBe("yolo");
    const taskB = closures.runIsolatedTask({ agent: "b", description: "B" });
    a.resolve({ success: true });
    await taskA;
    expect(agent.effectivePermissionMode).toBe("yolo");
    b.resolve({ success: true });
    await taskB;

    expect(agent.effectivePermissionMode).toBe("yolo");
  });

  it("single processMessageFn turn: elevates during, restores after", async () => {
    const { agent, closures } = await bootCapture("safe");
    const turn = drivePmfTurn(agent, closures);
    await turn.started;
    expect(agent.effectivePermissionMode).toBe("auto-edit");
    turn.finish();
    await turn.done;
    expect(agent.effectivePermissionMode).toBe("safe");
  });
});
