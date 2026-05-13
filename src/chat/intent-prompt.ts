export const SYSTEM_PROMPT =
  "You are the PO leading a product. Read the customer's recent messages in this Discord channel. " +
  "Reply in the SAME language the customer used (default Vietnamese). Output strict JSON ONLY " +
  "(no code fences, no commentary outside JSON):\n" +
  "{\n" +
  '  "intent": "accept" | "reject" | "abort" | "discuss",\n' +
  '  "reply": string (≤500 chars)\n' +
  "}\n\n" +
  "intent semantics:\n" +
  "- accept: customer is explicitly satisfied with this sprint and wants to move on.\n" +
  "- reject: customer wants specific changes but continue the product (will iterate next sprint).\n" +
  "- abort: customer wants to STOP the entire product (cut losses, wrong direction, no longer needed).\n" +
  "- discuss: customer asks a question, shares info, is exploring, OR is undecided. NO verdict yet.\n\n" +
  "RULES:\n" +
  "- Be CONSERVATIVE. When in doubt, choose 'discuss'.\n" +
  "- Negations matter: \"I don't accept this\" is NOT 'accept'. Read full intent.\n" +
  "- Emoji-only messages (e.g. '👍') without context: classify 'discuss' and ask for clarification.\n" +
  "- Keyword matching is FORBIDDEN. Use full-message semantics.";

const REVIEW_SUMMARY_MAX = 1500;
const REPLY_MAX = 500;

export interface ConvoTurn {
  role: "customer" | "bot";
  content: string;
}

export interface BuildConvoPromptArgs {
  reviewSummary: string;
  productName: string;
  priorTurns: ConvoTurn[];
  newMessage: string;
}

export function buildConvoPrompt(args: BuildConvoPromptArgs): string {
  const summary = args.reviewSummary.slice(0, REVIEW_SUMMARY_MAX);
  const priorLines = args.priorTurns.map((t) => `  ${t.role}: ${t.content}`).join("\n");
  return [
    `Product: ${args.productName}`,
    ``,
    `Sprint review summary:`,
    `  ${summary}`,
    ``,
    `Prior conversation (chronological):`,
    priorLines || "  (none)",
    ``,
    `New customer message:`,
    `  ${args.newMessage}`,
  ].join("\n");
}

export interface ParsedConvoReply {
  intent: string;
  reply: string;
}

const FALLBACK_REPLY = "Cho phép tôi suy nghĩ lại — bạn có thể chia sẻ thêm chi tiết được không?";

export function parseConvoReply(raw: string): ParsedConvoReply {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    const intent = typeof parsed.intent === "string" ? parsed.intent : "discuss";
    const reply = typeof parsed.reply === "string" ? parsed.reply.slice(0, REPLY_MAX) : FALLBACK_REPLY;
    return { intent, reply };
  } catch {
    return { intent: "discuss", reply: FALLBACK_REPLY };
  }
}
