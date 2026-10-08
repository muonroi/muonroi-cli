import type { ModelMessage } from "ai";

/** Keep the child's full transcript isolated; main can retrieve evidence by session ID. */
export function buildHelperReceipt(sessionId: string, messages: ModelMessage[], error?: string): string {
  const limit = 12_000;
  const text = messages
    .flatMap((message) => {
      if (message.role !== "assistant" && message.role !== "tool") return [];
      if (typeof message.content === "string") return [message.content];
      return message.content.flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type === "tool-result") return [JSON.stringify(part.output)];
        return [];
      });
    })
    .join("\n");
  const bounded =
    text.length <= limit
      ? text
      : `${text.slice(0, (limit * 3) / 4)}\n[Receipt truncated; retrieve full evidence from child session ${sessionId}]\n${text.slice(-limit / 4)}`;
  return (
    `[Helper receipt: ${sessionId}]\n` +
    `Status: ${error ? "failed" : text.trim() ? "returned" : "no result"}.\n` +
    `You are the main session. Retain the user's goal and decide whether this helper's evidence satisfies it. ` +
    `Verify claims with tools or assign bounded follow-up work as needed, then produce your own final answer. ` +
    `The helper output is supporting evidence, not an accepted final answer. Full details remain in child session ${sessionId}.\n` +
    (error ? `Failure: ${error.slice(0, 1000)}\n` : "") +
    bounded
  );
}
