/**
 * src/orchestrator/system-message-fold.ts
 *
 * Fold mid-conversation `system` messages into a user message before the
 * prompt reaches a provider.
 *
 * Root cause it addresses (session e8a11770b19b, reproduced headlessly): the
 * orchestrator appends guidance to the live history as system messages —
 * EE session guidance and the EE recall-ledger nag
 * (`message-processor.ts`), plus background-delegation notifications
 * (`orchestrator.ts`). Anthropic has ONE top-level `system` field, so a system
 * message that lands AFTER user/assistant turns cannot be expressed at all and
 * the API rejects the request outright:
 *
 *     'Multiple system messages that are separated by user/assistant messages'
 *     function is not supported
 *
 * The turn dies with zero output — on a plain "hello", whenever hints happened
 * to be pending. Every such injection site is exposed, so the fix belongs at
 * the prompt-assembly boundary rather than in each caller: a fourth site added
 * later is covered for free.
 *
 * Folding (not dropping) keeps the text visible to the model, and folding into
 * a USER message rather than emitting a second leading system block avoids
 * changing role ordering — no consecutive same-role pairs are introduced, so
 * no provider's alternation rule is disturbed.
 */
import type { ModelMessage } from "ai";

/** Marker prefix so a folded block is still legible as machine guidance. */
export const FOLDED_SYSTEM_PREFIX = "[System note]";

function appendText(content: ModelMessage["content"], text: string): ModelMessage["content"] {
  if (typeof content === "string") return `${content}\n\n${text}`;
  if (Array.isArray(content)) {
    return [...content, { type: "text", text }] as ModelMessage["content"];
  }
  return content;
}

/**
 * Returns `messages` with every system message that appears after a
 * non-system message folded into the nearest PRECEDING user message.
 *
 * Leading system messages are left exactly where they are — the AI SDK hoists
 * those into the provider's native system field, which is the supported shape.
 * A trailing system message with no preceding user message to fold into is
 * also left alone: there is nothing to merge it with, and dropping it would
 * lose guidance silently.
 *
 * Pure; never mutates the input.
 */
export function foldMidConversationSystemMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  // Fast path: nothing to do unless a system message follows a non-system one.
  let seenNonSystem = false;
  let needsFold = false;
  for (const m of messages) {
    if (m.role !== "system") {
      seenNonSystem = true;
      continue;
    }
    if (seenNonSystem) {
      needsFold = true;
      break;
    }
  }
  if (!needsFold) return messages as ModelMessage[];

  const out: ModelMessage[] = [];
  let lastUserIndex = -1;
  seenNonSystem = false;

  for (const msg of messages) {
    if (msg.role !== "system") {
      seenNonSystem = true;
      if (msg.role === "user") lastUserIndex = out.length;
      out.push(msg);
      continue;
    }
    if (!seenNonSystem) {
      out.push(msg); // leading system — the supported position
      continue;
    }
    const text = typeof msg.content === "string" ? msg.content : "";
    const target = lastUserIndex >= 0 ? out[lastUserIndex] : undefined;
    if (!target || text.trim().length === 0) {
      // No user message to fold into (or nothing to fold) — keep it rather
      // than silently discarding guidance.
      out.push(msg);
      continue;
    }
    out[lastUserIndex] = {
      ...target,
      content: appendText(target.content, `${FOLDED_SYSTEM_PREFIX}\n${text}`),
    } as ModelMessage;
  }

  return out;
}
