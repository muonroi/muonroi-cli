import type { ModelMessage } from "ai";

/** Keep the child's full transcript isolated; main can retrieve evidence by session ID. */
export function buildHelperReceipt(sessionId: string, messages: ModelMessage[], error?: string): string {
  const limit = 12_000;
  const bound = (text: string, budget: number) => {
    if (text.length <= budget) return text;
    const marker = `\n[Receipt truncated; retrieve full evidence from child session ${sessionId}]\n`;
    const available = Math.max(0, budget - marker.length);
    const head = Math.floor((available * 3) / 4);
    return (
      text.slice(0, head).replace(/[\uD800-\uDBFF]$/, "") +
      marker +
      text.slice(text.length - (available - head)).replace(/^[\uDC00-\uDFFF]/, "")
    );
  };
  let deliverable = "";
  const evidence: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    if (typeof message.content === "string") {
      const text = String(message.content); // Stored legacy tool messages predate SDK v6's array-only tool type.
      if (message.role === "assistant" && text.trim()) deliverable = text;
      else if (message.role === "tool" && text.trim()) evidence.push(`- Legacy tool result: ${bound(text, 400)}`);
      continue;
    }
    const assistantText =
      message.role === "assistant"
        ? message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : "";
    if (assistantText.trim()) deliverable = assistantText;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output.type === "text" ? part.output.value : JSON.stringify(part.output);
      // A response-tool result is the deliverable even without assistant prose.
      if (part.toolName.startsWith("respond_") && output.trim()) deliverable = output;
      else evidence.push(`- ${part.toolName} (toolCallId=${part.toolCallId}): ${bound(output, 400)}`);
    }
  }
  const toolEvidence = bound(evidence.slice(-8).join("\n"), 3_000);
  const header =
    `[Helper receipt: ${sessionId}]\n` +
    `Status: ${error ? "failed" : deliverable.trim() || evidence.length ? "returned" : "no result"}.\n` +
    `You are the main session. Retain the user's goal and decide whether this helper's evidence satisfies it. ` +
    `Verify claims with tools or assign bounded follow-up work as needed, then produce your own final answer. ` +
    `The helper output is supporting evidence, not an accepted final answer. Full details remain in child session ${sessionId}.\n` +
    (error ? `Failure: ${error.slice(0, 1000)}\n` : "");
  const evidenceSection = `\n\nTool evidence (recent previews; full inputs/outputs remain in child):\n${toolEvidence || "No tool results returned."}`;
  const deliverableHeading = "Deliverable (changes, verification, remaining blockers):\n";
  return (
    header +
    deliverableHeading +
    bound(
      deliverable || "No final deliverable returned; inspect the evidence before accepting.",
      limit - header.length - deliverableHeading.length - evidenceSection.length,
    ) +
    evidenceSection
  );
}
