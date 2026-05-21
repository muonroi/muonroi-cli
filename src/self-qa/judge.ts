/**
 * judge.ts — M4 of Self-QA.
 *
 * Pure function: takes a ScenarioRun (events + final frame) and a list of
 * Expectations, returns a JudgeVerdict + per-expectation reasoning.
 *
 * Rule-based — NO LLM call. Reproducible and cheap.
 *
 * Verdict policy:
 *   - All checks passed              → "pass"
 *   - One or more checks failed      → "fail"
 *   - Run crashed / timed out        → "inconclusive"  (don't claim pass/fail)
 */

import type { LiveEvent, LiveFrame, UINode } from "@muonroi/agent-harness-core/protocol";
import { matchSelector } from "@muonroi/agent-harness-core/selector";
import type { CheckResult, Expectation, JudgeResult, ScenarioRun } from "./types.js";

export function judge(run: ScenarioRun): JudgeResult {
  const durationMs = run.endedAt - run.startedAt;

  if (run.crashed) {
    return {
      verdict: "inconclusive",
      scenarioId: run.scenario.id,
      durationMs,
      checks: [
        {
          expectation: { kind: "idleReached" },
          passed: false,
          reason: `Child process crashed before scenario completed: ${run.errorTrace ?? "unknown"}`,
        },
      ],
    };
  }

  if (run.timedOut) {
    return {
      verdict: "inconclusive",
      scenarioId: run.scenario.id,
      durationMs,
      checks: [
        {
          expectation: { kind: "idleReached" },
          passed: false,
          reason: `Scenario exceeded budget of ${run.scenario.budgetMs}ms`,
        },
      ],
    };
  }

  const checks: CheckResult[] = [];
  for (const exp of run.scenario.expectations) {
    checks.push(evaluate(exp, run));
  }

  const allPassed = checks.every((c) => c.passed);
  return {
    verdict: allPassed ? "pass" : "fail",
    scenarioId: run.scenario.id,
    durationMs,
    checks,
  };
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
  // Idle is signalled by the harness via `{ t: "idle" }` — driver._ingest
  // converts it to a non-event sentinel. We can also infer idle when the
  // scenario completed without timeout/crash.
  if (run.timedOut || run.crashed) {
    return {
      expectation: exp,
      passed: false,
      reason: "Run did not finish cleanly — idle not reached",
    };
  }
  if (duration <= budget) {
    return {
      expectation: exp,
      passed: true,
      reason: `Idle reached in ${duration}ms (budget ${budget}ms)`,
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

function findBySelector(frame: LiveFrame, selector: string): UINode[] {
  const out: UINode[] = [];
  const visit = (nodes: UINode[]): void => {
    for (const n of nodes) {
      if (matchSelector(n, selector)) out.push(n);
      if (n.children) visit(n.children);
    }
  };
  visit(frame.nodes);
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
