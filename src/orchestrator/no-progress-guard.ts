/**
 * src/orchestrator/no-progress-guard.ts
 *
 * Termination for tool loops that no longer have a step cap.
 *
 * Inside an `/ideal` run the step caps are gone (see `src/utils/ideal-run-scope.ts`):
 * the top-level tool loop, the `task` sub-agent loop and the council's
 * debate/research tool loops all run until the model stops. A cap that was the
 * only thing ending a loop still needs a replacement, and the replacement must
 * be about PROGRESS, not effort — otherwise it is the same budget under a new
 * name.
 *
 * "No progress" here is literal: a step whose every tool call is a call this loop
 * has already made, with the same arguments, that came back with the same
 * result. Such a step learned nothing and changed nothing. N of them in a row
 * and the loop is stuck — the canonical shape is re-running an unchanged build
 * that keeps failing with the same error.
 *
 *   - Any NEW (call, result) pair resets the streak. An edit between two
 *     identical builds is new, so an edit → build → edit → build cycle never
 *     trips it, however long it runs.
 *   - A step with no tool calls resets it too (the model produced text; in a
 *     tool loop that normally ends the loop by itself).
 *   - Results are part of the key, so the same `bash` command that now prints
 *     something different is progress.
 *   - A call the executor REFUSED can never be new information: it did not run,
 *     so it returned nothing to learn from. See `carriesElidedArgsMarker` below.
 *
 * ## Why refused calls need their own rule (measured, `/ideal` run muc2joffe506)
 *
 * The keying above is structural, and that is exactly what a refused call
 * defeats. Session bf39c59e4dd1 logged 29 BLOCKED tool results in ~10 minutes
 * with a sub-agent climbing through stepIndex 207-211 — this guard was its only
 * terminator (`/ideal` removes the step cap; `stream-runner.ts:650`) and it never
 * fired, because all three key components varied on every call:
 *
 *   1. the sub-agent compactor's args placeholder embeds `${sz}`, the byte count
 *      of the arguments it replaced (`buildElidedArgsInput`) — the live
 *      calls carried 429, 1250 and 280, so `sha1(input)` differed every time;
 *   2. the tool name alternated (`git_commit`, `git_commit`, `bash`);
 *   3. the guard that refused them wrote its own escalation counter into its
 *      output (`arg-guard.ts`: "N malformed tool calls in a row"), so
 *      `sha1(resultText)` differed on every strike, without limit. That one is
 *      now fixed at its source: the ladder's top rung carries no strike digits,
 *      so a refused call's text is stable from strike 3 on. It mattered most for
 *      the guard's OTHER class (`missing-required-args`), which is keyed here
 *      normally — for a verbatim repeat its tool name and `sha1(input)` are equal
 *      by construction, so the counter was the sole reason it looked novel, and
 *      the rule below could never reach it. It can now, at strike 9
 *      (`no-progress-keyless-args.test.ts`; measured unbounded to 36 before).
 *
 * Three semantically identical, identically un-runnable calls therefore looked
 * like three discoveries. Narrowing any ONE of the three (dropping `${sz}`, say)
 * leaves the other two, so the rule is stated where it is decidable: a call whose
 * arguments carry the compaction marker was refused before `execute`, for every
 * tool, so it contributes no key at all. It cannot reset the streak, and a step
 * made only of such calls counts as a repeat step.
 *
 * Deliberately NOT suppressed: a step that ALSO makes a genuinely new call. The
 * measured recovery pattern (2026-09-09) is that most blocks are repaired on the
 * very next call, and a run that is getting somewhere alongside a malformed call
 * must not be killed.
 *
 * The one call this could misjudge is an UNGUARDED tool (an MCP tool — the arg
 * guard is installed over the builtins only) that carried the marker and ran
 * anyway. Such a call is the same pathology with a different executor, and the
 * cost of being wrong is bounded the safe way: the loop ends after N such steps
 * instead of never, and any real work in the same step still resets the streak.
 */

import { createHash } from "node:crypto";
import { carriesElidedArgsMarker } from "./subagent-compactor.js";

/** Consecutive repeat-only steps before a loop is declared stuck. */
export const DEFAULT_NO_PROGRESS_STEPS = 6;

/** `MUONROI_NO_PROGRESS_STEPS` (integer >= 2) overrides the default. */
export function getNoProgressStepLimit(): number {
  const raw = process.env.MUONROI_NO_PROGRESS_STEPS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 2) return Math.floor(n);
    console.error(
      `[no-progress-guard] ignoring MUONROI_NO_PROGRESS_STEPS=${JSON.stringify(raw)} (needs an integer >= 2); using ${DEFAULT_NO_PROGRESS_STEPS}`,
    );
  }
  return DEFAULT_NO_PROGRESS_STEPS;
}

interface StepLike {
  toolCalls?: ReadonlyArray<{ toolCallId?: string; toolName?: string; input?: unknown; args?: unknown }>;
  toolResults?: ReadonlyArray<{ toolCallId?: string; toolName?: string; output?: unknown; result?: unknown }>;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** JSON with sorted object keys, so `{a,b}` and `{b,a}` are the same call. */
function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
      }
      return v;
    });
  } catch (err) {
    // A cyclic or otherwise unserialisable input cannot be compared structurally.
    // Treat it as unique (never a repeat) so a serialisation quirk can never stop
    // a loop that may be making progress.
    console.error(
      `[no-progress-guard] could not serialise tool input; treating the call as new: ${(err as Error)?.message}`,
    );
    return `unserialisable:${Math.random()}`;
  }
}

function resultText(result: { output?: unknown; result?: unknown } | undefined): string {
  if (!result) return "<no result>";
  const out = result.output ?? result.result;
  if (typeof out === "string") return out;
  return stableJson(out);
}

/**
 * Build a stateful predicate over the AI SDK's growing `steps` array. Only steps
 * added since the previous call are examined, so calling it on every stopWhen
 * invocation is O(new steps).
 */
export function createNoProgressGuard(
  limit: number = getNoProgressStepLimit(),
): (steps: ReadonlyArray<unknown>) => boolean {
  const seen = new Set<string>();
  let processed = 0;
  let streak = 0;
  return (steps) => {
    for (; processed < steps.length; processed++) {
      const step = steps[processed] as StepLike | undefined;
      const calls = step?.toolCalls ?? [];
      if (calls.length === 0) {
        streak = 0;
        continue;
      }
      const results = step?.toolResults ?? [];
      let allRepeats = true;
      calls.forEach((call, index) => {
        const input = call.input !== undefined ? call.input : call.args;
        // Refused before `execute` by the arg guard, for every tool: it ran
        // nothing, so it learned nothing and cannot count as novel. Skipping it
        // rather than keying it is what makes the decision independent of the
        // marker's `${sz}` digits, of which tool the model aimed it at, and of
        // the guard's own strike counter — all three varied live.
        if (carriesElidedArgsMarker(input)) return;
        const result =
          results.find((r) => r.toolCallId !== undefined && r.toolCallId === call.toolCallId) ?? results[index];
        const key = `${call.toolName ?? "?"}\x00${sha1(stableJson(input))}\x00${sha1(resultText(result))}`;
        if (!seen.has(key)) {
          seen.add(key);
          allRepeats = false;
        }
      });
      streak = allRepeats ? streak + 1 : 0;
    }
    return streak >= limit;
  };
}

/** `stopWhen`-shaped wrapper for `streamText`. */
export function createNoProgressStopWhen(
  limit: number = getNoProgressStepLimit(),
): (state: { steps: ReadonlyArray<unknown> }) => boolean {
  const guard = createNoProgressGuard(limit);
  return (state) => guard(state.steps);
}
