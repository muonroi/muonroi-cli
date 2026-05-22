import type { ModelMessage } from "ai";

const ENCRYPTED_REASONING_MARKERS = [
  "-----BEGIN PGP MESSAGE-----",
  "-----BEGIN PGP ARMORED FILE-----",
  "-----BEGIN AGE ENCRYPTED FILE-----",
  "encrypted_content",
] as const;

// Inter-tool narration patterns banned by PIL Layer 6 NO_PREAMBLE_RULE.
// Budget models (DeepSeek-V4-Flash, Qwen, Llama) routinely ignore text-based
// instructions and emit "Let me check..." / "Now let me look at..." between
// every tool call — session 7dcf8fd7d6a4 had 57/100 assistant messages doing
// this despite the prompt ban. Structural stripping is the only reliable fix.
// Match starts at the beginning of a text part (after trim) so legitimate
// final answers that happen to contain "Let me" mid-sentence stay intact.
// Boundary uses an explicit char class instead of \b because Vietnamese
// diacritics (ẽ, ế, ị, …) are not part of ECMAScript's default \w, so \b after
// "sẽ" wouldn't match.
const NARRATION_PREFIX_REGEX =
  /^\s*(?:Let me|Let's|Now let me|Now I'll|Now I will|I'll|I will|First, let me|Next, I'll|Next, let me|Here's what I'll|Tiếp theo (?:tôi sẽ|là)|Bây giờ (?:tôi (?:sẽ|cần|phải)|là)|Để tôi|Tôi sẽ|That was|That's the|This is the|Looking at|Checking|Examining)(?=[\s.,;!?]|$)/i;

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantContent = AssistantMessage["content"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getReasoningText(part: unknown): string | null {
  if (!isRecord(part) || part.type !== "reasoning") return null;
  if (typeof part.text === "string") return part.text;
  if (typeof part.reasoning === "string") return part.reasoning;
  return null;
}

export function containsEncryptedReasoning(text: string): boolean {
  const lower = text.toLowerCase();
  return ENCRYPTED_REASONING_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Strip inter-tool narration. When an assistant message has BOTH text and
 * tool-call parts, the text is by definition between-tool narration (the
 * "final answer" would not be followed by another tool call). Drop text parts
 * whose content matches a narration prefix.
 *
 * Pure final-answer text (text-only message, no tool-call after) is left alone
 * — that's the legitimate user-visible response.
 *
 * Tied to PIL L6 NO_PREAMBLE_RULE — see comment on NARRATION_PREFIX_REGEX.
 */
function stripInterToolNarration(content: AssistantContent): AssistantContent {
  if (!Array.isArray(content)) return content;
  // Treat parts as loose records — the AI SDK assistant content union is
  // discriminated and TS narrows away the "tool-call"/"text" tags after the
  // isRecord guard. We only need to inspect type+text shape; structural cast
  // keeps the logic readable without weakening the public AssistantContent type.
  const parts = content as unknown as Array<Record<string, unknown>>;
  const hasToolCall = parts.some((part) => isRecord(part) && part.type === "tool-call");
  if (!hasToolCall) return content;

  const stripped = parts.filter((part) => {
    if (!isRecord(part) || part.type !== "text") return true;
    const text = typeof part.text === "string" ? part.text : "";
    return !NARRATION_PREFIX_REGEX.test(text);
  });

  return stripped.length === content.length ? content : (stripped as unknown as AssistantContent);
}

function sanitizeAssistantContent(content: AssistantContent): AssistantContent {
  if (!Array.isArray(content)) return content;

  const filtered = content.filter((part) => {
    const reasoningText = getReasoningText(part);
    return !reasoningText || !containsEncryptedReasoning(reasoningText);
  });

  const reasoningSanitized: AssistantContent =
    filtered.length === content.length ? content : (filtered as typeof content);

  return stripInterToolNarration(reasoningSanitized);
}

export function sanitizeModelMessages(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const sanitized: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      sanitized.push(message);
      continue;
    }

    const content = sanitizeAssistantContent(message.content);
    if (content !== message.content) {
      changed = true;
    }

    if (Array.isArray(content) && content.length === 0) {
      changed = true;
      continue;
    }

    if (typeof content === "string" && !content.trim()) {
      changed = true;
      continue;
    }

    const nextMessage: ModelMessage = content === message.content ? message : { ...message, content };
    sanitized.push(nextMessage);
  }

  return changed ? sanitized : messages;
}
