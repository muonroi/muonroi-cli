/**
 * src/state/council-steer.ts
 *
 * Design S5 — the steering buffer for a LIVE debate.
 *
 * The contract the design states most emphatically, and the reason this is a
 * buffer rather than an interrupt: **steering never cuts a turn short**. An
 * in-flight council `generateText` runs 20–60s and killing it wastes the spend
 * that was already incurred, so an instruction typed at second 12 is held and
 * folded into the leader's NEXT round directive. Nothing is discarded and
 * nothing is re-run.
 *
 * Keyed by run id and process-local by design: the TUI and the debate generator
 * live in the same process, so this needs no transport. A run that never had
 * anything pushed touches no memory at all.
 */

import { logger } from "../utils/logger.js";

/** Max characters of a single steering instruction folded into a directive. */
const MAX_STEER_CHARS = 600;
/** Max queued instructions per run — a runaway pusher cannot grow this forever. */
const MAX_QUEUED = 8;

interface RunInbox {
  instructions: string[];
  /** Set when the user asked to stop after the current round and synthesize. */
  converge: boolean;
}

const inboxes = new Map<string, RunInbox>();

/**
 * The debate currently accepting steering.
 *
 * The UI cannot reliably derive this key on its own: `/council` runs with
 * `runId = sessionId`, but the `/ideal` loop-driver passes its own run id, so a
 * UI that guessed "sessionId" would post into an inbox nobody drains — steering
 * that silently does nothing. The debate loop registers itself here instead, and
 * the UI just asks who is listening.
 */
let activeRunId: string | undefined;

export function setActiveCouncilRun(runId: string | undefined): void {
  activeRunId = runId;
}

/** The live debate's run id, or undefined when no debate is accepting steering. */
export function getActiveCouncilRun(): string | undefined {
  return activeRunId;
}

function inboxFor(runId: string, create: boolean): RunInbox | undefined {
  let box = inboxes.get(runId);
  if (!box && create) {
    box = { instructions: [], converge: false };
    inboxes.set(runId, box);
  }
  return box;
}

/**
 * Queue an instruction for the leader's next round directive.
 *
 * Over-long text is truncated rather than rejected: a user who pasted three
 * paragraphs meant the first sentence, and silently dropping the whole thing
 * would leave them believing the council was steered when it was not.
 */
export function pushCouncilSteer(runId: string | undefined, text: string): boolean {
  if (!runId) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const box = inboxFor(runId, true)!;
  if (box.instructions.length >= MAX_QUEUED) {
    logger.error("orchestrator", "council steer inbox full — instruction dropped", {
      runId,
      queued: box.instructions.length,
    });
    return false;
  }
  box.instructions.push(trimmed.length > MAX_STEER_CHARS ? `${trimmed.slice(0, MAX_STEER_CHARS - 1)}…` : trimmed);
  return true;
}

/** Ask the debate to stop after the current round and go to synthesis. */
export function requestCouncilConverge(runId: string | undefined): boolean {
  if (!runId) return false;
  inboxFor(runId, true)!.converge = true;
  return true;
}

/** What the UI shows next to the composer: is anything waiting to apply? */
export function peekCouncilSteer(runId: string | undefined): { pending: number; converge: boolean } {
  const box = runId ? inboxes.get(runId) : undefined;
  return { pending: box?.instructions.length ?? 0, converge: box?.converge ?? false };
}

/**
 * Take every queued instruction. Draining CLEARS them, so a directive applies an
 * instruction exactly once — re-applying it every round would let one nudge
 * dominate the rest of the debate.
 *
 * `converge` is deliberately NOT cleared here: it is a run-level decision that
 * the loop reads at its own exit check, and clearing it on a directive drain
 * would lose it whenever both arrive together.
 */
export function drainCouncilSteer(runId: string | undefined): string[] {
  const box = runId ? inboxes.get(runId) : undefined;
  if (!box || box.instructions.length === 0) return [];
  const out = box.instructions;
  box.instructions = [];
  return out;
}

/** True when the user asked to converge. Read at the round-exit check. */
export function shouldCouncilConverge(runId: string | undefined): boolean {
  return runId ? (inboxes.get(runId)?.converge ?? false) : false;
}

/** Drop a run's inbox. Called when a debate ends so a re-run starts clean. */
export function clearCouncilSteer(runId: string | undefined): void {
  if (runId) inboxes.delete(runId);
  if (runId && activeRunId === runId) activeRunId = undefined;
}

/**
 * Render queued instructions as the block prepended to a leader directive.
 * Empty input → empty string, so the caller can concatenate unconditionally.
 */
export function formatSteerBlock(instructions: readonly string[]): string {
  if (instructions.length === 0) return "";
  const body = instructions.map((s) => `- ${s}`).join("\n");
  return `USER STEERING (applies to this round, from the human running this debate):\n${body}`;
}
