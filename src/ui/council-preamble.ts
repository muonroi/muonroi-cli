/**
 * src/ui/council-preamble.ts
 *
 * The council flow streams several human-readable PREAMBLE lines into the
 * transcript before the debate proper:
 *
 *   [Auto-council triggered: complexity=heavy task=analyze]
 *     ↳ <clarification answer echo>            (index.ts answeredLabel)
 *     ↳ Leader recommends research …           (index.ts)
 *   > [Experience] N past warning(s) loaded …  (index.ts)
 *   ── Opening Analysis ──                      (debate.ts)
 *   > Leader-proposed debate budget: 3 rounds … (debate.ts)
 *   ── Round N ──                               (debate.ts, per round)
 *
 * In the two-pane council SURFACE every one of these is redundant with a
 * structured UI element: the convene reason → sticky banner, the budget →
 * rail "Round budget" row, the phase → PHASES timeline, the round divider →
 * round-grouped transcript. Left in the transcript they are pure noise that
 * pushes the real debate off screen (user report on session 47b3a8a546ca).
 *
 * `stripCouncilNoise` removes these lines from a streamed content chunk. It is
 * a pure line filter so it is unit-testable and never touches headless output
 * (the caller only invokes it when the surface is active). Two line classes:
 *
 *   - ALWAYS: distinctive markers that are redundant whenever the surface is on
 *     (the trigger, dividers, budget, experience-loaded, research recommend).
 *   - PREAMBLE-ONLY: the bare `↳ <answer>` echoes, which are indistinguishable
 *     from unrelated `↳ …` EE rating reminders elsewhere — so they are stripped
 *     ONLY while inside the convene→first-debate-turn window (`inPreamble`),
 *     which the caller opens on `sawTrigger` and closes on the first council
 *     round/question chunk.
 */

/** Distinctive council-noise lines, redundant with structured UI whenever the surface is on. */
const ALWAYS_NOISE: RegExp[] = [
  /^\[Auto-council triggered:.*\]$/,
  /^── Opening Analysis ──$/,
  /^── Round \d+ ──$/,
  /^>?\s*Leader-proposed debate budget:.*$/,
  /^>?\s*\[Experience\].*calibrate debate\.?$/,
  /^↳\s*Leader recommends research\b.*$/,
];

/** Lines stripped only inside the convene→first-turn preamble window. */
const PREAMBLE_ONLY: RegExp[] = [/^↳\s/];

/** Matches the convene line and captures its reason (`complexity=heavy task=analyze`). */
const TRIGGER = /^\[Auto-council triggered:\s*(.*?)\s*\]$/;

export interface StripResult {
  /** The chunk with council-noise lines removed. */
  text: string;
  /** True when this chunk contained the `[Auto-council triggered: …]` line (opens the preamble window). */
  sawTrigger: boolean;
  /** The parsed convene reason, when the trigger line was present, else null. */
  convene: string | null;
}

/**
 * Remove council-preamble noise lines from a streamed content chunk.
 *
 * @param content   the raw content delta from the stream
 * @param inPreamble whether the convene→first-debate-turn window is currently open
 */
export function stripCouncilNoise(content: string, inPreamble: boolean): StripResult {
  let sawTrigger = false;
  let convene: string | null = null;
  const lines = content.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      kept.push(line); // preserve blank lines / formatting
      continue;
    }
    const trig = TRIGGER.exec(trimmed);
    if (trig) {
      sawTrigger = true;
      convene = formatConvene(trig[1] ?? "");
      continue; // strip the trigger line itself
    }
    if (ALWAYS_NOISE.some((re) => re.test(trimmed))) continue;
    if ((inPreamble || sawTrigger) && PREAMBLE_ONLY.some((re) => re.test(trimmed))) continue;
    kept.push(line);
  }
  return { text: kept.join("\n"), sawTrigger, convene };
}

/**
 * Render the convene reason compactly for the banner header:
 * `complexity=heavy task=analyze` → `heavy · analyze`. Falls back to the raw
 * reason when it does not match the known key=value shape.
 */
export function formatConvene(reason: string): string {
  const r = reason.trim();
  if (r.length === 0) return "";
  const complexity = /complexity=(\S+)/.exec(r)?.[1];
  const task = /task=(\S+)/.exec(r)?.[1];
  const parts = [complexity, task].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : r;
}
