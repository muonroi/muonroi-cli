import type { KeyEvent } from "@opentui/core";
import type { ScheduleDaemonStatus, StoredSchedule } from "../../tools/schedule.js";
import type { ChatEntry, CouncilQuestionData, ToolCall, ToolResult } from "../../types/index.js";
import type { CouncilCardKey } from "../components/council-question-card.js";

export function formatScheduleDetails(schedule: StoredSchedule, daemonStatus: ScheduleDaemonStatus): string {
  const daemonText = daemonStatus.running
    ? `running${daemonStatus.pid ? ` (pid ${daemonStatus.pid})` : ""}`
    : "not running";
  return [
    `Schedule: ${schedule.name}`,
    `ID: ${schedule.id}`,
    `Type: ${schedule.cron ? "recurring" : "one-time"}`,
    `Cron: ${schedule.cron ?? "runs once immediately"}`,
    `Enabled: ${schedule.enabled ? "yes" : "no"}`,
    `Model: ${schedule.model}`,
    `Directory: ${schedule.directory}`,
    `Last run: ${schedule.lastRunAt ?? "never"}`,
    `Daemon: ${daemonText}`,
    "",
    "Instruction:",
    schedule.instruction,
  ].join("\n");
}

/**
 * Render the user's AskCard answer for inclusion in the chat log.
 *
 * For choice-kind answers we used to display the bare verb ("accept",
 * "override", "skip") which makes the log meaningless when 6 cards in a row
 * resolve as "accept / accept / accept …" — the user can't tell what they
 * actually agreed to. Now we append the selected option's label when one is
 * known, so the entry becomes e.g. `accept · productType="internal-tool"` or
 * `override · "consumer-app"`.
 *
 * The `questionId` (when provided) is normalized to a short prefix so the
 * entry remains scannable, e.g. `accept · targetPlatform=["cli"]`.
 */
export function formatAnswerForLog(
  ans: { kind: string; text: string },
  ctx?: { selectedOptionLabel?: string; questionId?: string },
): string {
  if (ans.kind === "freetext") return ans.text || "(empty)";
  if (ans.kind === "chat") return "[Chat about this]";
  const verb = ans.text;
  const label = ctx?.selectedOptionLabel?.trim();
  if (!label || label === verb) return verb;
  // Single line — labels carry value + rationale tail; keep echo to the value.
  const valueOnly = label.split("—")[0].trim().replace(/\s+/g, " ");
  // Internal snake_case action ids (continue_session, save_exit, generate_plan,
  // ask_followup…) are routing tokens the user should NEVER see. When the value
  // is such an id, echo the human label alone instead of "continue_session · …".
  // Short human verbs (accept, skip, override) have no underscore and keep the
  // value-prefixed forensics form below.
  if (/_/.test(verb)) return valueOnly || verb;
  if (ctx?.questionId) {
    return `${verb} · ${ctx.questionId}=${valueOnly}`;
  }
  return `${verb} · ${valueOnly}`;
}

export function buildAssistantEntry(content: string, extra?: Partial<ChatEntry>): ChatEntry {
  return { type: "assistant", content, timestamp: new Date(), ...extra };
}

export function buildToolResultEntry(
  toolCall: ToolCall,
  toolResult: ToolResult,
  extra?: Partial<ChatEntry>,
): ChatEntry {
  const output = toolResult.output ?? (toolResult.error ? `Error: ${toolResult.error}` : "");
  return {
    type: "tool_result",
    content: typeof output === "string" ? output : String(output),
    timestamp: new Date(),
    toolCall,
    toolResult,
    ...extra,
  };
}

let toolGroupSeq = 0;

// Create a fresh active tool-group entry. Caller is expected to append items
// via setMessages mutation keyed on `toolGroup.id`, and close the group by
// setting `state` to "done" / "failed" once the assistant emits text or the
// stream ends.
export function buildToolGroupEntry(extra?: Partial<ChatEntry>): ChatEntry {
  const now = Date.now();
  const id = `tg-${now}-${++toolGroupSeq}`;
  return {
    type: "tool_group",
    content: "",
    timestamp: new Date(now),
    toolGroup: {
      id,
      state: "active",
      items: [],
      startedAt: now,
    },
    ...extra,
  };
}

export function buildUserEntry(content: string, extra?: Partial<ChatEntry>): ChatEntry {
  return { type: "user", content, timestamp: new Date(), ...extra };
}

export function buildPreflightQuestion(pf: {
  preflightId: string;
  problemStatement: string;
  participants: Array<{ role: string; model: string }>;
}): CouncilQuestionData {
  return {
    questionId: pf.preflightId,
    phase: "preflight",
    question: `Approve discussion plan for: ${pf.problemStatement}`,
    context: pf.participants.length > 0 ? `Panel: ${pf.participants.map((p) => p.model).join(", ")}` : undefined,
    options: [
      { label: "Approve", value: "approve", kind: "choice", description: "Looks good — start the debate" },
      { label: "Reject", value: "reject", kind: "choice", description: "Hold off — go back and rephrase the topic" },
    ],
    isRequired: true,
    defaultIndex: 0,
  };
}

/**
 * F5 — the council entrypoint (council/index.ts) emits `leader`+`panel`+`topic`
 * together exactly once, at the START of each debate; every later `council_meta`
 * patch is partial (a lone roundBudget / researchMode / successCriteria /
 * criteriaMet). That combination is the strongest new-council signal — stronger
 * than a topic change, which misses a re-run on the SAME topic (auto-council
 * re-firing on a phase, or a fresh /council after an Esc that skipped
 * clearLiveTurnUi) and leaks the prior council's pinned criteria into the rail as
 * stale ○ rows. The rail resets its meta+rounds on this.
 */
export function isCouncilStartPatch(patch: { leader?: string; panel?: string[] }): boolean {
  return !!patch.leader && !!patch.panel;
}

export function mapCouncilCardKey(key: KeyEvent): CouncilCardKey | null {
  if (key.name === "up") return { kind: "up" };
  if (key.name === "down") return { kind: "down" };
  if (key.name === "return") return { kind: "enter" };
  if (key.name === "escape") return { kind: "escape" };
  if (key.name === "backspace" || key.name === "delete") return { kind: "backspace" };
  // Printable single character (letters, digits, space, etc.).
  if (typeof key.sequence === "string" && key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f") {
    return { kind: "char", ch: key.sequence };
  }
  return null;
}

// ── Askcard state machine: escape-sequence tracker ───────────────────────────
// Refs on the askcard state machine — we keep them outside React state so the
// consecutive-press counter and inter-press timer update synchronously without
// a React commit round-trip.

const ESCAPE_SEQUENCE_STATE = Symbol("escapeSequenceState");

interface EscapeSequenceState {
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Lightweight outcome emitted by reduceCardKey when the escape threshold is hit. */
export interface EscapeOutcome {
  type: "escape_threshold";
  outcome: "abandoned" | "halted";
}

/**
 * Get-or-create the escape-sequence tracker on a card state record.
 * Returns the mutable state object so the caller can inspect and clear it.
 */
function getEscapeSequenceState(
  cardState: Record<PropertyKey, unknown>,
): EscapeSequenceState {
  let s = (cardState as Record<PropertyKey, unknown>)[ESCAPE_SEQUENCE_STATE] as
    | EscapeSequenceState
    | undefined;
  if (!s) {
    s = { count: 0, timer: null };
    (cardState as Record<PropertyKey, unknown>)[ESCAPE_SEQUENCE_STATE] = s;
  }
  return s;
}

/** Cancel any pending timer and reset the press counter. */
function resetEscapeSequence(s: EscapeSequenceState): void {
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.count = 0;
}

/**
 * Core askcard state-machine step for a single key event.
 *
 * Returns `{ state, emit }` where `state` is the updated card state record and
 * `emit` is an optional event to broadcast to the harness.
 *
 * Outcome thresholds (all within the same parked askcard):
 *   - 2 Escape presses ≤ 250 ms apart  → outcome "abandoned"
 *   - 10 Escape presses ≤ 500 ms apart → outcome "halted"
 *
 * A single Escape press falls through to the dismiss branch (caller nulls the
 * refs; the run continues unmodified). This is intentionally separate from the
 * sequence tracker so we never fire a run-end event on a lone Esc.
 */
export function reduceCardKey(
  question: CouncilQuestionData,
  cardState: Record<PropertyKey, unknown>,
  cardKey: CouncilCardKey,
): { state: Record<PropertyKey, unknown>; emit?: EscapeOutcome } {
  const s = getEscapeSequenceState(cardState);

  if (cardKey.kind === "escape") {
    // Reset stale sequence: 10-press window expired → start fresh.
    if (s.timer && Date.now() - (s.timer as unknown as number) > 500) {
      resetEscapeSequence(s);
    }

    s.count += 1;

    // ── Threshold: 2 presses within 250 ms → "abandoned"
    if (s.count === 2) {
      // Set a 250 ms expiry timer. If no 3rd press arrives in time the
      // handler will see `emit` when it fires.
      s.timer = setTimeout(() => {
        if (s.count === 2) {
          resetEscapeSequence(s);
        }
      }, 250) as unknown as ReturnType<typeof setTimeout>;
      // Wrap the timer so the caller can await it synchronously.
      const abandonedPromise: Promise<EscapeOutcome> = new Promise((resolve) => {
        const id = setTimeout(() => {
          if (s.count === 2) {
            resetEscapeSequence(s);
            resolve({ type: "escape_threshold", outcome: "abandoned" });
          } else {
            resolve({ type: "escape_threshold", outcome: "abandoned" });
          }
        }, 251);
        // Keep the timer handle on the state so the unmount guard can clear it.
        (s as EscapeSequenceState & { _abandonedTimer: ReturnType<typeof setTimeout> })._abandonedTimer = id;
      });
      return { state: cardState, emitWait: abandonedPromise };
    }

    // ── Threshold: 10 presses within 500 ms → "halted"
    if (s.count === 10) {
      resetEscapeSequence(s);
      return { state: cardState, emit: { type: "escape_threshold", outcome: "halted" } };
    }

    // Presses 3-9: just track, don't emit yet.
    return { state: cardState };
  }

  // Non-escape key: clear any pending escape timer.
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  return { state: cardState };
}
