/**
 * judge.ts — M4 of Self-QA.
 *
 * Pure function: takes a ScenarioRun (events + final frame) and a list of
 * Expectations, returns a JudgeVerdict + per-expectation reasoning.
 *
 * Rule-based — NO LLM call. Reproducible and cheap.
 *
 * Verdict policy:
 *   - A check failed                 → "fail"          (we know the answer: no)
 *   - Child crashed                  → "inconclusive"  (nothing was established)
 *   - A `wait_for` step expired but
 *     every expectation still passed → "inconclusive"  (suspicious, unproven)
 *   - Everything passed cleanly      → "pass"
 *
 * The expectation loop now runs in EVERY case, including crash and timeout.
 * Previously a timeout returned early with a single synthetic `idleReached`
 * check, so the scenario's own `selectorPresent` / `noErrorToast` assertions
 * were never evaluated — they did not fail, they silently ceased to exist.
 * That is the failure class this module is supposed to catch, so it must not
 * commit it: a run that could not be driven still reports WHAT would have
 * failed, and the `inconclusive` verdict records that it was not proven.
 */

import type { LiveEvent, LiveFrame, UINode } from "@muonroi/agent-harness-core/protocol";
import { matchSelector } from "@muonroi/agent-harness-core/selector";
import type { CheckResult, Expectation, JudgeResult, ScenarioRun } from "./types.js";

export function judge(run: ScenarioRun): JudgeResult {
  const durationMs = run.endedAt - run.startedAt;
  // Harness-level context first, so a reader sees WHY before WHAT. These are
  // NOT assertions about the product, so they are excluded from `anyFailed` —
  // a dead child means "unproven", not "the feature is broken".
  const harnessChecks: CheckResult[] = [];
  if (run.crashed) {
    harnessChecks.push({
      expectation: { kind: "idleReached" },
      passed: false,
      reason: `Child process crashed before scenario completed: ${run.errorTrace ?? "unknown"}`,
    });
  } else if (run.timedOut) {
    harnessChecks.push({
      expectation: { kind: "idleReached" },
      passed: false,
      reason: `Scenario exceeded budget of ${run.scenario.budgetMs}ms`,
    });
  }
  for (const t of run.syncTimeouts) {
    harnessChecks.push({ expectation: { kind: "idleReached" }, passed: false, reason: `Sync step expired: ${t}` });
  }

  // ALWAYS evaluate the scenario's own expectations — even after a crash or a
  // timeout. A dropped assertion reads as success; a failed one reads as
  // failure. Only the latter is honest.
  const expectationChecks: CheckResult[] = run.scenario.expectations.map((exp) => evaluate(exp, run));
  const checks: CheckResult[] = [...harnessChecks, ...expectationChecks];

  const anyFailed = expectationChecks.some((c) => !c.passed);
  const unproven = run.crashed || run.timedOut || run.syncTimeouts.length > 0;

  // A definite negative outranks "could not establish": if an expectation
  // actually failed we know the answer, and reporting it as inconclusive would
  // understate a real regression.
  let verdict: JudgeResult["verdict"];
  if (anyFailed) verdict = "fail";
  else if (unproven) verdict = "inconclusive";
  else verdict = "pass";

  return { verdict, scenarioId: run.scenario.id, durationMs, checks };
}

function evaluate(exp: Expectation, run: ScenarioRun): CheckResult {
  switch (exp.kind) {
    case "noErrorToast":
      return checkNoErrorToast(exp, run.events);
    case "eventFired":
      return checkEventFired(exp, run.events);
    case "eventAbsent":
      return checkEventAbsent(exp, run.events);
    case "selectorPresent":
      return checkSelectorPresent(exp, run.finalFrame);
    case "selectorAbsent":
      return checkSelectorAbsent(exp, run.finalFrame);
    case "idleReached":
      return checkIdleReached(exp, run);
  }
}

function checkNoErrorToast(exp: Expectation, events: LiveEvent[]): CheckResult {
  const errorToasts = events.filter((e) => e.t === "event" && e.kind === "toast" && e.level === "error");
  if (errorToasts.length === 0) {
    return { expectation: exp, passed: true, reason: "No error-level toasts observed" };
  }
  const sample = errorToasts[0];
  const text = sample && "text" in sample ? sample.text : "<no text>";
  return {
    expectation: exp,
    passed: false,
    reason: `Found ${errorToasts.length} error toast(s); first: ${text}`,
  };
}

function checkEventFired(exp: Expectation, events: LiveEvent[]): CheckResult {
  if (exp.kind !== "eventFired") throw new Error("invariant");
  const matches = events.filter((e) => e.t === "event" && e.kind === exp.event);
  if (matches.length === 0) {
    return {
      expectation: exp,
      passed: false,
      reason: `Event '${exp.event}' was never emitted`,
    };
  }
  if (!exp.payloadMatch) {
    return { expectation: exp, passed: true, reason: `Event '${exp.event}' fired ${matches.length}×` };
  }
  const hit = matches.find((e) => payloadMatches(e, exp.payloadMatch!));
  if (hit) {
    return {
      expectation: exp,
      passed: true,
      reason: `Event '${exp.event}' fired with matching payload`,
    };
  }
  return {
    expectation: exp,
    passed: false,
    reason: `Event '${exp.event}' fired but payload did not match expected fields`,
  };
}

function checkEventAbsent(exp: Expectation, events: LiveEvent[]): CheckResult {
  if (exp.kind !== "eventAbsent") throw new Error("invariant");
  const hit = events.find((e) => e.t === "event" && e.kind === exp.event);
  if (hit) {
    return {
      expectation: exp,
      passed: false,
      reason: `Event '${exp.event}' was emitted but expected absent`,
    };
  }
  return { expectation: exp, passed: true, reason: `Event '${exp.event}' correctly absent` };
}

function checkSelectorPresent(exp: Expectation, frame: LiveFrame | null): CheckResult {
  if (exp.kind !== "selectorPresent") throw new Error("invariant");
  if (!frame) {
    return {
      expectation: exp,
      passed: false,
      reason: "No final frame captured — cannot verify selector presence",
    };
  }
  const hits = findBySelector(frame, exp.selector);
  if (hits.length > 0) {
    return {
      expectation: exp,
      passed: true,
      reason: `Selector '${exp.selector}' matched ${hits.length} node(s)`,
    };
  }
  return {
    expectation: exp,
    passed: false,
    reason: `Selector '${exp.selector}' matched 0 nodes`,
  };
}

function checkSelectorAbsent(exp: Expectation, frame: LiveFrame | null): CheckResult {
  if (exp.kind !== "selectorAbsent") throw new Error("invariant");
  if (!frame) {
    return { expectation: exp, passed: true, reason: "No frame; treating as absent" };
  }
  const hits = findBySelector(frame, exp.selector);
  if (hits.length === 0) {
    return { expectation: exp, passed: true, reason: `Selector '${exp.selector}' correctly absent` };
  }
  return {
    expectation: exp,
    passed: false,
    reason: `Selector '${exp.selector}' matched ${hits.length} node(s) but expected none`,
  };
}

function checkIdleReached(exp: Expectation, run: ScenarioRun): CheckResult {
  if (exp.kind !== "idleReached") throw new Error("invariant");
  const duration = run.endedAt - run.startedAt;
  const budget = exp.withinMs ?? run.scenario.budgetMs;
  if (run.timedOut || run.crashed) {
    return {
      expectation: exp,
      passed: false,
      reason: "Run did not finish cleanly — idle not reached",
    };
  }
  // Idle is signalled by the harness via `{ t: "idle" }` on the sidechannel and
  // counted by the orchestrator. Requiring an OBSERVED sentinel is the whole
  // check: inferring idle from "did not crash and finished inside the budget"
  // made this a tautology that a scenario with zero steps satisfied — a run
  // with `durationMs: 0` and an empty frame was reported as having reached idle.
  if (run.idleObserved <= 0) {
    return {
      expectation: exp,
      passed: false,
      reason: `No idle sentinel observed during the scenario (duration ${duration}ms)`,
    };
  }
  if (duration <= budget) {
    return {
      expectation: exp,
      passed: true,
      reason: `Idle reached in ${duration}ms after ${run.idleObserved} idle sentinel(s) (budget ${budget}ms)`,
    };
  }
  return {
    expectation: exp,
    passed: false,
    reason: `Run finished in ${duration}ms which exceeds idle budget ${budget}ms`,
  };
}

function payloadMatches(event: LiveEvent, expected: Record<string, unknown>): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: event is heterogeneous union
  const e = event as any;
  for (const [k, v] of Object.entries(expected)) {
    if (e[k] !== v) return false;
  }
  return true;
}

/**
 * Collect every node in the frame matching `selector`.
 *
 * `matchSelector(root, sel)` returns a UINode[] of matching DESCENDANTS
 * (`packages/agent-harness-core/src/selector.ts:247`), and it already walks the
 * subtree itself (`walk` visits the root first, :242-245).
 *
 * The previous implementation was `if (matchSelector(n, selector)) out.push(n)`
 * — but `[]` is TRUTHY in JavaScript, so the condition never discriminated and
 * every node in the tree was pushed. That made `selectorPresent` pass whenever
 * the frame held any node at all, and `selectorAbsent` fail for the same
 * reason: two assertions that could not observe what they claimed to. Measured
 * 2026-09-05: `selectorPresent 'id=subagents-modal'` reported "matched 4
 * node(s)" against a 4-node frame, and `id=subagent-editor` "matched 5" against
 * a 5-node frame — always the total node count, never the real match count.
 */
function findBySelector(frame: LiveFrame, selector: string): UINode[] {
  const out: UINode[] = [];
  const seen = new Set<UINode>();
  for (const root of frame.nodes) {
    for (const hit of matchSelector(root, selector)) {
      if (seen.has(hit)) continue;
      seen.add(hit);
      out.push(hit);
    }
  }
  return out;
}

/**
 * Convenience for the orchestrator/CLI to summarise a batch of judgments.
 */
export function summariseResults(results: JudgeResult[]): {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  passRate: number;
} {
  const total = results.length;
  const passed = results.filter((r) => r.verdict === "pass").length;
  const failed = results.filter((r) => r.verdict === "fail").length;
  const inconclusive = results.filter((r) => r.verdict === "inconclusive").length;
  return {
    total,
    passed,
    failed,
    inconclusive,
    passRate: total === 0 ? 0 : passed / total,
  };
}
