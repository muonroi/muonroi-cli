// TurnRunnerDepsBase — shared dependency surface extracted from
// `MessageProcessorDeps` (Phase 12.4) and `BatchTurnRunnerDeps` (Phase 12.5).
//
// Both turn-runner modules need the same minimum proxy onto Agent state for
// compaction, task delegation, and turn bookkeeping. Hoisting that overlap
// here lets both interfaces declare the relationship explicitly via
// `interface X extends TurnRunnerDepsBase` instead of duplicating the
// property list.
//
// Pure type module — no runtime code. Adding a member here requires bumping
// every concrete deps implementation in orchestrator.ts; removing one only
// affects the concrete implementations that still rely on it.

import type { ModelMessage } from "ai";
import type { BashTool } from "../tools/bash";
import type { AgentMode, TaskRequest, ToolResult, UsageSource } from "../types/index";
import type { LegacyProvider } from "./agent-options";
import type { CompactionSettings } from "./compaction";

/**
 * Shared base for turn-runner deps surfaces.
 *
 * Holds the properties that are identical across `MessageProcessorDeps`
 * (streaming path) and `BatchTurnRunnerDeps` (batch-API path):
 *   - Read-only state references the turn loop touches
 *   - Compaction delegators (per-turn + post-turn)
 *   - Task/delegation tool callbacks
 *   - Turn bookkeeping (append/discard/recordUsage)
 *   - Common scalar getters/setters (compactedThisTurn, providerOptionsShape)
 *
 * Path-specific members (PIL, hooks, council, batch client, etc.) stay on
 * the concrete deps interfaces.
 */
export interface TurnRunnerDepsBase {
  // ---- Read-only state references ---------------------------------------
  /** Live messages array (mutated by push). */
  readonly messages: ModelMessage[];
  readonly bash: BashTool;
  readonly mode: AgentMode;
  readonly maxToolRounds: number;
  readonly schedules: import("../tools/schedule").ScheduleManager;
  readonly sendTelegramFile: ((filePath: string) => Promise<ToolResult>) | null;

  // ---- Scalar getters / setters -----------------------------------------
  getCompactedThisTurn(): boolean;
  setCompactedThisTurn(v: boolean): void;
  setLastProviderOptionsShape(shape: string | null): void;

  // ---- Compaction behavior delegators -----------------------------------
  getCompactionSettings(contextWindow?: number): CompactionSettings;
  compactForContext(
    provider: LegacyProvider,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
    settings?: CompactionSettings,
    overflow?: boolean,
  ): Promise<boolean>;
  postTurnCompact(provider: LegacyProvider, system: string, contextWindow: number, signal: AbortSignal): Promise<void>;

  // ---- Task / delegation tool callbacks ---------------------------------
  runTask(request: TaskRequest, signal?: AbortSignal): Promise<ToolResult>;
  runDelegation(request: TaskRequest, signal?: AbortSignal): Promise<ToolResult>;
  readDelegation(id: string): Promise<ToolResult>;
  listDelegations(): Promise<ToolResult>;
  killDelegation(id: string): Promise<ToolResult>;

  // ---- Turn bookkeeping --------------------------------------------------
  appendCompletedTurn(userMessage: ModelMessage, assistantMessages: ModelMessage[]): void;
  discardAbortedTurn(userMessage: ModelMessage): void;
  recordUsage(
    usage:
      | {
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        }
      | undefined,
    source?: UsageSource,
    model?: string,
    /** O1 — providerOptions shape of this call, threaded per event (see Agent.recordUsage). */
    providerOptionsShape?: string | null,
  ): void;
}
