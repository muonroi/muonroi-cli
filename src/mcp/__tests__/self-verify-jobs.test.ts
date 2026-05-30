import { describe, expect, it } from "vitest";
import { JobManager, type Runner } from "../self-verify-jobs.js";

// A controllable stub runner: tier1 resolves/rejects on demand.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRunner(opts: {
  tier1?: () => Promise<unknown>;
  agentic?: () => Promise<unknown>;
}): Runner {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tier1: (_o, log) => {
      log("tier1 started");
      return (opts.tier1?.() ?? Promise.resolve({ summary: { passed: 1 } })) as Promise<any>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentic: (_o, log) => {
      log("agentic started");
      return (opts.agentic?.() ?? Promise.resolve({ verdict: "pass" })) as Promise<any>;
    },
  };
}

describe("JobManager", () => {
  it("start returns a runId and job is initially running", () => {
    const jm = new JobManager(makeRunner({ tier1: () => deferred<unknown>().promise }));
    const runId = jm.start({ kind: "tier1" });
    expect(typeof runId).toBe("string");
    expect(jm.status(runId)?.status).toBe("running");
  });

  it("transitions to done and stores the report", async () => {
    const d = deferred<unknown>();
    const jm = new JobManager(makeRunner({ tier1: () => d.promise }));
    const runId = jm.start({ kind: "tier1" });
    d.resolve({ summary: { passed: 2 } });
    await d.promise;
    await Promise.resolve(); // let the .then microtask run
    const job = jm.status(runId)!;
    expect(job.status).toBe("done");
    expect(job.report).toEqual({ summary: { passed: 2 } });
    expect(job.finishedAt).toBeGreaterThan(0);
  });

  it("transitions to error on rejection", async () => {
    const d = deferred<unknown>();
    const jm = new JobManager(makeRunner({ tier1: () => d.promise }));
    const runId = jm.start({ kind: "tier1" });
    d.reject(new Error("boom"));
    await d.promise.catch(() => {});
    await Promise.resolve();
    const job = jm.status(runId)!;
    expect(job.status).toBe("error");
    expect(job.error).toBe("boom");
  });

  it("cancel marks a running job cancelled and discards a late result", async () => {
    const d = deferred<unknown>();
    const jm = new JobManager(makeRunner({ tier1: () => d.promise }));
    const runId = jm.start({ kind: "tier1" });
    expect(jm.cancel(runId)).toBe(true);
    expect(jm.status(runId)?.status).toBe("cancelled");
    d.resolve({ summary: { passed: 9 } });
    await d.promise;
    await Promise.resolve();
    expect(jm.status(runId)?.status).toBe("cancelled"); // late resolve ignored
  });

  it("captures log lines from the runner", async () => {
    const jm = new JobManager(makeRunner({}));
    const runId = jm.start({ kind: "tier1" });
    await Promise.resolve();
    expect(jm.status(runId)?.logBuffer).toContain("tier1 started");
  });

  it("evicts oldest jobs beyond the cap of 20", () => {
    const jm = new JobManager(makeRunner({ tier1: () => new Promise(() => {}) }));
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(jm.start({ kind: "tier1" }));
    expect(jm.list().length).toBe(20);
    expect(jm.status(ids[0])).toBeUndefined(); // oldest evicted
    expect(jm.status(ids[24])).toBeDefined();
  });
});
