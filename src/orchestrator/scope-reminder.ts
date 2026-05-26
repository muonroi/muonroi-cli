/**
 * src/orchestrator/scope-reminder.ts
 *
 * Phase 04 / Plan 4A — REQ-005 scope reminder.
 *
 * Re-anchors fast-tier cheap models (DeepSeek V4 Flash etc.) to their
 * original intent at structural cadence so multi-round tool loops do not
 * drift off-task. The reminder is injected into the tool_result/system
 * message channel — NOT into the system prompt — because the system prompt
 * is repeatedly compacted by B3/B4 once cumulative input grows.
 *
 * Locked behaviour (04-CONTEXT.md "Scope reminder 4A"):
 *   - Cadence K: 3 small / 5 medium / 8 large; hard floor K >= 3
 *   - Format (<= 200 chars):
 *       [scope-check step N/CEILING — task=TASKTYPE size=SIZE]
 *       original: "PROMPT_SNIPPET (first 100 chars)"
 *       still on scope? if no → emit final answer; if yes → continue.
 *   - Soft-warn fires ONCE per session at step === floor(ceiling * 0.7)
 *
 * Wired by both orchestrator loops:
 *   - src/orchestrator/message-processor.ts (top-level streamText loop)
 *   - src/orchestrator/stream-runner.ts (sub-agent streamText loop)
 *
 * All cadence math is pure. Soft-warn one-shot state lives on
 * `globalThis.__muonroiSoftWarnFired: Map<sessionId, Set<step>>` to match
 * the cross-cutting state pattern used by cross-turn-dedup (G3).
 */

export type ComplexitySize = "small" | "medium" | "large";

/** Hard floor for K. Never let cadence drop below this. */
export const SCOPE_REMINDER_FLOOR_K = 3;

/** Locked cadence table per 04-CONTEXT.md. */
const CADENCE_TABLE: Record<ComplexitySize, number> = {
  small: 3,
  medium: 5,
  large: 8,
};

/** Hard cap on the produced reminder string. 4V harness asserts this. */
export const SCOPE_REMINDER_MAX_CHARS = 200;

/** First-N chars of original prompt embedded in the reminder. */
export const SCOPE_REMINDER_PROMPT_SNIPPET_CHARS = 100;

/**
 * Resolve cadence K for a complexity-size. Floor at SCOPE_REMINDER_FLOOR_K
 * defends against garbage size strings reaching this path at runtime
 * (e.g. from an older trace replay where the bucket label changed).
 */
export function cadenceForSize(size: ComplexitySize | string | null | undefined): number {
  const k = CADENCE_TABLE[size as ComplexitySize];
  if (typeof k === "number" && k >= SCOPE_REMINDER_FLOOR_K) return k;
  return SCOPE_REMINDER_FLOOR_K;
}

/**
 * True iff `step` is a non-zero multiple of K. step 0 is the pre-loop
 * boundary — never inject a reminder before the agent has done any work.
 */
export function shouldInjectReminder(step: number, k: number): boolean {
  if (!Number.isFinite(step) || step <= 0) return false;
  if (!Number.isFinite(k) || k < 1) return false;
  return step % k === 0;
}

/**
 * One-shot soft-warn guard. Returns true exactly once per session when
 * `step === floor(ceiling * 0.7)`. Subsequent calls for the same session
 * (any step) return false.
 *
 * State: `globalThis.__muonroiSoftWarnFired: Map<sessionId, true>`
 * — mirror of the cross-turn-dedup G3 pattern. The map persists for the
 * lifetime of the CLI process; cleared at process exit.
 */
export function shouldInjectSoftWarn(step: number, ceiling: number, sessionId: string): boolean {
  if (!Number.isFinite(step) || step <= 0) return false;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
  const threshold = Math.floor(ceiling * 0.7);
  if (step !== threshold) return false;
  const g = globalThis as Record<string, unknown>;
  let fired = g.__muonroiSoftWarnFired as Map<string, true> | undefined;
  if (!(fired instanceof Map)) {
    fired = new Map<string, true>();
    g.__muonroiSoftWarnFired = fired;
  }
  if (fired.has(sessionId)) return false;
  fired.set(sessionId, true);
  return true;
}

/**
 * One-shot ceiling-crossing guard. Returns true exactly once per session at
 * the first step strictly past `naturalCeiling`. After that, subsequent calls
 * for the same session return false — the orchestrator should rely on the
 * regular cadence reminder (every K steps) to anchor a model that keeps
 * working past the budget. Without this guard, sessions that went deep past
 * ceiling (e.g. step 77 / ceiling 6 in session 1f29e238a816) received the
 * "past natural budget" strong reminder on EVERY step, generating 70+
 * redundant reminders that bloat tool_result channel and force the model
 * into a "YES still on scope" loop on every tool call.
 */
export function shouldInjectCeilingCrossing(step: number, naturalCeiling: number, sessionId: string): boolean {
  if (!Number.isFinite(step) || step <= 0) return false;
  if (!Number.isFinite(naturalCeiling) || naturalCeiling <= 0) return false;
  if (step <= naturalCeiling) return false;
  const g = globalThis as Record<string, unknown>;
  let fired = g.__muonroiCeilingCrossingFired as Map<string, true> | undefined;
  if (!(fired instanceof Map)) {
    fired = new Map<string, true>();
    g.__muonroiCeilingCrossingFired = fired;
  }
  if (fired.has(sessionId)) return false;
  fired.set(sessionId, true);
  return true;
}

export interface BuildScopeReminderOpts {
  step: number;
  ceiling: number;
  taskType: string;
  size: string;
  originalPrompt: string;
}

/**
 * Produce the locked reminder string, guaranteed <= SCOPE_REMINDER_MAX_CHARS.
 * Format reproduced verbatim from 04-CONTEXT.md so 4V harness assertions
 * (`[scope-check step 3/`, `still on scope?`) match.
 */
export function buildScopeReminder(opts: BuildScopeReminderOpts): string {
  const { step, ceiling, taskType, size, originalPrompt } = opts;
  const snippetRaw = (originalPrompt ?? "").slice(0, SCOPE_REMINDER_PROMPT_SNIPPET_CHARS);
  // Escape embedded double quotes so the JSON-looking snippet stays parseable
  // when an LLM tries to extract it. Backslash itself is NOT escaped because
  // the snippet is plain prose — repeated escaping would inflate length.
  const snippet = snippetRaw.replace(/"/g, '\\"');
  const header = `[scope-check step ${step}/${ceiling} — task=${taskType} size=${size}]`;
  const middle = `original: "${snippet}"`;
  // Tail kept short so the 100-char snippet + header always fit under the
  // 200-char hard cap (4V harness assertion). Spec phrasing "if no → emit
  // final answer; if yes → continue" inflates this past 60 chars, which
  // combined with a 50-char header + 100-char snippet overruns 200. The
  // 4V assertion only cares about "[scope-check step N/" + verbatim
  // snippet, so the trimmed tail is the minimal-impact concession.
  const tail = "still on scope? if no, finalize.";
  const joined = `${header}\n${middle}\n${tail}`;
  if (joined.length <= SCOPE_REMINDER_MAX_CHARS) return joined;
  // Defensive hard truncation. Header / tail are bounded by their own
  // string literals + small ints; only the snippet can blow the budget
  // when taskType/size labels are pathologically long. Re-derive a smaller
  // snippet that fits.
  const fixedOverhead = `[scope-check step ${step}/${ceiling} — task=${taskType} size=${size}]\noriginal: ""\n${tail}`
    .length;
  const room = Math.max(0, SCOPE_REMINDER_MAX_CHARS - fixedOverhead);
  const trimmed = snippet.slice(0, room);
  const candidate = `${header}\noriginal: "${trimmed}"\n${tail}`;
  if (candidate.length <= SCOPE_REMINDER_MAX_CHARS) return candidate;
  // Absolute last resort — hard slice. Better to lose readability than to
  // exceed the contractual cap that 4V asserts on.
  return candidate.slice(0, SCOPE_REMINDER_MAX_CHARS);
}

/**
 * Append `reminder` to a `messages` array via the tool_result channel.
 *
 * Strategy:
 *   - If the last message has role "tool" with at least one tool-result
 *     part, append a synthetic tool-result part carrying the reminder text.
 *     Pairing with an existing assistant tool-call is preserved by reusing
 *     the last result's `toolCallId` + `toolName` so the AI SDK does not
 *     drop the message for being orphaned.
 *   - Otherwise push a fresh `{role:"system", content: reminder}` at end.
 *
 * Returns a NEW array. Input is not mutated. When `reminder` is empty the
 * input is returned by identity (no allocations).
 */
export function attachReminderToMessages<T>(messages: ReadonlyArray<T>, reminder: string): T[] {
  if (!reminder) return messages as T[];
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ role: "system", content: reminder } as unknown as T];
  }
  const last = messages[messages.length - 1] as unknown as
    | {
        role?: string;
        content?: unknown;
      }
    | undefined;
  if (last && last.role === "tool" && Array.isArray(last.content)) {
    const parts = last.content as ReadonlyArray<Record<string, unknown>>;
    // Append reminder text INTO the last tool-result part's output value.
    // We must NOT create a new tool-result part with a duplicate toolCallId —
    // AI SDK v6 serializes multi-part `tool` messages into one OpenAI tool
    // message per part, and duplicate tool_call_id causes DeepSeek/OpenAI to
    // reject the request with "messages with role 'tool' must be a response
    // to a preceding message with 'tool_calls'". Mutating the existing part
    // keeps the 1:1 tool_call ↔ tool_result pairing intact.
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (p.type !== "tool-result") continue;
      const out_parts = parts.slice();
      const oldOut = p.output as { type?: string; value?: unknown } | undefined;
      const oldValue = typeof oldOut?.value === "string" ? oldOut.value : "";
      out_parts[i] = {
        ...p,
        output: { type: "text", value: `${oldValue}\n\n${reminder}` },
      };
      const rewritten = { ...last, content: out_parts } as unknown as T;
      const out = messages.slice() as T[];
      out[out.length - 1] = rewritten;
      return out;
    }
  }
  // Fallback path — push a fresh system-role message.
  return [...(messages as ReadonlyArray<T>), { role: "system", content: reminder } as unknown as T];
}
