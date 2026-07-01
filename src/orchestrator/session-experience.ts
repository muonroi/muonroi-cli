/**
 * src/orchestrator/session-experience.ts
 *
 * In-process record of what actually happened to the agent in THIS CLI session:
 * how often compaction fired, which tool outputs were elided, how many of those
 * the agent rehydrated via ee_query (and from where), and whether the Experience
 * Engine misbehaved. It is the single source of truth for the agent's *lived*
 * session experience.
 *
 * Why this exists: when a user asks "cảm nhận trong CLI" / "do you feel blind in
 * this session", the agent used to answer by READING the anti-mù source code and
 * theorizing about mechanisms (session ce816796a57d) — friction it never actually
 * observed. That is backwards. With this tracker the agent answers from data —
 * "compaction fired 3x, I rehydrated 2 artifacts, never lost context" — instead of
 * inferring from code. The same counters double as the "measure before you
 * re-architect" instrumentation: how often a real session actually elides a stub
 * the agent then needs.
 *
 * Process-scoped singleton == session-scoped: one CLI invocation is one session.
 * Pure module, no I/O, fully unit-testable; reset hook for tests.
 */

export type RehydrateSource = "cache" | "disk" | "ee" | "unavailable";

export interface ElisionRecord {
  toolCallId: string;
  toolName: string;
  /** Full length of the elided output, in chars. */
  chars: number;
  /** prepareStep step number at which it was elided. */
  step: number;
  summary?: string;
}

export interface SessionExperience {
  compactions: number;
  lastCompactionStep: number | null;
  elisions: ReadonlyArray<ElisionRecord>;
  totalElidedChars: number;
  rehydrations: Readonly<Record<RehydrateSource, number>>;
  eeTimeouts: number;
  eeErrors: number;
}

/** Bound the elision log so a pathological session can't grow it unbounded. */
const MAX_ELISIONS = 200;

interface MutableState {
  compactions: number;
  lastCompactionStep: number | null;
  elisions: ElisionRecord[];
  rehydrations: Record<RehydrateSource, number>;
  eeTimeouts: number;
  eeErrors: number;
}

function freshState(): MutableState {
  return {
    compactions: 0,
    lastCompactionStep: null,
    elisions: [],
    rehydrations: { cache: 0, disk: 0, ee: 0, unavailable: 0 },
    eeTimeouts: 0,
    eeErrors: 0,
  };
}

let state: MutableState = freshState();

/** Record that B3/B4 compaction actually elided something at `step`. */
export function recordCompaction(step: number): void {
  state.compactions += 1;
  state.lastCompactionStep = Number.isFinite(step) ? step : state.lastCompactionStep;
}

/** Record a single tool output the compactor rewrote into a stub. */
export function recordElision(
  toolCallId: string,
  toolName: string,
  chars: number,
  step: number,
  summary?: string,
): void {
  if (!toolCallId) return;
  state.elisions.push({
    toolCallId,
    toolName: toolName || "",
    chars: Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0,
    step: Number.isFinite(step) ? step : 0,
    summary,
  });
  // FIFO trim — keep the most recent MAX_ELISIONS.
  if (state.elisions.length > MAX_ELISIONS) {
    state.elisions.splice(0, state.elisions.length - MAX_ELISIONS);
  }
}

/**
 * Record an ee_query rehydrate of an elided artifact, tagged by where it came
 * from. `unavailable` means the agent asked for an artifact that was neither in
 * the local cache nor recoverable from EE — the "needed-but-couldn't-get" signal.
 */
export function recordRehydration(source: RehydrateSource): void {
  if (source in state.rehydrations) state.rehydrations[source] += 1;
}

/** Record an Experience Engine timeout or non-timeout error felt this session. */
export function recordEeEvent(kind: "timeout" | "error"): void {
  if (kind === "timeout") state.eeTimeouts += 1;
  else state.eeErrors += 1;
}

/**
 * Flat scalar counts — the shape persisted per session and aggregated
 * cross-session by `usage experience` to decide whether compaction friction is
 * real at a painful rate (no nested arrays, JSON-stable).
 */
export interface SessionExperienceCounts {
  compactions: number;
  elided: number;
  totalElidedChars: number;
  rehydratedCache: number;
  rehydratedDisk: number;
  rehydratedEe: number;
  unavailable: number;
  eeTimeouts: number;
  eeErrors: number;
}

/** Scalar counts for persistence/aggregation (drops the per-elision array). */
export function getSessionExperienceCounts(): SessionExperienceCounts {
  const s = getSessionExperience();
  return {
    compactions: s.compactions,
    elided: s.elisions.length,
    totalElidedChars: s.totalElidedChars,
    rehydratedCache: s.rehydrations.cache,
    rehydratedDisk: s.rehydrations.disk,
    rehydratedEe: s.rehydrations.ee,
    unavailable: s.rehydrations.unavailable,
    eeTimeouts: s.eeTimeouts,
    eeErrors: s.eeErrors,
  };
}

/** Immutable snapshot of the session so far. */
export function getSessionExperience(): SessionExperience {
  return {
    compactions: state.compactions,
    lastCompactionStep: state.lastCompactionStep,
    elisions: state.elisions.slice(),
    totalElidedChars: state.elisions.reduce((sum, e) => sum + e.chars, 0),
    rehydrations: { ...state.rehydrations },
    eeTimeouts: state.eeTimeouts,
    eeErrors: state.eeErrors,
  };
}

/** Most-recent elisions, newest first — feeds the checkpoint manifest. */
export function recentElisions(n = 5): ElisionRecord[] {
  const take = Math.max(0, Math.floor(n));
  return state.elisions.slice(-take).reverse();
}

/** True when literally nothing notable has happened yet (context intact). */
export function isSessionExperienceEmpty(): boolean {
  return (
    state.compactions === 0 &&
    state.elisions.length === 0 &&
    state.eeTimeouts === 0 &&
    state.eeErrors === 0 &&
    state.rehydrations.cache === 0 &&
    state.rehydrations.disk === 0 &&
    state.rehydrations.ee === 0 &&
    state.rehydrations.unavailable === 0
  );
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * A compact manifest of the most-recently elided tool outputs, for the
 * post-compaction checkpoint note: turns the generic "high-value elided? use
 * ee_query" prose into a concrete, actionable list so the agent's rehydrate
 * round-trip is informed rather than blind.
 */
export function formatElisionManifest(n = 5): string {
  const recent = recentElisions(n);
  if (recent.length === 0) return "";
  const items = recent.map((e) => `id=${shortId(e.toolCallId)} ${e.toolName || "tool"} (${e.chars}c)`).join(" · ");
  return `Elided this turn: ${items}. ee_query "tool-artifact id=XXX" to rehydrate the one you need.`;
}

/**
 * The agent-facing felt summary. Injected when the user asks how the agent is
 * doing IN this session, so the answer is grounded in what actually happened —
 * not in a fresh reading of the compaction/PIL source.
 */
export function formatSessionExperience(): string {
  const s = getSessionExperience();
  const lines: string[] = [];
  lines.push("[session experience — what ACTUALLY happened to you in THIS CLI session so far]");

  if (isSessionExperienceEmpty()) {
    lines.push("- Nothing notable: no compaction, no elision, no EE failures. Your context is intact this session.");
  } else {
    lines.push(
      s.compactions === 0
        ? "- Compaction: not fired yet — full context retained."
        : `- Compaction: fired ${s.compactions}x${s.lastCompactionStep !== null ? ` (last at step ${s.lastCompactionStep})` : ""}.`,
    );
    if (s.elisions.length === 0) {
      lines.push("- Tool outputs elided: none — nothing was rewritten to a stub.");
    } else {
      const tools = [...new Set(s.elisions.map((e) => e.toolName || "tool"))].join(", ");
      lines.push(`- Tool outputs elided: ${s.elisions.length} (${s.totalElidedChars} chars; via ${tools}).`);
    }
    const r = s.rehydrations;
    const rehydratedTotal = r.cache + r.disk + r.ee;
    lines.push(
      rehydratedTotal === 0 && r.unavailable === 0
        ? "- Rehydrated via ee_query: none requested."
        : `- Rehydrated via ee_query: cache=${r.cache} disk=${r.disk} ee=${r.ee}; needed-but-unavailable=${r.unavailable}.`,
    );
    if (s.eeTimeouts > 0 || s.eeErrors > 0) {
      lines.push(`- Experience Engine: timeouts=${s.eeTimeouts} errors=${s.eeErrors}.`);
    }
  }

  lines.push(
    "Answer the user's how-does-it-feel / are-you-blind question FROM THIS lived data — not by reading the CLI source. If everything is zero, say so plainly: nothing degraded your context this session.",
  );
  return lines.join("\n");
}

// ─── Test hook ─────────────────────────────────────────────────────────────
export function __resetSessionExperienceForTests(): void {
  state = freshState();
}
