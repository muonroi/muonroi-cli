/**
 * src/orchestrator/proactive-compact-detector.ts
 *
 * Detect when the agent (main or sub) proactively emits a /compact request
 * in its assistant text, per the guidance we injected in pre-warn and past-budget
 * reminders. Pattern (exact on its own line, as instructed):
 *   /compact <short instructions on what to focus on after compaction>
 *
 * When detected:
 * - Extract the instructions (trimmed).
 * - Caller can then:
 *   1. Emit the __COMPACT__-style signal (or call deliberateCompact).
 *   2. Inject a resume directive on the next turn: "Compact done. Resume previous task focusing on: <instructions>. Continue the work until complete."
 *   3. Do NOT stop the task.
 *
 * Precision: only matches leading /compact at start of line (after optional whitespace),
 * followed by optional instructions. Ignores mentions inside code blocks or prose.
 * Uses only stdlib (no extra deps). 1-line core after regex compile.
 */

export interface ProactiveCompactRequest {
  detected: boolean;
  instructions: string | null; // trimmed; null if none or empty
}

/** Matches "/compact ..." at start of a line (allows leading ws). Captures the rest. */
const PROACTIVE_RE = /^\s*\/compact\s*(.*)$/m;

export function detectProactiveCompactRequest(text: string): ProactiveCompactRequest {
  if (!text || typeof text !== "string") return { detected: false, instructions: null };
  const m = PROACTIVE_RE.exec(text);
  if (!m) return { detected: false, instructions: null };
  const raw = (m[1] || "").trim();
  return { detected: true, instructions: raw.length > 0 ? raw : null };
}

/** Build the exact resume text the agent should see after a proactive compact. */
export function buildCompactResumeMessage(instructions: string | null): string {
  const focus = instructions && instructions.trim().length > 0 ? instructions.trim() : "the original task";
  return `Compact done. Resume previous task focusing on: ${focus}. Continue the work until complete. Do not stop.`;
}
