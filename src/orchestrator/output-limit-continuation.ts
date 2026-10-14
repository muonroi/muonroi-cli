/**
 * Output-limit (finishReason "length") recovery for the main turn.
 *
 * WHY THIS EXISTS. A turn that hits its `maxOutputTokens` ceiling ends with
 * `finishReason: "length"` — the provider simply stops emitting, often
 * mid-sentence. The tool engine used to accept that as a finished turn: no
 * notice, no continuation, the transcript just ended (user report: a long
 * Vietnamese report from a StepFun reasoning model stopped at "…vẫn 429 sau
 * 2.6–" and nothing more). On a reasoning model the thinking block shares the
 * same budget and is emitted first, so how much visible text fits varies run
 * to run — which is why it only happened "sometimes".
 *
 * Recovery is a bounded CONTINUATION, mirroring the text-tool re-steer: the
 * cut reply is already persisted, a "continue from where you stopped" user
 * message is appended, and the stream attempt re-runs so the model emits only
 * the remaining part. When the budget is spent (or disabled), a visible notice
 * is appended instead so a truncated reply never looks finished.
 */

/** Default number of automatic continuations per turn. */
export const DEFAULT_OUTPUT_LIMIT_CONTINUATIONS = 2;

/** How much of the cut reply's tail is quoted back so the model resumes at the exact spot. */
const RESUME_TAIL_CHARS = 240;

/**
 * Per-turn cap on automatic continuations. Override with
 * MUONROI_OUTPUT_LIMIT_CONTINUATIONS (clamped to [0, 10]); 0 disables
 * auto-continue and leaves only the visible notice.
 */
export function getOutputLimitContinuationCap(): number {
  const raw = process.env.MUONROI_OUTPUT_LIMIT_CONTINUATIONS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_OUTPUT_LIMIT_CONTINUATIONS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_OUTPUT_LIMIT_CONTINUATIONS;
  return Math.min(10, Math.floor(n));
}

export type OutputLimitAction = "none" | "continue" | "notice";

/**
 * Decide what to do with a finished stream attempt.
 *
 * Only a genuine output-limit stop qualifies. A turn whose final answer came
 * from somewhere other than the cut stream — a response tool (structured
 * answer) or the F6 forced-finalize synthesis (its own call, its own budget) —
 * is complete, so continuing it would duplicate the answer.
 */
export function decideOutputLimitAction(input: {
  finishReason: string | null | undefined;
  answeredElsewhere: boolean;
  continuations: number;
  cap: number;
}): OutputLimitAction {
  if (input.finishReason !== "length" || input.answeredElsewhere) return "none";
  return input.continuations < input.cap ? "continue" : "notice";
}

/**
 * Last `maxChars` characters of `text`, counted in code points so a surrogate
 * pair (emoji, rare CJK) is never split into a lone half.
 */
export function resumeTail(text: string, maxChars = RESUME_TAIL_CHARS): string {
  const chars = Array.from(text.trimEnd());
  return chars.length <= maxChars ? chars.join("") : chars.slice(chars.length - maxChars).join("");
}

/** The user message that asks the model to resume a reply cut by the output limit. */
export function buildOutputLimitContinuationPrompt(cutText: string): string {
  const tail = resumeTail(cutText);
  const anchor = tail
    ? ` Your reply ended with:\n<<<\n${tail}\n>>>\nResume immediately after that point — mid-word or mid-sentence if that is where it stopped.`
    : "";
  return (
    "[Output limit] Your previous reply was cut off because it reached the output-token limit." +
    anchor +
    " Output ONLY the remaining part: do not repeat text already written, do not restart, apologize, or summarize." +
    " If you were in the middle of a tool call, issue it again through the tool interface."
  );
}

/** Visible transcript notice for a reply that stayed truncated. */
export function buildOutputLimitNotice(input: { maxOutputTokens?: number; continuations: number }): string {
  const limit =
    typeof input.maxOutputTokens === "number" && input.maxOutputTokens > 0
      ? ` (${input.maxOutputTokens.toLocaleString("en-US")} tokens)`
      : "";
  const after =
    input.continuations > 0
      ? ` after ${input.continuations} automatic continuation${input.continuations === 1 ? "" : "s"}`
      : "";
  return (
    `\n\n[Reply cut off: the model reached its output-token limit${limit}${after}, so the answer above is incomplete. ` +
    `Reply "continue" (or "tiếp tục") to get the rest.]`
  );
}

/**
 * Append `notice` to the final assistant text of a turn's generated messages,
 * so the persisted transcript (which the TUI re-renders from after the turn)
 * carries it — not only the live stream. Mutates and returns `messages`.
 */
export function appendNoticeToFinalMessages<T extends { role: string; content?: unknown }>(
  messages: T[],
  notice: string,
): T[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    if (typeof last.content === "string") {
      messages[messages.length - 1] = { ...last, content: `${last.content}${notice}` };
      return messages;
    }
    if (Array.isArray(last.content)) {
      const parts = [...(last.content as Array<Record<string, unknown>>)];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p && p.type === "text" && typeof p.text === "string") {
          parts[i] = { ...p, text: `${p.text}${notice}` };
          messages[messages.length - 1] = { ...last, content: parts };
          return messages;
        }
      }
    }
  }
  messages.push({ role: "assistant", content: notice.trimStart() } as T);
  return messages;
}
