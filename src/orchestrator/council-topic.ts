import { isContinuationPhrase } from "../pil/layer1-intent.js";

/** Message shape this module needs — deliberately structural, not tied to the AI SDK. */
interface TopicMessage {
  role?: string;
  content?: unknown;
}

/** Flatten a message's content to plain text; array parts keep only their text. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const p = part as { type?: string; text?: string };
      return p?.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Topic to pin on an auto-council debate.
 *
 * A continuation utterance ("tiếp tục nhé", "continue", "ok") names no subject,
 * so pinning it verbatim gives every debate round a contentless topic — that is
 * exactly what session 3f998bfef7db produced: a full multi-model debate titled
 * "tiếp tục nhé". When the triggering message is a continuation, resolve the
 * topic to the most recent user turn that DOES carry content, and keep the
 * continuation phrase visible so the panel knows it is resuming rather than
 * starting fresh.
 *
 * Falls back to the raw message when no substantive prior turn exists — a wrong
 * topic is still better than an empty one.
 */
export function resolveCouncilTopic(userMessage: string, messages: readonly TopicMessage[]): string {
  if (!isContinuationPhrase(userMessage)) return userMessage;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = messageText(m.content).trim();
    if (!text || isContinuationPhrase(text)) continue;
    return `${text}\n\n(Resuming — the user's follow-up was: "${userMessage.trim()}")`;
  }

  return userMessage;
}
