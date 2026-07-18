import { resolveModelRuntime } from "../providers/runtime.js";
import { generateTextStreamed } from "../providers/streamed-generate.js";

export interface SideQuestionResult {
  response: string;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
}

const SIDE_QUESTION_SYSTEM = `You are a helpful coding assistant answering a quick side question. The user is in the middle of a coding session and needs a fast, concise answer. Keep your response short and focused — this is a side question, not the main task.

If conversation context is provided below, use it to give a more relevant answer.`;

export async function runSideQuestion(
  question: string,
  modelId: string,
  conversationContext: string,
  signal?: AbortSignal,
): Promise<SideQuestionResult> {
  const runtime = resolveModelRuntime(modelId);
  const system = conversationContext
    ? `${SIDE_QUESTION_SYSTEM}\n\n<conversation_context>\n${conversationContext}\n</conversation_context>`
    : SIDE_QUESTION_SYSTEM;

  // Stream + collect (NOT generateText): codex/oauth 400s non-stream requests.
  const { text, usage } = await generateTextStreamed({
    model: runtime.model,
    abortSignal: signal,
    ...(runtime.modelInfo?.supportsMaxOutputTokens === false ? {} : { maxOutputTokens: 2048 }),
    ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
    system,
    prompt: question,
  });

  return {
    response: text || "No response generated.",
    usage,
  };
}
