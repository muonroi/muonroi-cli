import { generateText } from "ai";
// FORK-02: ../grok/client deleted; stubs keep tsc --noEmit clean until plan 00-05.
import { type XaiProvider, type ResolvedModelRuntime } from "../agent/agent";

// FORK-02 stub: resolveModelRuntime — throws at runtime, compiles clean.
function resolveModelRuntime(_provider: XaiProvider, modelId: string): ResolvedModelRuntime {
  throw new Error(
    `muonroi-cli FORK-02: resolveModelRuntime not yet wired for model ${modelId}. ` +
      "Anthropic adapter ships in plan 00-05 (TUI-02, PROV-03).",
  );
}

export interface SideQuestionResult {
  response: string;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
}

const SIDE_QUESTION_SYSTEM = `You are a helpful coding assistant answering a quick side question. The user is in the middle of a coding session and needs a fast, concise answer. Keep your response short and focused — this is a side question, not the main task.

If conversation context is provided below, use it to give a more relevant answer.`;

export async function runSideQuestion(
  question: string,
  provider: XaiProvider,
  modelId: string,
  conversationContext: string,
  signal?: AbortSignal,
): Promise<SideQuestionResult> {
  const runtime = resolveModelRuntime(provider, modelId);
  const system = conversationContext
    ? `${SIDE_QUESTION_SYSTEM}\n\n<conversation_context>\n${conversationContext}\n</conversation_context>`
    : SIDE_QUESTION_SYSTEM;

  const { text, usage } = await generateText({
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
