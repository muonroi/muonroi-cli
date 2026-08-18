import { type LanguageModel, type ModelMessage, streamText, type ToolSet } from "ai";

/**
 * A streaming drop-in for the AI SDK's `generateText`.
 *
 * WHY: the ChatGPT Codex OAuth endpoint (chatgpt.com/backend-api/codex/
 * responses) HARD-REJECTS non-streaming POSTs with 400 `{"detail":"Stream must
 * be set to true"}`. `generateText` issues a non-stream request, so on a
 * codex/oauth session (e.g. gpt-5.4) EVERY auxiliary call that ran through it —
 * the loop-guard decision, compaction summariser, side-question, PIL discovery,
 * synthesis — failed. The council layer already fixed its own path this way
 * (see src/council/llm.ts `collectStreamText`); this is the general-purpose
 * equivalent for the orchestrator/PIL/flow call sites.
 *
 * Streaming is the universal transport (every provider and the whole TUI use
 * it), so collecting a streamed result fixes codex WITHOUT special-casing the
 * provider. A provider `error` stream part is re-thrown so a caller's retry /
 * cross-provider fallback treats it exactly as a thrown `generateText` did.
 *
 * Only the fields real callers read are returned (`text`, `usage`,
 * `finishReason`, `reasoningText`, `toolCalls`).
 */
export interface StreamedGenerateArgs {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Defaults to the AI SDK default; pass 0 to disable in-SDK retries. */
  maxRetries?: number;
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  tools?: ToolSet;
  toolChoice?: unknown;
  stopWhen?: unknown;
  prepareStep?: unknown;
}

/** Structural usage shape — matches both the AI SDK usage object and callers. */
export interface StreamedUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  [k: string]: unknown;
}

export interface StreamedGenerateResult {
  text: string;
  reasoningText?: string;
  usage?: StreamedUsage;
  finishReason?: string;
  toolCalls: Array<{ toolName: string; input?: unknown; result?: unknown }>;
}

export async function generateTextStreamed(args: StreamedGenerateArgs): Promise<StreamedGenerateResult> {
  const hasTools = !!args.tools && Object.keys(args.tools).length > 0;
  // Cast at the AI SDK call boundary: streamText's generic Prompt overload wants
  // prompt XOR messages, which a conditional spread can't express — one is always
  // provided at runtime. Mirrors scope-ceiling's `callArgs: any` pattern.
  const result = streamText({
    model: args.model,
    ...(args.system === undefined ? {} : { system: args.system }),
    ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
    ...(args.messages === undefined ? {} : { messages: args.messages }),
    ...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: args.maxOutputTokens }),
    ...(args.maxRetries === undefined ? {} : { maxRetries: args.maxRetries }),
    ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
    ...(args.providerOptions ? { providerOptions: args.providerOptions as never } : {}),
    ...(args.toolChoice ? { toolChoice: args.toolChoice as never } : {}),
    ...(hasTools
      ? { tools: args.tools, stopWhen: args.stopWhen as never, prepareStep: args.prepareStep as never }
      : {}),
    abortSignal: args.abortSignal,
  } as Parameters<typeof streamText>[0]);

  let text = "";
  let reasoningText = "";
  let usage: StreamedUsage | undefined;
  let finishReason: string | undefined;
  const toolCalls: Array<{ toolName: string; input?: unknown; result?: unknown }> = [];
  const byId = new Map<string, { toolName: string; input?: unknown; result?: unknown }>();

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        text += (part as { text?: string }).text ?? "";
        break;
      case "reasoning-delta":
        reasoningText += (part as { text?: string }).text ?? "";
        break;
      case "tool-call": {
        const p = part as { toolCallId: string; toolName: string; input?: unknown };
        const tc = { toolName: p.toolName, input: p.input };
        byId.set(p.toolCallId, tc);
        toolCalls.push(tc);
        break;
      }
      case "tool-result": {
        const p = part as { toolCallId: string; output?: unknown };
        const tc = byId.get(p.toolCallId);
        if (tc) tc.result = p.output;
        break;
      }
      case "finish": {
        const p = part as { totalUsage?: StreamedUsage; usage?: StreamedUsage; finishReason?: string };
        usage = p.totalUsage ?? p.usage;
        finishReason = p.finishReason;
        break;
      }
      case "error": {
        const raw = (part as { error?: unknown }).error;
        throw raw instanceof Error ? raw : new Error(String(raw));
      }
      default:
        break;
    }
  }

  return { text, reasoningText: reasoningText || undefined, usage, finishReason, toolCalls };
}
