/**
 * F8 — the undebated-criteria gate.
 *
 * ## The defect this closes
 *
 * Run `mttwpmu8ee5b` (sessions 18cd54cdb9c9 / c712c4cb6908 / 9d9f363c14fa):
 *
 *   09:54:12  council_message (leader verdict)
 *             "Debate ended with 2 of 5 criteria still unmet: … Bộ analyzer có
 *              thể được đóng gói thành NuGet package… Synthesis notes these as
 *              open — re-run with an extended round budget or a narrower scope."
 *   09:54:35  phase_start {"phase":"scoping"}      ← 23 seconds later
 *
 * The leader's round-2 verdict had said it in plain words —
 * *"chưa có thảo luận nào về đóng gói NuGet"* (no panelist discussed the NuGet
 * packaging criterion at all) — and the loop walked past it. Sprint 2 was then
 * scheduled with the goal "Package all formatting analyzers into installable
 * TCIS.CodeStandards.Analyzers NuGet": a sprint built on the exact criterion the
 * council had just declared undebated.
 *
 * The leader has authority INSIDE `runDebate` and none outside it. This module
 * is the outside-it half: when the debate finally ends with a pinned criterion
 * that received **zero engagement**, the loop stops and puts it on the table
 * before scoping turns it into a sprint goal.
 *
 * ## "Zero engagement" is not "unmet"
 *
 * A criterion argued over and left unresolved is a normal debate outcome and
 * must NOT trigger this gate — that is what the leader's closing verdict and the
 * B4 escalation already handle. The gate fires only on a criterion **no panelist
 * addressed at all**.
 *
 * That distinction is not a heuristic invented here. It is already carried,
 * per-panelist, by `DebateState.finalStanceRows` (`CouncilStanceRow.stances`),
 * where `null` means "has NOT spoken to this criterion". The leader prompt that
 * produces it (`buildLeaderEvaluationPrompt`, src/council/prompts.ts:641) says
 * verbatim: *"Do NOT infer agreement from silence — a panelist who never
 * addressed a criterion is null, never '+'"*, and `buildStanceRows`
 * (src/council/stance.ts) degrades every uncertain input to `null` rather than
 * to a mark. So an all-`null` row is the council's own recorded statement that
 * nobody argued the criterion.
 *
 * The gate deliberately requires the stance map to be NON-EMPTY. A row with no
 * panelist keys at all is missing data (no roster was passed to the leader), not
 * evidence of silence — firing on it would turn "we don't know" into "nobody
 * spoke", which is the same fabrication the stance module exists to prevent.
 *
 * ## It does not extend rounds
 *
 * By construction this runs after the debate has FINALLY ended, i.e. after any
 * leader-requested round extension has already been spent. It never asks for
 * another round; the choices it offers are about what the RUN does next.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { QuestionResponder } from "../council/types.js";
import { atomicWriteJSON } from "../storage/atomic-io.js";
import type { CouncilStanceRow, StreamChunk } from "../types/index.js";
import { logger } from "../utils/logger.js";

/** A pinned criterion that ended the debate with no panelist having argued it. */
export interface UndebatedCriterion {
  /** Position in `spec.successCriteria` — used to drop it on "narrow". */
  index: number;
  criterion: string;
}

/**
 * What the human (or the unattended default) decided.
 *
 * - `council` — stop the run before scoping; the criteria go back to a council.
 * - `narrow`  — drop them from the spec and continue, so no sprint is planned
 *               around a goal the council never examined.
 * - `accept`  — continue unchanged, with the criteria recorded as undebated.
 */
export type UndebatedGateAction = "council" | "narrow" | "accept";

export interface UndebatedGateDecision {
  action: UndebatedGateAction;
  /** True when no answer ever arrived and the unattended default was applied. */
  unattended: boolean;
  /** Raw answer string received, for the forensics row. Empty on timeout. */
  answer: string;
}

export const UNDEBATED_OPTION_COUNCIL = "undebated_council";
export const UNDEBATED_OPTION_NARROW = "undebated_narrow";
export const UNDEBATED_OPTION_ACCEPT = "undebated_accept";

/**
 * The option the card RECOMMENDS to a human who is present — i.e. what
 * `defaultIndex` points at, what Enter-on-open selects, and what headless
 * `--yes` picks (`src/headless/council-answers.ts:108`).
 *
 * This is deliberately NOT the same answer as the unattended default, which is
 * `council` (see `runUndebatedCriteriaGate`). Measured in session
 * `2bd02af6e46f` / run `mtwjytbg20f2`: the card recommended the halt, the user
 * took the recommendation, and the run ended — *"đá tôi ra màn hình chat"*.
 *
 * `council` is the wrong thing to recommend to someone who is there, because it
 * is the one option with no forward path in the product:
 *   - the gate does not convene a council, it stops the run (by design);
 *   - `enforceUndebatedCriteriaGate` PERSISTS and later HONOURS that answer, so
 *     `/ideal resume` stops instantly and never even re-shows this card;
 *   - `/council` is a separate command whose conclusion is not written back to
 *     this run's stance record, so it cannot clear the gate either.
 *
 * `narrow` is recommended instead because it is the only answer that keeps the
 * gate's whole guarantee — no sprint is planned around a goal nobody examined —
 * while letting the run move. `accept` is the measured defect and must never be
 * the recommendation; the halt stays available, and stays the answer for every
 * unclear input.
 */
export const UNDEBATED_RECOMMENDED_OPTION = UNDEBATED_OPTION_NARROW;

/**
 * How long the gate waits for a human before applying the unattended default.
 * Generous on purpose: `/ideal` legitimately sits on approve cards for many
 * minutes (CLAUDE.md records a 17-minute wait that was NOT a hang), so a short
 * deadline would fire the unattended path on an attended run.
 *
 * `MUONROI_UNDEBATED_GATE_TIMEOUT_MS=0` makes the gate resolve immediately —
 * the setting for CI, where nobody will ever answer and the 10-minute stall is
 * pure waste.
 */
export const UNDEBATED_GATE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveUndebatedGateTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return UNDEBATED_GATE_DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : UNDEBATED_GATE_DEFAULT_TIMEOUT_MS;
}

/**
 * Find pinned criteria that ended the debate with every panelist silent.
 *
 * Conditions, all required:
 *   1. the leader graded the row as NOT met — a met criterion is not a blind
 *      sprint goal, and this gate is scoped to the observed defect;
 *   2. the stance map has at least one panelist key — otherwise it is missing
 *      data, not silence (see the module header);
 *   3. every panelist's mark is `null` — nobody argued it, for or against.
 *
 * A criterion with even ONE "+", "-" or "~" was engaged and never fires the
 * gate, however unresolved it is.
 *
 * `finalStanceRows` is index-aligned to `spec.successCriteria` by
 * `buildStanceRows` (one row per pinned criterion, in order), so the row index
 * is the criterion index. When the rows are absent entirely the answer is `[]`:
 * a debate that produced no stance data cannot be said to have ignored anything.
 */
export function findUndebatedCriteria(rows: readonly CouncilStanceRow[] | undefined): UndebatedCriterion[] {
  if (!rows || rows.length === 0) return [];
  const out: UndebatedCriterion[] = [];
  rows.forEach((row, index) => {
    if (!row || row.met === true) return;
    const marks = Object.values(row.stances ?? {});
    if (marks.length === 0) return; // missing roster — unknown, not silence
    if (marks.some((m) => m !== null)) return; // someone spoke
    out.push({ index, criterion: row.criterion });
  });
  return out;
}

/** One-line label for the headline; the full text always ships in `context`. */
function shortLabel(c: string, max = 72): string {
  const t = c.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Build the card.
 *
 * Every string here is BEHAVIOUR, not decoration. The first option used to read
 * "Take it back to the council" / "re-run the council pointed at these
 * criteria", which names an action the system does not perform: it halts, and
 * nothing re-runs. A label that describes a different system than the one
 * running is the whole of the measured defect, so each option now says what
 * happens when it is picked and, where the answer is "the run ends", which
 * command actually moves it forward.
 *
 * On `convene_council`: the tool DOES exist on develop (registered in
 * `src/tools/registry.ts` when `councilConfigured`), so the earlier belief that
 * it was unmerged is wrong. It still cannot be promised here — it is a tool the
 * MODEL calls inside a chat turn, it is not reachable from this generator, and
 * its conclusion is not written back to this run's `undebated-criteria.json`,
 * so it would not clear the gate. The `undebated_council` VALUE is kept exactly
 * so that a future wiring (gate → convene_council → new stance rows) is a
 * behaviour change here and not a re-plumb of every persisted forensics row.
 */
export function buildUndebatedQuestion(undebated: readonly UndebatedCriterion[]): {
  content: string;
  question: string;
  context: string;
  options: Array<{ label: string; description: string; value: string; kind: "choice" }>;
  /** Index of `UNDEBATED_RECOMMENDED_OPTION` — what Enter and `--yes` select. */
  defaultIndex: number;
} {
  const n = undebated.length;
  const noun = `${n} pinned criteri${n === 1 ? "on" : "a"}`;
  const them = n === 1 ? "it" : "them";
  // The criteria text itself, never a bare count: "2 of 5 unmet" is what the
  // old closing message said, and it is precisely why nobody acted on it.
  const list = undebated.map((u) => `${u.index + 1}. ${u.criterion}`).join("\n");
  const options: Array<{ label: string; description: string; value: string; kind: "choice" }> = [
    {
      label: "Stop the run before scoping",
      description:
        `Ends this run — nothing is scheduled, and no council is convened: this stops the run, it does not start one. ` +
        `To get ${them} argued, run /council yourself and then start a fresh /ideal. ` +
        `This answer is recorded against the run, so /ideal resume stops here again instead of continuing.`,
      value: UNDEBATED_OPTION_COUNCIL,
      kind: "choice",
    },
    {
      label: "Drop them from the scope",
      // No "the original spec is kept" promise here: loop-driver.ts:1022 says
      // debate-inputs.json keeps it, but loop-driver.ts:1243 deletes that file
      // once scoping completes, so the claim is false by the time it matters.
      description: `Recommended — scoping continues with ${them} removed, so no sprint is planned around an undebated goal.`,
      value: UNDEBATED_OPTION_NARROW,
      kind: "choice",
    },
    {
      label: "Accept and proceed",
      description:
        `Continue with ${them} recorded as undebated and still open — sprints may then be planned around ${them}. ` +
        `That is the outcome this gate exists to catch.`,
      value: UNDEBATED_OPTION_ACCEPT,
      kind: "choice",
    },
  ];
  // Derived, never a literal: the recommendation is declared once, above.
  const defaultIndex = Math.max(
    0,
    options.findIndex((o) => o.value === UNDEBATED_RECOMMENDED_OPTION),
  );
  return {
    content:
      `**The debate ended without anyone arguing ${noun}.**\n` +
      `> Nobody spoke to: ${undebated.map((u) => shortLabel(u.criterion)).join("; ")}`,
    question:
      `No panelist took a position — for or against — on ${noun} the council was asked to settle. ` +
      `Scoping would plan sprints against ${them} anyway. How do you want to proceed?`,
    context: `Criteria nobody argued:\n${list}`,
    options,
    defaultIndex,
  };
}

/**
 * Emit the gate askcard and resolve the decision.
 *
 * Yields a `council_question` chunk — the SAME surface the clarifier, preflight
 * and post-debate cards use, which the TUI turns into an `askcard-open` LiveEvent
 * (src/ui/use-app-logic.tsx:4173). That matters: a DB poller cannot distinguish
 * "waiting for a human" from "hung", because a modal pause writes no
 * `interaction_logs` row, so the pause MUST be visible on the event stream.
 *
 * ## Unattended runs — a SEPARATE question from what to recommend
 *
 * These were one decision and had to stop being one. The unattended default is
 * "what happens when nobody is there"; the recommendation (`defaultIndex`, see
 * `UNDEBATED_RECOMMENDED_OPTION`) is "what to suggest to someone who is". They
 * are answered differently and for different reasons.
 *
 * A run with nobody watching must not block forever, and both available defaults
 * are dangerous in opposite directions:
 *
 *   - **auto-accept**: silently reproduces the exact defect the gate exists to
 *     stop, for every unattended run — the gate becomes decorative precisely
 *     where no human is present to catch the blind sprint.
 *   - **auto-halt**: an unattended run dies at a point a human would probably
 *     have waved through, losing the forward progress of the whole debate.
 *
 * The unattended default stays **halt** (`action: "council"`), for three reasons:
 *   1. Proceeding is the measured bug. A default that re-runs the bug wherever
 *      nobody is looking is not a gate.
 *   2. A halt is cheap and recoverable *on this path specifically*: an
 *      unattended timeout writes NO resolution (see `enforceUndebatedCriteriaGate`),
 *      so `/ideal resume` re-asks the question properly the next time a human is
 *      present. One resume, versus a whole sprint spent implementing a goal the
 *      council never examined (measured: sprint 2, "Package all formatting
 *      analyzers into … NuGet").
 *   3. A wrong halt is loud and gets fixed; a wrong accept is silent and shipped.
 *
 * Corrections to what reason 2 used to claim, both checked against develop:
 *   - the command is **`/ideal resume [runId]`** (`src/ui/slash/ideal.ts:87`).
 *     `/ideal --resume <path>` is a different feature — the BB scaffold
 *     gate-failure handler in `src/scaffold/resume-from-gate-failures.ts`.
 *   - `run-finished{outcome:"halted"}` is real (`outcomeFromResult` maps
 *     `stage:"halted"`, `src/product-loop/index.ts:226`) but it is an
 *     **agent-mode LiveEvent only** — `emitRunFinished` no-ops without
 *     `__muonroiAgentRuntime`, and it is never written to `interaction_logs`.
 *     It is what a harness observer sees; it is NOT what tells the human
 *     anything. Only the content lines below do that, which is why they carry
 *     the next step.
 *   - an ATTENDED halt is the opposite of recoverable-by-resume: it IS
 *     persisted, and a later resume honours it and stops again without
 *     re-asking. Recommending it (as the card used to) pointed the user at the
 *     only option with no forward path.
 *
 * The fail-safe polarity is unchanged, and is independent of the
 * recommendation: only the two explicit proceed values (`undebated_narrow`,
 * `undebated_accept`) proceed. An Escape (`COUNCIL_ANSWER_DISMISSED` — the
 * repo's convention for "take NO action", src/council/index.ts:2138), an empty
 * submit, and any value the UI drifts to all resolve to `council`. Moving
 * `defaultIndex` changes which option is pre-selected, not what an unclear
 * answer means: permission to build sprints on an undebated goal must still be
 * given by name.
 */
export async function* runUndebatedCriteriaGate(opts: {
  undebated: readonly UndebatedCriterion[];
  respondToQuestion: QuestionResponder;
  /** Deadline before the unattended default applies. 0 = do not wait at all. */
  timeoutMs: number;
}): AsyncGenerator<StreamChunk, UndebatedGateDecision, unknown> {
  const { undebated, respondToQuestion, timeoutMs } = opts;
  const card = buildUndebatedQuestion(undebated);
  const questionId = randomUUID();

  yield {
    type: "council_question",
    content: card.content,
    councilQuestion: {
      questionId,
      // Reuse the post-debate phase: same askcard renderer, no second modal path.
      phase: "post-debate" as const,
      question: card.question,
      context: card.context,
      isRequired: false,
      options: card.options,
      defaultIndex: card.defaultIndex,
    },
  } as StreamChunk;

  const answer = await awaitAnswer(respondToQuestion, questionId, timeoutMs);

  if (answer === null) {
    // Unattended. Nothing is persisted for a timeout, so — unlike the attended
    // halt below — the question is still genuinely open and the next resume
    // asks it. Say that, or the two identical-looking stops teach the user that
    // resume never works.
    yield {
      type: "content",
      content:
        `\n  ↳ No answer within ${Math.round(timeoutMs / 1000)}s — run stopped before scoping rather than ` +
        `planning sprints against ${undebated.length === 1 ? "a criterion" : "criteria"} the council never argued.\n` +
        `     Nobody answered, so nothing was recorded: /ideal resume will ask this again.\n`,
    } as StreamChunk;
    return { action: "council", unattended: true, answer: "" };
  }

  // U1 — a real (non-timeout) answer was received: consume the card-answered
  // flag exactly ONCE here and reuse it for every branch below. Only the
  // interactive UI card ever sets it (see `QuestionResponder.wasAnsweredByCard`,
  // council/types.ts); headless never does, so its echo — its only record of
  // the answer — is unaffected. This card reuses `phase: "post-debate"` to ride
  // the same UI renderer as the post-debate card, so it is subject to the same
  // duplicate-echo defect (project_askcard_transcript_qa_pairing) once the UI
  // renders its own paired record.
  const answeredByCard = respondToQuestion.wasAnsweredByCard?.(questionId) ?? false;

  if (answer === UNDEBATED_OPTION_NARROW) {
    if (!answeredByCard) {
      yield {
        type: "content",
        content: `\n  ↳ Dropped ${undebated.length} undebated criteri${undebated.length === 1 ? "on" : "a"} from the scope — scoping continues without ${undebated.length === 1 ? "it" : "them"}.\n`,
      } as StreamChunk;
    }
    return { action: "narrow", unattended: false, answer };
  }
  if (answer === UNDEBATED_OPTION_ACCEPT) {
    if (!answeredByCard) {
      yield {
        type: "content",
        content: `\n  ↳ Proceeding with ${undebated.length} undebated criteri${undebated.length === 1 ? "on" : "a"} still open.\n`,
      } as StreamChunk;
    }
    return { action: "accept", unattended: false, answer };
  }
  // Everything else — the explicit stop, an Escape (COUNCIL_ANSWER_DISMISSED),
  // an empty submit, or a value the UI drifted to — stops. See the polarity
  // note above: proceeding must be asked for by name.
  //
  // The line this replaces read "take the undebated criteria back to a council":
  // an instruction to the human, phrased as if the system had done something.
  // It had not. It stopped, and the user was returned to the chat prompt with
  // no idea what to do next (session 2bd02af6e46f). Report the stop, then name
  // the command — including the one that will NOT work, since a recorded answer
  // makes `/ideal resume` stop here again without re-asking.
  if (!answeredByCard) {
    yield {
      type: "content",
      content:
        `\n  ↳ Run stopped before scoping. Nothing was scheduled, and no council was convened — ` +
        `this stops the run, it does not start one.\n` +
        `     Next: run /council on ${undebated.length === 1 ? "the criterion" : "the criteria"} above to get ` +
        `${undebated.length === 1 ? "it" : "them"} argued, then start a fresh /ideal.\n` +
        `     This answer is recorded against the run, so /ideal resume stops here again rather than continuing.\n`,
    } as StreamChunk;
  }
  return { action: "council", unattended: false, answer };
}

/**
 * Await the responder, bounded. Returns the trimmed answer, or `null` when no
 * answer arrived before the deadline (or the responder threw).
 *
 * The pending responder promise is left dangling on timeout — there is no cancel
 * channel on `QuestionResponder`, and the run is halting anyway.
 */
async function awaitAnswer(
  respondToQuestion: QuestionResponder,
  questionId: string,
  timeoutMs: number,
): Promise<string | null> {
  if (timeoutMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("undebated-gate-timeout");
  try {
    const answered = respondToQuestion(questionId).then((a) => (a ?? "").trim());
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const winner = await Promise.race([answered, expired]);
    if (winner === TIMED_OUT) {
      // U1 — the responder promise is left dangling (no cancel channel) and
      // may still resolve LATE, via the UI card, after this generator has
      // already returned and no branch above ever reads `wasAnsweredByCard`.
      // Drain it whenever it does so the flag never lingers in
      // CouncilManager's `_cardAnsweredQuestionIds` set. `.catch` also gives
      // the otherwise-unobserved `answered` promise a rejection handler.
      void answered
        .then(() => {
          respondToQuestion.wasAnsweredByCard?.(questionId);
        })
        .catch((err) => {
          // Debug only, not error: the generator has already returned its
          // unattended-timeout decision, so there is nothing left to recover
          // or retry here — this handler exists solely to observe a late
          // rejection, not to react to one (No Silent Catch: still logged,
          // never swallowed bare).
          logger.debug("orchestrator", "[undebated-criteria-gate] late responder rejection after timeout", {
            questionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return null;
    }
    return winner;
  } catch (err) {
    // A broken responder channel must not crash or hang the run — but it must
    // never be silent either, or a dead UI channel looks identical to a user
    // who deliberately chose to stop (No Silent Catch).
    logger.error("orchestrator", "[undebated-gate] question responder failed — applying unattended default", {
      questionId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── F8b — the record that survives the process ──────────────────────────────
//
// The gate above only ever ran on the research→scoping transition, reading
// `DebateState.finalStanceRows` out of RAM. Measured 2026-09-10: two
// `/ideal resume <runId>` runs went straight into sprint stages
//
//   02:38:04  sprint_stage {sprintIndex:1, stage:"planning"}
//   02:38:04  sprint_stage {sprintIndex:1, stage:"implementation"}
//
// with zero `phase_start` and zero `council_message` rows — the transition the
// gate guards never happened, so the gate could not fire on the path that
// actually schedules sprints. And the defect it exists to stop is precisely a
// RESUME defect: a resume re-enters the same sprint plan whose sprint 2 goal was
// "Package all formatting analyzers into installable TCIS.CodeStandards.Analyzers
// NuGet" — the criterion nobody argued.
//
// The stance rows were NOT persisted anywhere: `debate-checkpoint.json` is
// mid-debate state and is deleted on normal completion, `debate-inputs.json`
// holds the pre-debate spec, and the `council_summary` forensics row records
// participant positions, not stances. This section closes that gap by writing
// the SAME record to disk — not a second source of truth derived from something
// else. A run that finished its debate before this landed has no record, and the
// gate correctly reports "no evidence" rather than inventing silence.

/** Bump when the record shape changes incompatibly so stale files are ignored. */
export const UNDEBATED_RECORD_VERSION = 1 as const;
export const UNDEBATED_RECORD_FILE = "undebated-criteria.json";

/** A decision a human actually made, pinned to the criteria it was made about. */
export interface UndebatedGateResolution {
  action: UndebatedGateAction;
  /**
   * The criteria the human was shown. A later debate producing a DIFFERENT set
   * is a different question and must be asked again.
   */
  criteria: UndebatedCriterion[];
  /** Raw answer value, for forensics. */
  answer: string;
  decidedAt: string;
}

export interface UndebatedGateRecord {
  version: typeof UNDEBATED_RECORD_VERSION;
  /** The council's own final stance rows, verbatim — the gate's only evidence. */
  stanceRows: CouncilStanceRow[];
  savedAt: string;
  /**
   * Present only once a HUMAN answered. An unattended timeout deliberately
   * writes nothing: nobody answered, so there is no answer to honour, and
   * persisting the timeout's halt would make an unattended run unresumable.
   */
  resolution?: UndebatedGateResolution;
}

function recordPath(runDir: string): string {
  return path.join(runDir, UNDEBATED_RECORD_FILE);
}

/**
 * Read the record. Absent / unparseable / stale-version all return null: a
 * missing record is missing evidence, and the gate must never manufacture
 * silence out of it (the same rule as an empty stance map).
 */
export async function readUndebatedGateRecord(runDir: string): Promise<UndebatedGateRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(recordPath(runDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.error("orchestrator", "[undebated-gate] record read failed", {
        runDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as UndebatedGateRecord;
    if (parsed?.version !== UNDEBATED_RECORD_VERSION) return null;
    if (!Array.isArray(parsed.stanceRows)) return null;
    return parsed;
  } catch (err) {
    logger.error("orchestrator", "[undebated-gate] record parse failed", {
      runDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Persist the debate's final stance rows against the run, preserving any answer
 * a human already gave. Called on the live path the moment the debate returns —
 * whether or not the gate fires, so a resume can tell "the panel argued
 * everything" apart from "no evidence was ever recorded".
 *
 * Non-fatal: a write failure forfeits gate coverage on a later resume; it must
 * never break the run in front of the user. Logged, never swallowed.
 */
export async function writeUndebatedStanceRecord(
  runDir: string,
  stanceRows: readonly CouncilStanceRow[],
  resolution?: UndebatedGateResolution,
): Promise<void> {
  const record: UndebatedGateRecord = {
    version: UNDEBATED_RECORD_VERSION,
    stanceRows: [...stanceRows],
    savedAt: new Date().toISOString(),
    ...(resolution ? { resolution } : {}),
  };
  try {
    await fs.mkdir(runDir, { recursive: true });
    await atomicWriteJSON(recordPath(runDir), record);
  } catch (err) {
    logger.error("orchestrator", "[undebated-gate] stance record write failed — a later resume loses gate coverage", {
      runDir,
      rows: stanceRows.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Attach a human's answer to the existing record. No-ops (loudly) when there is
 * no record to attach to — writing one here would fabricate stance evidence.
 */
export async function recordUndebatedResolution(runDir: string, resolution: UndebatedGateResolution): Promise<void> {
  const existing = await readUndebatedGateRecord(runDir);
  if (!existing) {
    logger.error("orchestrator", "[undebated-gate] no stance record to attach the answer to — a resume will re-ask", {
      runDir,
      action: resolution.action,
    });
    return;
  }
  await writeUndebatedStanceRecord(runDir, existing.stanceRows, resolution);
}

/** Same question? Compared on criterion TEXT — indices shift when a spec is narrowed. */
function sameCriteria(a: readonly UndebatedCriterion[], b: readonly UndebatedCriterion[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: readonly UndebatedCriterion[]) => xs.map((x) => x.criterion.trim()).sort();
  const x = norm(a);
  const y = norm(b);
  return x.every((v, i) => v === y[i]);
}

/** Why the gate reached its answer — carried into the audit row, never guessed. */
export type UndebatedGateSource =
  /** No stance record on disk and none supplied: nothing to judge. */
  | "no-record"
  /** Stance evidence exists and every pinned criterion was engaged. */
  | "all-argued"
  /** A human already answered this exact question for this run. */
  | "honoured"
  /** The card was shown and resolved in this call. */
  | "asked";

export interface UndebatedGateOutcome {
  /** False only when the decision is "take it back to the council". */
  proceed: boolean;
  source: UndebatedGateSource;
  action?: UndebatedGateAction;
  undebated: UndebatedCriterion[];
  unattended?: boolean;
}

/**
 * The single entry every path that schedules or resumes sprint work goes
 * through.
 *
 * The live path (`loop-driver`, research→scoping) passes `stanceRows`, and the
 * rows get persisted here. The resume path (`runResume`, immediately before
 * sprint entry) passes none and reads the persisted rows — the same evidence,
 * off disk.
 *
 * Honouring a prior answer is not an optimisation, it is a correctness rule:
 * re-asking a question the human already settled trains people to click through
 * it, which is how a gate becomes decorative. Only a HUMAN answer is persisted,
 * so an unattended timeout leaves the question genuinely open and the next
 * (probably attended) resume asks it properly.
 *
 * A prior `council` answer keeps stopping the run. That is the answer being
 * honoured, not a bug: "take it back to the council" means the plan standing on
 * that criterion is not to be executed, and a resume is exactly an attempt to
 * execute it. The remedy is to run the council again.
 */
export async function* enforceUndebatedCriteriaGate(opts: {
  /** `.muonroi-flow/runs/<runId>` — where the record lives. */
  runDir: string;
  respondToQuestion: QuestionResponder;
  /** Supplied by the live path, which holds the rows in memory. */
  stanceRows?: readonly CouncilStanceRow[] | undefined;
  timeoutMs?: number;
  /** Forensics sink (`logLoopEvent` / `logInteraction`). Must not throw. */
  audit?: (data: Record<string, unknown>) => void;
}): AsyncGenerator<StreamChunk, UndebatedGateOutcome, unknown> {
  const audit = opts.audit ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? resolveUndebatedGateTimeoutMs();

  const existing = await readUndebatedGateRecord(opts.runDir);
  if (opts.stanceRows) {
    // Persist BEFORE evaluating, so the evidence survives even when the gate
    // does not fire and even if the user kills the run at the card.
    await writeUndebatedStanceRecord(opts.runDir, opts.stanceRows, existing?.resolution);
  }
  const rows = opts.stanceRows ?? existing?.stanceRows;
  const undebated = findUndebatedCriteria(rows);

  if (undebated.length === 0) {
    const source: UndebatedGateSource = rows && rows.length > 0 ? "all-argued" : "no-record";
    audit({ stage: "gate-skipped", source });
    return { proceed: true, source, undebated: [] };
  }

  const prior = existing?.resolution;
  if (prior && sameCriteria(prior.criteria, undebated)) {
    audit({
      stage: "gate-honoured",
      action: prior.action,
      decidedAt: prior.decidedAt,
      count: undebated.length,
    });
    // A prior `council` answer is the one that dead-ends a resume: the run
    // stops instantly and the card is never re-shown, so without this line the
    // user sees an unexplained loop. Name the exit here too, not just on the
    // ask path they will not reach again.
    const stuck =
      prior.action === "council"
        ? `     This run stays stopped — /ideal resume keeps stopping here rather than re-asking. ` +
          `To move forward: run /council on the criteria, then start a fresh /ideal run.\n`
        : "";
    yield {
      type: "content",
      content:
        `\n  ↳ Undebated criteria: honouring the answer already given for this run ` +
        `(${prior.action}, ${prior.decidedAt}) — not asking again.\n${stuck}`,
    } as StreamChunk;
    return { proceed: prior.action !== "council", source: "honoured", action: prior.action, undebated };
  }

  audit({
    stage: "gate-open",
    count: undebated.length,
    criteria: undebated.map((u) => u.criterion.slice(0, 400)),
  });
  const decision = yield* runUndebatedCriteriaGate({
    undebated,
    respondToQuestion: opts.respondToQuestion,
    timeoutMs,
  });
  audit({
    stage: "gate-resolved",
    action: decision.action,
    unattended: decision.unattended,
    count: undebated.length,
  });
  if (!decision.unattended) {
    await recordUndebatedResolution(opts.runDir, {
      action: decision.action,
      criteria: undebated,
      answer: decision.answer,
      decidedAt: new Date().toISOString(),
    });
  }
  return {
    proceed: decision.action !== "council",
    source: "asked",
    action: decision.action,
    undebated,
    unattended: decision.unattended,
  };
}

/** Halt detail shared by every call site, so the criteria are always named. */
export function undebatedHaltDetail(undebated: readonly UndebatedCriterion[]): string {
  return (
    `the council never argued ${undebated.length} pinned criteri${undebated.length === 1 ? "on" : "a"} — ` +
    `${undebated.map((u) => u.criterion).join("; ")}`
  );
}
