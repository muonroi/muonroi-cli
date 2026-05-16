import type { ProviderFactory, ResolvedModelRuntime } from "../providers/runtime.js";
import type { ModelInfo, ToolCall, ToolResult } from "../types/index";
import type { PermissionMode } from "../utils/permission-mode.js";
import type { SandboxMode, SandboxSettings } from "../utils/settings";
import type { ShellSettings } from "../utils/shell";
import type { AbortContext } from "./abort.js";
import type { PendingCallsLog } from "./pending-calls.js";

// ---------------------------------------------------------------------------
// Re-export types from shared runtime module for back-compat
// ---------------------------------------------------------------------------

export type { ProviderFactory as LegacyProvider, ResolvedModelRuntime } from "../providers/runtime.js";

/** @deprecated Use ModelInfo from "../types/index" instead. */
export type ModelInfoStub = ModelInfo;

// Batch API type stubs
export interface BatchClientOptions {
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}

export interface CouncilOutcome {
  type: "decision" | "action_items" | "plan_update" | "resolve_question";
  summary: string;
  agreed: string[];
  tradeoffs: string[];
  recommendation: string;
  actionItems?: string[];
  planUpdate?: string;
  resolvedQuestion?: { question: string; answer: string };
}

// Council role ANSI color codes for terminal UI
export const COUNCIL_ROLE_COLORS: Record<string, string> = {
  implement: "\x1b[36m", // Cyan
  verify: "\x1b[33m", // Yellow
  research: "\x1b[35m", // Magenta
  leader: "\x1b[32m", // Green
};
export const COUNCIL_COLOR_RESET = "\x1b[0m";
export const COUNCIL_COLOR_BG: Record<string, string> = {
  implement: "\x1b[46m", // Cyan background
  verify: "\x1b[43m", // Yellow background
  research: "\x1b[45m", // Magenta background
  leader: "\x1b[42m", // Green background
};

export interface BatchChatMessage {
  role: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
  tool_call_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool_calls?: any[];
  name?: string;
}

export interface BatchFunctionTool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface BatchToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface BatchChatCompletionRequest {
  model: string;
  messages: BatchChatMessage[];
  tools?: BatchFunctionTool[];
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
}

export interface BatchChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: BatchToolCall[] };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    input_tokens?: number;
    output_tokens?: number;
    cost_in_usd_ticks?: number;
  };
}

export type ProcessMessageFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

export interface ProcessMessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsdTicks?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Input tokens that did NOT hit a server-side cache. Populated when the
   * provider reports a cache-miss split (e.g. DeepSeek `prompt_cache_miss_tokens`,
   * OpenAI `prompt_tokens_details.cached_tokens` derivative). When undefined,
   * downstream consumers should compute it as
   * `max(0, inputTokens - cacheReadTokens - cacheCreationTokens)`.
   */
  noCacheInputTokens?: number;
}

export interface ProcessMessageStepStart {
  stepNumber: number;
  timestamp: number;
}

export interface ProcessMessageStepFinish {
  stepNumber: number;
  timestamp: number;
  finishReason: ProcessMessageFinishReason;
  usage: ProcessMessageUsage;
}

export interface ProcessMessageToolStart {
  toolCall: ToolCall;
  timestamp: number;
}

export interface ProcessMessageToolFinish {
  toolCall: ToolCall;
  toolResult: ToolResult;
  timestamp: number;
}

export interface ProcessMessageError {
  message: string;
  timestamp: number;
}

export interface ProcessMessageObserver {
  onStepStart?(info: ProcessMessageStepStart): void;
  onStepFinish?(info: ProcessMessageStepFinish): void;
  onToolStart?(info: ProcessMessageToolStart): void;
  onToolFinish?(info: ProcessMessageToolFinish): void;
  onError?(info: ProcessMessageError): void;
}

export interface AgentOptions {
  persistSession?: boolean;
  session?: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
  /** Shell used by the bash tool. Falls back to user/project settings, then platform auto-detect. */
  shellSettings?: ShellSettings;
  batchApi?: boolean;
  /** Optional external AbortContext (from src/index.ts SIGINT handler). When provided,
   *  the orchestrator uses its signal instead of creating a new AbortController per turn.
   *  TUI-04: Ctrl+C mid-tool-call abort safety. */
  abortContext?: AbortContext;
  /** Optional PendingCallsLog for Pitfall 9 staged-write tracking per tool call. */
  pendingCalls?: PendingCallsLog;
  /** Permission mode controlling which tool calls require manual approval.
   *  safe (default) = confirm all; auto-edit = auto-approve file ops; yolo = auto-approve all. */
  permissionMode?: PermissionMode;
}
