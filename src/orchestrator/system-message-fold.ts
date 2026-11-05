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

function prependText(content: ModelMessage["content"], text: string): ModelMessage["content"] {
  if (typeof content === "string") return `${text}\n\n${content}`;
  if (Array.isArray(content)) {
    return [{ type: "text", text }, ...content] as ModelMessage["content"];
  }
  return content;
}

/**
 * Returns `messages` with every system message that appears after a
 * non-system message folded into a user message:
 *
 * - into the FOLLOWING user message when only system messages separate them
 *   (prepended, so chronology holds). This is the background-notice shape:
 *   `[..., assistant, system(notice), user(next turn)]`. Folding it backwards
 *   rewrote the previous turn's user message, so the first request after a
 *   notice stopped sharing the previous request's prefix from that user
 *   message on and the provider prompt cache missed the whole prior turn.
 *   Folding forward keeps every earlier message byte-identical: the new
 *   request is a pure append of the previous one.
 * - otherwise into the nearest PRECEDING user message (a notice that lands
 *   mid-turn, between tool rounds, has no later user message).
 *
 * Leading system messages are left exactly where they are — the AI SDK hoists
 * those into the provider's native system field, which is the supported shape.
 * A system message with no user message to fold into is also left alone:
 * there is nothing to merge it with, and dropping it would lose guidance
 * silently.
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
  let forward: string[] = [];
  seenNonSystem = false;

  for (const [index, msg] of messages.entries()) {
    if (msg.role !== "system") {
      seenNonSystem = true;
      if (msg.role === "user") {
        lastUserIndex = out.length;
        if (forward.length > 0) {
          out.push({ ...msg, content: prependText(msg.content, forward.join("\n\n")) } as ModelMessage);
          forward = [];
          continue;
        }
      }
      out.push(msg);
      continue;
    }
    if (!seenNonSystem) {
      out.push(msg); // leading system — the supported position
      continue;
    }
    const text = typeof msg.content === "string" ? msg.content : "";
    if (text.trim().length === 0) {
      // Nothing to fold — keep it rather than silently discarding it.
      out.push(msg);
      continue;
    }
    let next = index + 1;
    while (messages[next]?.role === "system") next++;
    if (messages[next]?.role === "user") {
      forward.push(`${FOLDED_SYSTEM_PREFIX}\n${text}`);
      continue;
    }
    const target = lastUserIndex >= 0 ? out[lastUserIndex] : undefined;
    if (!target) {
      // No user message to fold into — keep it rather than silently
      // discarding guidance.
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
