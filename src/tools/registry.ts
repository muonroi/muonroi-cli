/**
 * Built-in AI SDK tool definitions for use when MCP servers are unavailable.
 *
 * These wrap the existing tool implementations (bash, file, grep) as proper
 * AI SDK tools using dynamicTool() + jsonSchema(), ensuring correct JSON Schema
 * is sent to the API for all providers (including DeepSeek, Gemini, etc.).
 */

import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { displayedRecallEntries } from "../ee/native-context.js";
import { MCP_FULL_INPUT_SCHEMA } from "../mcp/full-schema.js";
import type { AskUserAskInfo, AskUserOption } from "../orchestrator/ask-user.js";
import { requestProactiveCompact } from "../orchestrator/compact-request.js";
import { requestCouncilConvene } from "../orchestrator/council-request.js";
import {
  type ExecutionRole,
  filterExecutionTools,
  workerModelInventory,
} from "../orchestrator/orchestration-policy.js";
import { carriesElidedArgsMarker } from "../orchestrator/subagent-compactor.js";
import { TaskContext } from "../orchestrator/task-context.js";
import { canonicalizeBashCommand } from "../orchestrator/tool-args-hash.js";
import { isUnattendedTurn } from "../orchestrator/unattended-turn.js";
import {
  analyzeImageFromSource,
  askVisionProxy,
  closeVisionSessionAndCache,
  listCachedImages,
  listOpenVisionSessions,
} from "../providers/mcp-vision-bridge.js";
import { needsVisionProxy } from "../providers/vision-proxy.js";
import { mostRecentVisionSessionId } from "../providers/vision-session.js";
import { listToolEvidence } from "../storage/tool-evidence-index.js";
import type { AgentMode, TaskRequest, ToolResult } from "../types/index.js";
import { longestSleepSeconds, SLEEP_POLL_THRESHOLD_SECONDS, sleepPollRefusal } from "../utils/background-jobs.js";
import { isTuiActive, logger } from "../utils/logger.js";
import { loadMcpServers } from "../utils/settings.js";
import { isIdealToolEntryEnabled } from "../workflow/flags.js";
import type { PlanReviewBudget } from "../workflow/review-budget.js";
import { registerFlowWorkflowTools } from "../workflow/workflow-tools.js";
import { installArgGuards } from "./arg-guard.js";
import type { BashTool } from "./bash.js";
import { type BashSliceMode, bashOutputNotFoundMessage, getBashRun, sliceBashOutput } from "./bash-output-cache.js";
import { countUncommittedChanges, emptyLedgerRefusalMessage } from "./commit-ledger-refusal.js";
import { registerContextLoader } from "./context-load.js";
import type { FileResult } from "./file.js";
import { editFile, readFiles, writeFile } from "./file.js";
import { FileTracker } from "./file-tracker.js";
import { beginGitEffectGuard, effectViolationMessage } from "./git-effect-guard.js";
import {
  analyzeGitCommand,
  checkDestructiveOp,
  checkPushGate,
  checkSensitiveStaging,
  commitBlockedMessage,
  detectBlockedGitSubcommand,
  pushBlockedMessage,
  recordCommandOutcome,
  stagingWarning,
} from "./git-safety.js";
import { executeGrep } from "./grep.js";
import { registerNativeMuonroiTools } from "./native-tools.js";
import { registerNativeResearchTools } from "./research.js";
import { type GateCatalog, registerRunGateTool, resolveGateCatalog } from "./run-gate.js";
import { VISION_TOOL_NAMES } from "./vision-gate.js";
import { workerProcessRefusal } from "./worker-process-boundary.js";
import { filterScopedWorkerTools, WORKER_ISOLATION_CAPABILITIES, WorkerWriteScope } from "./worker-write-scope.js";

interface ToolRegistryOpts {
  writeScope?: string[];
  boundWriteScope?: WorkerWriteScope;
  runScopedWrite?: (operation: (scope: WorkerWriteScope) => Promise<FileResult>) => Promise<FileResult>;
  /** run_gate: current host scope (durable jobs re-read their record); defaults to boundWriteScope. */
  currentWriteScope?: () => Promise<WorkerWriteScope>;
  /** run_gate: host observation sink for out-of-scope effects / failed detection. */
  onGateViolation?: (observation: string) => void;
  /** run_gate: precomputed catalog (tests); defaults to resolveGateCatalog(cwd). */
  gateCatalog?: GateCatalog;
  /** Final permitted set for this child; never borrow the parent's global inventory. */
  getToolSet?: () => ToolSet;
  executionRole?: ExecutionRole;
  credentialedProvider?: import("../providers/types.js").ProviderId;
  taskContext?: TaskContext;
  runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDelegation?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  readDelegation?: (
    id: string,
    artifact?: import("../types/index.js").DelegationArtifactReadInput,
  ) => Promise<ToolResult>;
  sendDelegation?: (
    id: string,
    message: string,
    replyTo: string | undefined,
    toolCallId: string,
    signal?: AbortSignal,
    writeScope?: string[],
  ) => Promise<ToolResult>;
  workerMessage?: (
    kind: "progress" | "question",
    message: string,
    toolCallId: string,
    waitForReply: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  acknowledgeDelegation?: (id: string, resultVersion: string) => Promise<ToolResult>;
  acceptDelegation?: (input: import("../types/index.js").DelegationAcceptanceInput) => Promise<ToolResult>;
  startCouncil?: (input: {
    topic: string;
    reason: string;
    context: string;
    outputContract: string;
  }) => Promise<ToolResult>;
  startPlanReview?: import("../workflow/async-plan-review.js").AsyncPlanReviewHost["startPlanReview"];
  readPlanReview?: import("../workflow/async-plan-review.js").AsyncPlanReviewHost["readPlanReview"];
  listDelegations?: () => Promise<ToolResult>;
  killDelegation?: (id: string) => Promise<ToolResult>;
  modelId?: string;
  /** L1 model depth tier — gates flow_plan_review registration. */
  depthTier?: "quick" | "standard" | "heavy";
  consultParentSession?: (question: string) => Promise<string>;
  /**
   * When false, the 3 vision-proxy tools (analyze_image, ask_vision_proxy,
   * list_vision_cache) are omitted even for vision-proxy models. Used by the
   * orchestrator to drop them on pure-text turns with no image involvement
   * (see src/tools/vision-gate.ts). Defaults to true (include them) so every
   * other caller keeps its current behaviour. todo_write is never affected.
   */
  includeVisionTools?: boolean;
  /**
   * Phase 4R: session id used to key the bash canonical-repeat detector
   * state across multiple createBuiltinTools() rebuilds within the same
   * agent session. When omitted, each registry instance gets its own
   * isolated state (legacy per-closure behaviour).
   */
  sessionId?: string;
  planReviewBudget?: PlanReviewBudget;
  runDebate?: (topic: string, abortSignal?: AbortSignal, synthesisOutputContract?: string) => Promise<string>;
  /**
   * When true, the `convene_council` tool is registered so the agent can
   * convene the multi-model council on demand mid-turn. Set by the tool-engine
   * only when the council is actually usable for this session
   * (`configuredRoleCount >= getAutoCouncilMinRoles()`); omitted/false → the
   * tool is absent so the model never calls a council that cannot convene.
   */
  councilConfigured?: boolean;
  /** Optional turn-local background information; never waits for PIL. */
  readPilContext?: () => ToolResult;
  /**
   * When provided, the `ask_user` tool is registered so the agent can ask the
   * human a question mid-turn and receive their answer AS the tool result. The
   * handler blocks until the human responds (or dismisses). Omitted (headless
   * with no answerer) → the tool is absent, so the model never calls a card
   * that can never be answered.
   */
  askUser?: (info: AskUserAskInfo) => Promise<string>;
  /**
   * Feature B2 — when provided, the `enter_ideal` tool is registered so the agent
   * can request entry into /ideal product-loop mode after the user agreed to start
   * building what was discussed. The callback records a pending request on the
   * orchestrator; the top-level loop is dispatched AFTER the current turn's tool
   * phase completes (the tool cannot stream the loop itself). Omitted → tool absent.
   */
  enterIdeal?: (idea: string) => void;
}

/**
 * Phase 4R: session-scoped bash repeat detector state.
 *
 * Previously the `lastBashCanonical` / `lastBashRunId` lived in the closure
 * of `createBuiltinTools()`. Every askcard answer / sub-agent invocation
 * rebuilds the tool registry, wiping that state and letting cheap models
 * re-run identical `grep` calls across turns (baseline session
 * `77cd2e11c6a5` did this 9 times in a row).
 *
 * We now key the state by sessionId on a process-global Map so the detector
 * sees identical canonical commands no matter how many times the registry
 * is rebuilt within the same session. When no sessionId is provided we
 * synthesise a unique fallback key per registry instance, preserving the
 * legacy per-closure semantics for callers that haven't been wired yet.
 */
interface BashRepeatEntry {
  lastCanonical: string | null;
  lastRunId: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __muonroiBashRepeatState: Map<string, BashRepeatEntry> | undefined;
  // eslint-disable-next-line no-var
  var __muonroiSafetyApproved: Map<string, { kind: "once" | "session"; command: string }> | undefined;
}

function getSafetyApprovedMap(): Map<string, { kind: "once" | "session"; command: string }> {
  if (!globalThis.__muonroiSafetyApproved) {
    globalThis.__muonroiSafetyApproved = new Map();
  }
  return globalThis.__muonroiSafetyApproved;
}

function getBashRepeatState(): Map<string, BashRepeatEntry> {
  if (!globalThis.__muonroiBashRepeatState) {
    globalThis.__muonroiBashRepeatState = new Map<string, BashRepeatEntry>();
  }
  return globalThis.__muonroiBashRepeatState;
}

let __anonRepeatCounter = 0;
function resolveBashRepeatKey(sessionId: string | undefined): string {
  if (sessionId && sessionId.length > 0) return sessionId;
  __anonRepeatCounter += 1;
  return `__no_session__:${process.pid}:${Date.now()}:${__anonRepeatCounter}`;
}

/**
 * Default per-tool-call output cap in characters (~8k tokens).
 *
 * Read-side tools (read_file, grep, bash, process_logs) previously returned
 * raw output uncapped, so a single large file read could dump ~28k tokens
 * straight into the next LLM prompt. We now apply the cap uniformly to all
 * tool results (head/tail-preserving), which is the primary cost-leak fix
 * for sub-agent loops that read multiple files in one turn.
 *
 * Override with env `MUONROI_MAX_TOOL_OUTPUT_CHARS` (10_000–200_000).
 */
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 32_000;

function resolveMaxToolOutputChars(): number {
  const raw = process.env.MUONROI_MAX_TOOL_OUTPUT_CHARS;
  if (!raw) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 10_000 || n > 200_000) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  return Math.floor(n);
}

export const MAX_TOOL_OUTPUT_CHARS = resolveMaxToolOutputChars();

export function truncateOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - maxChars} chars truncated; full output in transcript] ...\n\n${text.slice(-half)}`;
}

function formatResult(result: ToolResult): string {
  if (result.success) {
    return truncateOutput(result.output ?? "OK");
  }
  return truncateOutput(`ERROR: ${result.error ?? result.output ?? "Unknown error"}`);
}

/**
 * Round 3 — EFFECT-BASED backstop for `autoCommit: false`. String-parsing a
 * shell command line for "does this write git history" is an arms race (see
 * git-safety.ts's `detectBlockedGitSubcommand` module comment); this wraps
 * EVERY `bash.execute()` call — including a pre-approved safety-override
 * retry, which skips every pre-execution gate — with a before/after ref
 * snapshot, regardless of how the command spelled "git". A violation
 * restores the ref(s) and turns the result into an error; the command's own
 * stdout/stderr is preserved so the model still sees what actually ran.
 *
 * Only pays the extra `git` subprocess calls when the project has disabled
 * auto-commit (lazy-imported — keeps the LSP-heavy auto-commit module off
 * the hot bash path when it is not needed, mirroring the G1 commit-gate
 * import below). `push` is NOT covered here — a push cannot be undone once a
 * remote has it, so it is still caught pre-execution by the string detector.
 */
async function runBashWithEffectGuard(
  bash: BashTool,
  command: string,
  timeout: number,
  abortSignal: AbortSignal | undefined,
): Promise<ToolResult> {
  const { isAutoCommitDisabledByProject } = await import("../orchestrator/auto-commit.js");
  const guard = isAutoCommitDisabledByProject() ? beginGitEffectGuard(bash.getCwd()) : null;
  const result = await bash.execute(command, timeout, abortSignal);
  if (guard) {
    const violation = guard.finish();
    if (violation) {
      return { ...result, success: false, error: effectViolationMessage(violation) };
    }
  }
  return result;
}

// ee_query routing: tool-artifact rehydration ("tool-artifact id=<id>" / "full
// tool result id=<id>") is an exact-lookup of a persisted elided output and
// must stay on /api/search (raw single-collection vector lookup). Every other
// query is general recall → /api/recall (recallMode: 3 collections, raw cosine,
// integrity gates, records a surface for exp-feedback). Splitting on intent
// keeps the rehydration contract intact while upgrading recall to the fixed,
// feedback-closing pipeline.
export function isToolArtifactQuery(query: string): boolean {
  return /\b(?:tool-artifact|full tool result)\b/i.test(query) && /\bid\s*=/i.test(query);
}

/**
 * The tool set the model was actually shown this turn - builtins PLUS the MCP
 * tools merged in downstream by the tool engine.
 *
 * `list_tools` and `describe_tool` close over `createBuiltinTools`' local
 * `tools` object, which is built BEFORE any MCP server is connected and is
 * replaced (not mutated) by the engine's `{...rawToolSet, ...mcpTools}` merge.
 * So both tools were structurally blind to every `mcp_*` tool. Measured in the
 * 2026-09-08 graduation session: `list_tools({category:"mcp"})` returned
 * `{"mcp_count":0,"mcp":[]}` in a run where 21 `mcp_muonroi-harness__*` tools
 * were live and the very next call to one of them succeeded - and
 * `describe_tool`, whose own description advertises
 * `name='mcp_context7__something'`, would have answered "Tool not found".
 *
 * Single-orchestrator-at-a-time holds (see the EE render-sink note in
 * src/index.ts), so one slot is enough: the engine publishes the assembled set
 * for the call it is about to make, and that is the set the model can ask about.
 */
let liveToolSet: ToolSet | null = null;

/** Publish the fully-assembled tool set for `list_tools` / `describe_tool`. */
export function setLiveToolSet(next: ToolSet | null): void {
  liveToolSet = next;
}

export function createBuiltinTools(bash: BashTool, mode: AgentMode, opts?: ToolRegistryOpts): ToolSet {
  const boundWriteScope =
    opts?.boundWriteScope ??
    (opts?.writeScope !== undefined ? new WorkerWriteScope(bash.getCwd(), opts.writeScope) : undefined);
  const tools: ToolSet = {};
  if (opts?.workerMessage) {
    tools.worker_message = dynamicTool({
      description:
        "Send progress or a question to your owning main. A question waits for an exact correlated reply by default; progress returns immediately. No recipient or permission changes. This does not accept or verify work.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          kind: { type: "string", enum: ["progress", "question"] },
          message: { type: "string", minLength: 1, maxLength: 8000 },
          waitForReply: {
            type: "boolean",
            description: "Questions only; default true. Host waits with a finite deadline, without model polling.",
          },
          timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
        },
        required: ["kind", "message"],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) =>
        formatResult(
          await opts.workerMessage!(
            input.kind,
            input.message,
            context?.toolCallId ?? "",
            input.waitForReply !== false,
            input.timeoutMs ?? 300000,
            context?.abortSignal,
          ),
        ),
    });
  }
  const taskContext = opts?.taskContext ?? new TaskContext(opts?.sessionId ?? crypto.randomUUID(), bash.getCwd());
  registerContextLoader(tools, taskContext, () => bash.getCwd(), opts?.executionRole);
  // One tracker per tool registry instance — shared across read/write/edit
  // calls in this tool run. A rebuilt registry starts a fresh read/write ledger.
  const fileTracker = new FileTracker();

  // Native research tools (fetch_url, web_search) — always available.
  // These are the in-process replacements for the old external MCP research servers.
  registerNativeResearchTools(tools);

  // read_file
  tools.read_file = dynamicTool({
    description:
      "Read requested file sections. Reuse sufficient current evidence; retrieve_tool_result by toolCallId for elided evidence before rereading. Use file_paths with path strings or {file_path,start_line,end_line} objects for inclusive ranges in one call. max_chars bounds returned excerpts; omissions name unreturned lines. Re-read current content when the edit guard requests it. Never infer omitted content.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to a single file to read (supports start_line/end_line)." },
        file_paths: {
          type: "array",
          maxItems: 20,
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  start_line: { type: "integer", minimum: 1 },
                  end_line: { type: "integer", minimum: 1 },
                },
                required: ["file_path"],
                additionalProperties: false,
              },
            ],
          },
          description:
            "Read MULTIPLE files in ONE call (preferred when you need 2+ files). Each is returned with its own header; each is capped independently so none is dropped. Best for small-to-medium files; for a large file use file_path + line range.",
        },
        start_line: { type: "number", description: "First line to read (1-based). Applies to file_path only." },
        end_line: { type: "number", description: "Last line to read (1-based). Applies to file_path only." },
        max_chars: {
          type: "integer",
          minimum: 256,
          maximum: MAX_TOOL_OUTPUT_CHARS,
          description: "Total excerpt budget; split fairly across batch paths. Defaults to the normal tool output cap.",
        },
      },
    }),
    execute: async (input: any) => {
      const batch = Array.isArray(input.file_paths) && input.file_paths.length > 0 ? input.file_paths : [];
      if (batch.length > 20) return "ERROR: At most 20 files per read; split this request into explicit batches.";
      const budget = input.max_chars ?? MAX_TOOL_OUTPUT_CHARS;
      if (!Number.isSafeInteger(budget) || budget < 256 || budget > MAX_TOOL_OUTPUT_CHARS)
        return `ERROR: max_chars must be an integer from 256 to ${MAX_TOOL_OUTPUT_CHARS}.`;
      if (batch.length > 1 || (batch.length === 1 && typeof batch[0] === "object")) {
        // Per-file fair-share of the output cap so the concatenated result
        // stays under MAX_TOOL_OUTPUT_CHARS and every file survives (no silent
        // head/tail drop of whole files). Floor keeps each file legible.
        if (budget < batch.length * 512)
          return "ERROR: max_chars must allow at least 512 characters per batch file; narrow the batch or increase the budget.";
        const perFileCap = Math.max(256, Math.floor(budget / batch.length) - 256);
        return formatResult(readFiles(batch, bash.getCwd(), fileTracker, perFileCap));
      }
      const single = batch.length === 1 ? batch[0] : input.file_path;
      const result = readFiles(
        [{ file_path: single, start_line: input.start_line, end_line: input.end_line }],
        bash.getCwd(),
        fileTracker,
        Math.max(1, budget - 256),
      );
      return formatResult(result);
    },
  });

  // grep
  tools.grep = dynamicTool({
    description:
      "Fast regex content search across the codebase using ripgrep. Returns matching lines with file paths and line numbers. Use this to find precise line numbers before calling read_file with start_line/end_line.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory path to search in" },
        include: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
      },
      required: ["pattern"],
    }),
    execute: async (input: any) => {
      const result = await executeGrep(
        { pattern: input.pattern, path: input.path, include: input.include },
        bash.getCwd(),
      );
      return formatResult(result);
    },
  });

  // compact — agent-initiated proactive context compaction. The model calls
  // this to shed accumulated tool/conversation history mid-task (freeing
  // context + resetting tool-call bloat) BEFORE it hits a tool-round limit,
  // so a long task never gets interrupted. The request is queued here and
  // consumed by the tool-engine's prepareStep boundary, which forces a
  // compaction pass before the next LLM step, then the turn continues. A
  // decisions/facts snapshot is preserved and high-value tool results stay
  // rehydratable via ee_query "tool-artifact id=…". This is the proactive
  // counterpart to the reactive tool-limit auto-recover.
  tools.compact = dynamicTool({
    description:
      "Compress this turn's older history, preserve its decisions and continue the task. Retrieve elided tool evidence with retrieve_tool_result using the original tool_call_id. Report unavailable evidence explicitly; do not invent missing results.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "Short note on what to keep in mind / preserve after compaction (e.g. the current sub-task).",
        },
      },
    }),
    execute: async (input: any) => {
      requestProactiveCompact(typeof input?.focus === "string" ? input.focus : null);
      return formatResult({
        success: true,
        output:
          'Context compaction scheduled. Continue the task; retrieve elided evidence with retrieve_tool_result and the complete original tool_call_id (never shorten it). If the ID is unknown, call retrieve_tool_result({view:"index",query:"relevant path, tool name or ID fragment"}) to discover local references. An exact-ID miss is not proof of cache loss. EE is not required. Report evidence still unavailable after local discovery explicitly.',
      });
    },
  });

  // convene_council — agent-initiated multi-model council. The model calls this
  // when THIS request genuinely warrants a cross-provider debate (conflicting
  // design tradeoffs, high-stakes decision). The request is queued here; the
  // tool-engine consumes it from the outer restart loop, runs runCouncilV2 with
  // suppressPostDebate:true (which suppresses ALL hardcoded post-debate decision
  // surface — no card, no continuation), splices the synthesis into THIS tool's
  // tool_result, and restarts the step so the model reads the conclusion as the
  // result and continues. Registered only when the council is usable so the
  // model never calls a council that cannot convene.
  if (opts?.readPilContext) {
    tools.read_pil_context = dynamicTool({
      description:
        "Read optional PIL information prepared in the background for this turn. Returns immediately with available information or pending/unavailable status. You own task, routing, and council decisions. If pending, continue without waiting or repeatedly polling. Ask human questions through ask_user.",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => formatResult(opts.readPilContext!()),
    });
  }
  if (opts?.councilConfigured && opts.startCouncil) {
    tools.convene_council = dynamicTool({
      description:
        "Launch a durable background council on demand. Supply topic, reason, bounded context and outputContract explicitly. Returns a job receipt immediately; consume completion with delegation_read/ACK. Advice is not implementation verification. End the turn while only jobs are pending; do not poll.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          topic: { type: "string" },
          reason: { type: "string" },
          context: { type: "string" },
          outputContract: { type: "string" },
        },
        required: ["topic", "reason", "context", "outputContract"],
        additionalProperties: false,
      }),
      execute: async (input: any) => formatResult(await opts.startCouncil!(input)),
    });
  } else if (opts?.councilConfigured && opts.executionRole !== "orchestrator") {
    tools.convene_council = dynamicTool({
      description:
        "Convene the multi-model council to debate THIS request. Use ONLY when the task has genuinely conflicting design tradeoffs, needs a cross-provider/second-opinion review, or is a high-stakes architecture/analysis decision where a single model's view is insufficient. It runs a real multi-role debate across several models and returns a synthesized conclusion AS THIS TOOL'S RESULT. Do NOT use it for routine or low-ambiguity work — it is expensive. After calling, read the returned conclusion and continue; nothing is auto-decided for you.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why this task needs a multi-model debate (the specific tradeoff or decision at stake).",
          },
        },
      }),
      execute: async (input: unknown, execOpts?: { toolCallId?: string }) => {
        const reason =
          input && typeof input === "object" && typeof (input as { reason?: unknown }).reason === "string"
            ? (input as { reason: string }).reason
            : null;
        requestCouncilConvene(reason, execOpts?.toolCallId ?? null);
        return formatResult({
          success: true,
          output:
            "Council convening — the multi-model debate runs now and its conclusion replaces this result before your next step. Read the conclusion, then continue.",
        });
      },
    });
  }

  // ask_user — agent-initiated question to the human. The model calls this from
  // its OWN judgment (e.g. after a convene_council conclusion, when it wants a
  // go/no-go before implementing). The CLI does NOT synthesise options or decide
  // the branch: question, options, and default all come from the model's input.
  // execute() BLOCKS until the human answers; the answer becomes the tool result.
  // Registered only when a UI answerer is wired (opts.askUser present) AND the
  // turn is not a machine-driven stage. `isUnattendedTurn()` is the second half
  // of the same contract the field doc states: a card nobody is watching can
  // never be answered, so the tool must not be offered. `/ideal`'s verify stage
  // runs as a normal top-level turn (sprint-runner.buildVerifyAgent →
  // ctx.processMessageFn), so `opts.askUser` is a live closure there — the scope
  // is what distinguishes it from a chat turn. See unattended-turn.ts for the
  // measured incident (run muc2joffe506: one ask_user cost a 600s budget and
  // discarded three verified phases).
  if (opts?.askUser && !isUnattendedTurn()) {
    const askUser = opts.askUser;
    tools.ask_user = dynamicTool({
      description:
        "Ask the human user a question and receive their answer AS THIS TOOL'S RESULT. Use when you need a decision, confirmation (e.g. 'proceed with implementation?'), or missing detail that only the user can provide — typically in an interactive discussion, or after a convene_council conclusion when you want a go/no-go before building. ALSO use it when you have been EXPLORING (multiple searches/reads) without a clear next step emerging: one focused question to the user is cheaper than several more speculative tool calls, and the per-step `[step N mirror]` note will flag this as 'Convergence: LOW'. Supply the exact `question` and, optionally, `options` the user picks from (omit for a free-text answer). This BLOCKS until the user responds. Nothing is auto-decided: read their answer and continue from your own judgment. Do NOT use it to narrate or for rhetorical questions — only when you genuinely need input to proceed.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The exact question to put to the user.",
          },
          context: {
            type: "string",
            description: "Optional short context shown under the question.",
          },
          options: {
            type: "array",
            description:
              "Optional choices the user picks from. Omit for a free-text answer. These are YOUR options — the CLI adds none.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "The choice shown to the user." },
                description: { type: "string", description: "Optional one-line explanation of the choice." },
                value: { type: "string", description: "Optional value returned when picked (defaults to the label)." },
              },
              required: ["label"],
            },
          },
          defaultIndex: {
            type: "number",
            description: "Optional index into options for the pre-selected choice (defaults to 0 = first).",
          },
        },
        required: ["question"],
      }),
      execute: async (input: unknown) => {
        const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
        const question = typeof obj.question === "string" ? obj.question : "";
        if (question.trim().length === 0) {
          return formatResult({
            success: false,
            output: "ask_user requires a non-empty `question`.",
          });
        }
        const rawOptions = Array.isArray(obj.options) ? obj.options : [];
        const options: AskUserOption[] = rawOptions
          .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
          .map((o) => ({
            label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
            description: typeof o.description === "string" ? o.description : undefined,
            value: typeof o.value === "string" ? o.value : undefined,
          }))
          .filter((o) => o.label.length > 0);
        const info: AskUserAskInfo = {
          question,
          context: typeof obj.context === "string" ? obj.context : undefined,
          options: options.length > 0 ? options : undefined,
          defaultIndex: typeof obj.defaultIndex === "number" ? obj.defaultIndex : undefined,
        };
        const answer = await askUser(info);
        return formatResult({ success: true, output: answer });
      },
    });
  }

  // bash — every foreground call goes through here. We track the LAST
  // canonical command + runId in SESSION-SCOPED state so we can inject a
  // reminder when the model issues another bash call that canonicalizes to
  // the same shape (e.g. `bunx vitest run | tail` followed by
  // `bunx vitest run | head` — both canonicalize to `bunx vitest run`).
  // The reminder rides on the tool_result of the SECOND call, which the
  // model is forced to read before its next step — far stronger signal
  // than a system-prompt rule it can attention-decay past.
  //
  // Phase 4R: state was previously a per-closure local; now it lives on a
  // process-global Map keyed by sessionId so a registry rebuild between
  // user turns / askcards no longer wipes it. See getBashRepeatState().
  const repeatState = getBashRepeatState();
  const repeatKey = resolveBashRepeatKey(opts?.sessionId);
  // Git-safety state key. MUST be stable across createBuiltinTools() rebuilds
  // within one process — otherwise a failed-test record made before a registry
  // rebuild (askcard answer, sub-agent turn) would be invisible to the push
  // gate after the rebuild. Unlike resolveBashRepeatKey's anon fallback (which
  // intentionally generates a fresh key per instance to isolate repeat-reminder
  // state), we want the gate to PERSIST: use the real sessionId when present,
  // else a single process-stable key. Over-sharing here is the safe direction
  // (it can only over-block a push, never wrongly allow one).
  const gitSafetyKey =
    opts?.sessionId && opts.sessionId.length > 0 ? opts.sessionId : `__proc_default__:${process.pid}`;
  // Per-session empty-bash streak counter: escalates from guidance (strike 1-2)
  // to hard block (strike 3+) so a cheap model that repeatedly emits `bash: {}`
  // cannot loop indefinitely (live: deepseek session bf58d0f46b51 — 8+ empty calls).
  const _emptyBashStreak = new Map<string, number>();
  const _prefixBlock = (kind: string, msg: string): string => `BLOCKED (${kind}): ${msg}`;

  tools.bash = dynamicTool({
    description:
      "Execute a shell command. Output is automatically cached — every call returns a " +
      "run_id you can re-query via bash_output_get(run_id, mode=tail|head|grep|lines). " +
      "Use returned output directly when sufficient; retrieve missing slices only when needed. " +
      "Keep full build/test/failure output by running unfiltered and inspecting the cache. Focused read-only pipes are allowed when the filtered output is the intended result; the cache retains only what the command emits. Preserve failure exit codes. Batch known independent checks; sequence dependent actions. Set background=true for long-running processes (dev servers, watchers). " +
      'Avoid nesting double-quotes inline for database queries/scripts (e.g. executing raw SQL via `sqlite3 db "SELECT..."`) since they can fail parsing in shell environments; write query scripts to a temporary file first and run them.',
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
        background: { type: "boolean", description: "Run in background (returns process ID)" },
      },
      required: ["command"],
    }),
    // Phase 8 — safety-blocked commands queue, keyed by sessionId + toolCallId.
    // When the orchestrator intercepts a blocked result, the approval handler
    // stores the approved command here so bash.execute() can retry it.
    // `abortSignal` is part of the AI SDK's ToolCallOptions and streamText is
    // called with one (src/orchestrator/stream-runner.ts). It was missing from
    // this type, so every `bash.execute()` below dropped it and BashTool never
    // registered its `onAbort` — the turn watchdog's abort could not kill a
    // running child at all. Sessions 7ec700df5589 / d22397a9e47d: a `bun test` +
    // `bun run typecheck` child outlived the CLI by 24h burning 16.5h of CPU.
    execute: async (
      input: any,
      extra?: { toolCallId?: string; messages?: ReadonlyArray<unknown>; abortSignal?: AbortSignal },
    ) => {
      // Corrective guard for malformed calls: a cheap model sometimes emits a
      // bash call with a missing / empty `command` (live: deepseek sent `{}`
      // repeatedly until the loop-guard fired). Passing undefined to
      // bash.execute() throws an opaque TypeError that doesn't steer the model
      // to self-correct, and a whitespace command "succeeds" with no output —
      // both look like progress and feed the loop. Return a crisp instruction
      // so the next step supplies a real command instead of repeating.
      if (typeof input.command !== "string" || input.command.trim() === "") {
        // Track empty-bash streak per session; escalate from guidance to hard block.
        const _ebKey = gitSafetyKey ?? "no-session";
        let _eb = _emptyBashStreak.get(_ebKey) ?? 0;
        _eb++;
        _emptyBashStreak.set(_ebKey, _eb);
        if (_eb >= 3) {
          // NOTE: this text deliberately names NO other tool. The previous
          // wording ("use read_file, grep, or other tools instead") redirected
          // a confused sub-agent into the two tools that had no arg guard at
          // all, and every call from step 103 to 175 was malformed.
          return (
            'BLOCKED (empty-bash): the `bash` tool has been called with an empty/missing "command" 3+ times in a row. ' +
            "Bash is now DISABLED for the remainder of this session. Do not retry it. " +
            "State the blocker in plain text and continue with what you already know; the CLI will enable it again on the next turn."
          );
        }
        if (_eb >= 2) {
          return (
            'BLOCKED (empty-bash): ERROR (2nd consecutive empty bash call): the `bash` tool requires a non-empty "command" string ' +
            "but this is the 2nd call in a row with empty arguments. One more empty call will BLOCK bash for the session. " +
            'Provide a real command, e.g. {"command":"ls -la"}.'
          );
        }
        return 'BLOCKED (empty-bash): the `bash` tool requires a non-empty "command" string, but the call had empty arguments. Provide the shell command to run, e.g. {"command":"ls -la"}.';
      }
      // Reset the empty-bash streak on any successful command.
      _emptyBashStreak.delete(gitSafetyKey ?? "no-session");

      const cmd = typeof input.command === "string" ? input.command : "";

      // Ownership restrictions are not safety approvals; enforce before overrides.
      const workerRefusal = opts?.executionRole === "worker" ? workerProcessRefusal(cmd) : undefined;
      if (workerRefusal) return workerRefusal;

      // Safety override check: approval is granted after a blocked call, but
      // the model's retry receives a new toolCallId. Match by id first, then
      // by exact command so allow-once survives the retry boundary.
      const _approvedMap = getSafetyApprovedMap();
      const _approvalKey =
        extra?.toolCallId && _approvedMap.has(extra.toolCallId)
          ? extra.toolCallId
          : [..._approvedMap.entries()].find(([, approval]) => approval.command === cmd)?.[0];
      const _approvalEntry = _approvalKey ? _approvedMap.get(_approvalKey) : undefined;
      if (_approvalEntry) {
        if (_approvalEntry.kind === "once") {
          _approvedMap.delete(_approvalKey!);
        }
        const result = await runBashWithEffectGuard(bash, input.command, input.timeout ?? 30000, extra?.abortSignal);
        return formatResult(result);
      }

      // Git safety (pre-execution). Block `git push` while a verification
      // command failed this session and was not re-run green; warn on broad
      // `git add -A` / `git commit -a` when sensitive paths exist. Applied to
      // BOTH foreground and background paths. See git-safety.ts for the audit
      // motivation (session 18285908637a). gitSafetyKey is STABLE per process
      // (or the real sessionId) — unlike repeatKey, whose anon fallback changes
      // on every registry rebuild and would silently drop the gate across turns.
      // Destructive-op guard (pre-execution, any permission mode): block a
      // command that would irreversibly discard uncommitted work (git
      // checkout --/restore/reset --hard/clean, git stash drop/clear, or rm of
      // a tracked file) when there is actually work at risk. Routed as
      // `destructive-revert` so the tool-engine shows the safety askcard
      // interactively and hard-blocks headless (autonomous sub-agents) — the
      // fix for the /ideal plan-adherence agent silently reverting user files.
      const destructive = checkDestructiveOp(cmd, bash.getCwd());
      if (destructive.blocked) {
        return _prefixBlock("destructive-revert", destructive.message);
      }

      const gitShape = analyzeGitCommand(cmd);

      // Gap (b): a project's `.muonroi-cli/settings.json` `{"autoCommit": false}`
      // disables the CLI's own auto-commit — honour the same policy for a raw
      // history/ref-writing git subcommand reached via the bash tool (commit,
      // merge, cherry-pick, rebase, am, revert, commit-tree, update-ref, tag,
      // push, pull, or a user alias resolving to one of those), otherwise the
      // model just routes around the setting. `detectBlockedGitSubcommand`
      // scans the RAW command (quotes included, so `sh -c "git commit ..."`
      // cannot hide from it — round-2 refuter finding) — see its own doc
      // comment in git-safety.ts. Pre-execution, any permission mode.
      {
        const { isAutoCommitDisabledByProject } = await import("../orchestrator/auto-commit.js");
        if (isAutoCommitDisabledByProject()) {
          const blocked = detectBlockedGitSubcommand(cmd, bash.getCwd());
          if (blocked.blocked) {
            return _prefixBlock(
              "git-safety",
              `this project's .muonroi-cli/settings.json sets "autoCommit": false — ` +
                `\`git ${blocked.subcommand}\`${blocked.viaAlias ? ` (via alias \`git ${blocked.viaAlias}\`)` : ""} ` +
                "via the bash tool is disabled to match. Ask the user before committing/pushing despite this setting.",
            );
          }
        }
      }

      // Hard-block broad staging when sensitive files are present.
      // This runs PRE-EXECUTION (before bash.execute) regardless of permission mode.
      if (gitShape.isBroadStage) {
        const stagingBlock = checkSensitiveStaging(bash.getCwd());
        if (stagingBlock.blocked) {
          return _prefixBlock("git-safety", stagingBlock.message);
        }
      }
      if (gitShape.isPush) {
        const gate = checkPushGate(gitSafetyKey);
        if (gate.blocked) {
          return _prefixBlock("git-safety", pushBlockedMessage(gate.failed));
        }
      }

      // G1 follow-up: a raw bash `git commit` must not bypass the LSP commit
      // gate that the `git_commit` tool + auto-commit backstop enforce. Derive
      // the to-be-committed paths from git state and block (pre-exec, never run
      // the commit) if any staged source file has a severity-1 LSP error. The
      // gate is fail-OPEN (LSP slow/down → allow) and self-disables under
      // MUONROI_COMMIT_GATE=0 / the unit-test suite. Lazy-import keeps the
      // LSP-heavy module off the hot bash path (mirrors git_commit below).
      if (gitShape.isCommit) {
        const { gateStagedPaths, isCommitGateEnabled, pathsForCommitGate } = await import(
          "../orchestrator/auto-commit.js"
        );
        if (isCommitGateEnabled()) {
          const commitCwd = bash.getCwd();
          const paths = await pathsForCommitGate(commitCwd, {
            broadAdd: gitShape.isBroadAdd,
            commitAll: gitShape.isCommitAll,
          });
          if (paths.length > 0) {
            const gate = await gateStagedPaths(commitCwd, paths);
            if (!gate.ok) {
              return _prefixBlock("git-safety", commitBlockedMessage(gate.summary));
            }
          }
        }
      }

      const isLongRunning = (c: string): boolean => {
        const lower = c.toLowerCase().trim();
        return (
          /\bvite\b/.test(lower) ||
          /\bnodemon\b/.test(lower) ||
          /\bwebpack-dev-server\b/.test(lower) ||
          /\bnext\s+dev\b/.test(lower) ||
          /\bwatch\b/.test(lower) ||
          /--watch\b/.test(lower) ||
          /\b-w\b/.test(lower) ||
          /\bdev-server\b/.test(lower) ||
          /\blive-server\b/.test(lower) ||
          /\bhttp-server\b/.test(lower)
        );
      };

      if (input.background || isLongRunning(cmd)) {
        const result = await bash.startBackground(input.command);
        return formatResult(result);
      }
      // A long foreground sleep while background jobs run is the agent waiting
      // on them — which keeps the turn "running" and locks the user out for the
      // whole job. Refuse it; the job's completion wakes the agent instead.
      const sleepSeconds = longestSleepSeconds(cmd);
      if (sleepSeconds >= SLEEP_POLL_THRESHOLD_SECONDS && (await bash.hasRunningBackgroundJobs())) {
        return formatResult({ success: false, output: sleepPollRefusal(sleepSeconds) });
      }
      // 3-3: compute canonical form BEFORE running so we can attach an
      // inline reminder if it matches the previous bash call.
      const canonical = cmd ? canonicalizeBashCommand(cmd) : "";
      const entry = repeatState.get(repeatKey) ?? { lastCanonical: null, lastRunId: null };
      const repeatedIntent = canonical !== "" && canonical === entry.lastCanonical && entry.lastRunId !== null;
      const prevRunId = entry.lastRunId;

      const result = await runBashWithEffectGuard(bash, input.command, input.timeout ?? 30000, extra?.abortSignal);
      const formatted = formatResult(result);

      // Record verification outcome so a later `git push` can be gated on it.
      recordCommandOutcome(gitSafetyKey, canonical, result.success);

      // Update last-canonical state AFTER we compared, so the current call's
      // runId becomes the comparison target for the next one. Session-scoped
      // map persists across createBuiltinTools() rebuilds (Phase 4R).
      if (result.bashRunId) {
        repeatState.set(repeatKey, { lastCanonical: canonical, lastRunId: result.bashRunId });
      }

      // 3-3 reminder rides on the tool_result of the SECOND+ same-intent
      // bash call. Cheap models that ignored the system-prompt rule still
      // see this — it's inside the actual tool output they parse next step.
      const reminder = repeatedIntent
        ? `\n\n[reminder: previous bash call had the same canonical intent and produced run_id=${prevRunId}. Use bash_output_get("${prevRunId}", mode=tail|head|grep|lines) to slice the cached output instead of re-running.]`
        : "";

      // 3-1: ALWAYS surface the run_id footer (no truncation gate). The
      // previous gate created a Catch-22 — when the model used `| tail -40`,
      // exec captured only ~5K, totalChars stayed below MAX_TOOL_OUTPUT_CHARS,
      // footer never fired, model never learned the cache existed. The hint
      // about bash_output_get fires only when the cached output is large
      // enough that slicing makes sense (>= 4K chars).
      if (result.bashRunId) {
        const chars = result.bashTotalChars ?? 0;
        const hint =
          chars >= 4_000
            ? ` — ${chars} chars cached; use bash_output_get(run_id, mode=tail|head|grep|lines) to re-query`
            : "";
        return `${formatted}\n\n[bash_run_id: ${result.bashRunId}${hint}]${reminder}`;
      }
      return formatted;
    },
  });

  // bash_output_get — re-query the cached full output of a previous bash run.
  // Designed to break the "re-run vitest with different pipe flags" loop by
  // letting the agent slice cached stdout/stderr instead.
  tools.bash_output_get = dynamicTool({
    description:
      "Re-query the full (untruncated, ANSI-stripped) stdout+stderr of a previous bash run by run_id. " +
      "Use this INSTEAD of re-running the same command with different `| tail`, `| head`, `| grep`, or " +
      "`> file` flags. Modes: head/tail (first/last N lines), grep (regex filter), lines (range N-M).",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID from a previous bash result, e.g. 'bash-42'" },
        mode: { type: "string", enum: ["head", "tail", "grep", "lines", "full"] },
        lines: { type: "number", description: "Line count for head/tail (default 50)" },
        pattern: { type: "string", description: "Regex pattern for grep mode" },
        range: { type: "string", description: "Line range 'N-M' (1-based, inclusive) for lines mode" },
        case_insensitive: { type: "boolean", description: "Case-insensitive grep (default false)" },
      },
      required: ["run_id", "mode"],
    }),
    execute: async (input: any) => {
      const record = getBashRun(input.run_id);
      if (!record) {
        // Actionable recovery, not a dead end — see bashOutputNotFoundMessage.
        return truncateOutput(bashOutputNotFoundMessage(input.run_id));
      }
      const slice = sliceBashOutput(record, {
        mode: input.mode as BashSliceMode,
        lines: input.lines,
        pattern: input.pattern,
        range: input.range,
        caseInsensitive: input.case_insensitive,
      });
      if (!slice.ok) {
        return truncateOutput(`ERROR: ${slice.text}`);
      }
      const meta = `[${input.run_id} mode=${input.mode} total_lines=${slice.totalLines}${
        slice.matchedLines !== undefined ? ` matched=${slice.matchedLines}` : ""
      } exit=${record.exitCode ?? "?"}]`;
      return truncateOutput(`${meta}\n${slice.text}`);
    },
  });

  // process_logs
  tools.process_logs = dynamicTool({
    description: "View recent output from a background process by ID.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        id: { type: "number", description: "Background process ID" },
        tail: { type: "number", description: "Number of lines to show (default: 50)" },
      },
      required: ["id"],
    }),
    execute: async (input: any) => {
      const result = await bash.getProcessLogs(input.id, input.tail);
      return formatResult(result);
    },
  });

  // process_stop
  tools.process_stop = dynamicTool({
    description:
      "Stop a background process owned by this tool instance. Use its native ID from process_list, not an OS PID.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        id: { type: "number", description: "Owned native background ID from process_list (not an OS PID)" },
      },
      required: ["id"],
    }),
    execute: async (input: any) => {
      const result = await bash.stopProcess(input.id);
      return formatResult(result);
    },
  });

  // process_list
  tools.process_list = dynamicTool({
    description: "List all background processes with status and uptime.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
    }),
    execute: async () => {
      const result = bash.listProcesses();
      return formatResult(result);
    },
  });

  // Agent mode gets write/edit/task/delegate tools
  if (mode === "agent" || opts?.executionRole === "orchestrator") {
    // Capture delegation functions for auto-routing logic below
    const runTaskFn = opts?.runTask;
    const runDelegationFn = opts?.runDelegation;
    // write_file
    tools.write_file = dynamicTool({
      description:
        "Create a new file or overwrite an existing file with full content. SAFETY: overwriting requires read_file on the current content in this tool run. Earlier-turn reads may not be retained after the tool run restarts; read again if requested. New-file creation does not require a prior read.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to write" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["file_path", "content"],
      }),
      execute: async (input: any) => {
        if (!input?.file_path?.trim() || input.content === undefined || input.content === null) {
          return {
            success: false,
            output:
              'BLOCKED (empty-write_file): write_file requires non-empty "file_path" and "content". ' +
              'Example: {"file_path":"src/foo.ts","content":"export const x = 1;\\n"}',
          };
        }
        const scope = boundWriteScope;
        const apply = (current = scope) =>
          writeFile(input.file_path, input.content, bash.getCwd(), fileTracker, current);
        const result = opts?.runScopedWrite ? await opts.runScopedWrite(apply) : await apply();
        return {
          success: result.success,
          output: truncateOutput(result.output ?? ""),
          diff: result.diff,
          lspDiagnostics: result.lspDiagnostics,
          ...(result.writeScopeVersion !== undefined ? { writeScopeVersion: result.writeScopeVersion } : {}),
        };
      },
    });

    // edit_file
    tools.edit_file = dynamicTool({
      description:
        "Replace a unique string in a file with new content. Set dry_run=true to preview the validated diff without writing or updating the commit ledger; applying revalidates the same guards. The old_string must appear exactly once. MANDATORY: read_file must load current content in this tool run. Earlier-turn reads may require refreshing. Batch reads when editing multiple files. Re-read if the file changed on disk.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to edit" },
          old_string: { type: "string", description: "The exact string to find (must be unique)" },
          new_string: { type: "string", description: "The replacement string" },
          dry_run: {
            type: "boolean",
            description: "Preview only; no file write, commit-ledger update or LSP synchronization.",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      }),
      execute: async (input: any) => {
        if (
          !input?.file_path?.trim() ||
          input.old_string === undefined ||
          input.old_string === null ||
          input.new_string === undefined ||
          input.new_string === null
        ) {
          return {
            success: false,
            output:
              "BLOCKED (empty-edit_file): edit_file requires file_path, old_string, and new_string. " +
              'Example: {"file_path":"src/foo.ts","old_string":"a","new_string":"b"}',
          };
        }
        if (input.dry_run !== undefined && typeof input.dry_run !== "boolean")
          return { success: false, output: "dry_run must be a boolean." };
        const scope = boundWriteScope;
        const apply = (current = scope) =>
          editFile(
            input.file_path,
            input.old_string,
            input.new_string,
            bash.getCwd(),
            fileTracker,
            input.dry_run === true,
            current,
          );
        const result = opts?.runScopedWrite ? await opts.runScopedWrite(apply) : await apply();
        return {
          success: result.success,
          output: truncateOutput(result.output ?? ""),
          diff: result.diff,
          lspDiagnostics: result.lspDiagnostics,
          ...(result.preview ? { preview: true } : {}),
          ...(result.writeScopeVersion !== undefined ? { writeScopeVersion: result.writeScopeVersion } : {}),
        };
      },
    });

    // git_commit — the agent commits its OWN work with a message IT writes.
    tools.git_commit = dynamicTool({
      description:
        "Commit the files you have created/edited so far, with a commit message YOU write. Use this to commit each " +
        "cohesive, working chunk the moment it is finished — and after EACH step of a multi-step plan — instead of " +
        "leaving everything for one commit at the end. message: a clear conventional subject describing WHAT changed " +
        "(e.g. 'feat(auth): add token refresh'), optionally followed by a body — NOT a restatement of the request. " +
        "Only files you wrote via write_file/edit_file in this tool run are staged (excluded sensitive paths and CLI artifacts are omitted, and the " +
        "'Coding by - Muonroi-CLI' attribution line is appended automatically). No-op if none of your written files " +
        "have uncommitted changes.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Conventional commit subject (optionally + body) describing what changed, authored by you.",
          },
        },
        required: ["message"],
      }),
      execute: async (input: any) => {
        const message = typeof input?.message === "string" ? input.message.trim() : "";
        if (message.length < 3) {
          return { success: false, output: "git_commit requires a non-empty commit message." };
        }
        const written = fileTracker.writtenPaths();
        if (written.length === 0) {
          // The ledger being empty says nothing about the repository — say so,
          // report the repo's real state, and name the route that works.
          return {
            success: false,
            output: emptyLedgerRefusalMessage(await countUncommittedChanges(bash.getCwd())),
          };
        }
        try {
          const { commitSpecificPaths } = await import("../orchestrator/auto-commit.js");
          const result = await commitSpecificPaths(bash.getCwd(), written, message);
          if (!result.committed) {
            if (result.reason === "not-a-repo") {
              return {
                success: false,
                committed: false,
                skipped: true,
                reason: result.reason,
                output:
                  "No commit was created: the current directory is not a Git worktree (not-a-repo). " +
                  "Continue the task without a commit. Do not retry git_commit until the Git workspace changes; " +
                  "do not initialize a repository unless the user asks.",
              };
            }
            // G1: when the LSP quality gate blocked the commit, surface the
            // per-file errors so the agent can fix them and call git_commit again.
            // Tell the agent to FIX the errors — do NOT advertise the bypass
            // env here (that is a USER escape hatch; surfacing it to the agent
            // just invites it to circumvent the gate instead of fixing).
            const detail =
              result.reason === "lsp-errors"
                ? `\nStaged files have errors — fix them and call git_commit again:\n${result.detail ?? ""}`
                : result.reason === "outside-run-root"
                  ? // Containment refusal — tell the agent WHY and what to do. Do NOT
                    // advertise the MUONROI_COMMIT_SCOPE bypass (a user escape hatch).
                    `\n${result.detail ?? ""}\nYour shell cwd left the directory this run was launched in. ` +
                    `\`cd\` back into it before writing files or committing.`
                  : "";
            return { success: false, output: `No commit made (${result.reason}).${detail}` };
          }
          return { success: true, output: `Committed ${result.fileCount} file(s) → ${result.sha}` };
        } catch (e) {
          return { success: false, output: `git_commit failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    });

    // task
    if (opts?.runTask) {
      tools.task = dynamicTool({
        description:
          "Launch a focused native sub-agent for edit/execute/verify work. In the interactive TUI it runs in the background by default, " +
          "so the main session can accept new messages. The launch receipt is not the completed result; completion arrives via notifications or delegation_read. " +
          "Do not poll or sleep while waiting. Set background=false to wait; an interim correlated worker question can return before completion when main input is required. " +
          "Headless callers retain foreground execution by default. Use delegate for read-only research/exploration. " +
          "Choose an explicit modelId from worker_models. Supply seven brief fields in prompt: role, scope/workspace, ground/input, question, exclusions, budget, return evidence.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Sub-agent type: general, explore, verify, computer, or a custom sub-agent name",
            },
            description: { type: "string", description: "Short description of the task" },
            prompt: { type: "string", description: "Detailed instructions for the sub-agent" },
            modelId: {
              type: "string",
              description: "Exact catalog model chosen by main from worker_models; no silent tier substitution.",
            },
            reasoningEffort: {
              type: "string",
              enum: ["low", "medium", "high", "xhigh"],
              description: "Optional supported reasoning effort; omitted uses the worker model default.",
            },
            reviewOf: {
              type: "object",
              properties: { jobId: { type: "string" }, resultVersion: { type: "string" } },
              required: ["jobId", "resultVersion"],
              additionalProperties: false,
              description:
                "Fresh independent verification of this exact successful saved implementation result. Forces verify role, read/test-only tools and durable job.",
            },
            allowedMcpTools: {
              type: "array",
              items: { type: "string" },
              description:
                "Exact optional MCP grants from worker_capabilities for an agent-mode worker. Not supported by explore, verify-detect or reviewOf; use task/general for MCP work. Dispatch/council/workflow tools cannot be granted.",
            },
            cwd: {
              type: "string",
              description:
                "Execution workspace; set explicitly for work in another repository. Defaults to the current shell directory.",
            },
            writeScope: {
              type: "array",
              maxItems: 64,
              items: { type: "string" },
              description:
                "Host-enforced task write paths relative to cwd: exact files or recursive directories ending in '/'. [] allows no workspace writes. Scoped workers use native file tools plus run_gate (the verify recipe's build/test gates by id; out-of-scope effects are detected after the run, not prevented); shell/MCP/LSP are not granted. Set for every bounded editing task. Omitted means legacy shared execution, not isolation.",
            },
            background: {
              type: "boolean",
              description:
                "Run independently and return a job receipt. Defaults true in the interactive TUI, false headless. False explicitly waits for completion.",
            },
            maxToolRounds: {
              type: "number",
              description:
                "Optional maximum tool execution rounds. For research/explore use delegate + higher values (default 60); low values (≤20) only for task.",
            },
          },
          required: ["agent", "description", "prompt", ...(opts?.executionRole === "orchestrator" ? ["modelId"] : [])],
        }),
        execute: async (input: any) => {
          if (mode !== "agent" && input.agent !== "explore") {
            return "worker_role_refused: ask/plan mode permits read-only explore workers only. Switch to agent mode for implementation.";
          }
          // Research retains the read-only delegate route. Native task workers
          // use their own launch contract rather than widening delegate access.
          const isLongResearch = input.agent === "explore";

          const useBackgroundResearch =
            input.background !== false &&
            isLongResearch &&
            runDelegationFn &&
            (opts?.executionRole !== "orchestrator" || isTuiActive() || input.background === true);
          const executor = useBackgroundResearch ? runDelegationFn : runTaskFn;

          if (!executor) {
            return { success: false, output: "No delegation executor available." };
          }

          const result = await executor({
            agent: input.agent,
            description: input.description,
            prompt: input.prompt,
            reviewOf: input.reviewOf,
            modelId: input.modelId,
            reasoningEffort: input.reasoningEffort,
            allowedMcpTools: input.allowedMcpTools,
            ...(input.writeScope !== undefined ? { writeScope: input.writeScope } : {}),
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            maxToolRounds: input.maxToolRounds,
            ...(input.background !== undefined
              ? { background: input.background }
              : isTuiActive()
                ? { background: true }
                : {}),
          });
          return formatResult(result);
        },
      });
    }

    // consult_parent_session
    if (opts?.consultParentSession) {
      const consultParentSession = opts.consultParentSession;
      tools.consult_parent_session = dynamicTool({
        description:
          "Consult the parent session for supervision or guidance when stuck, when needing clarification on the overall goal, or when encountering critical errors. ONLY available in sub-sessions.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The specific question or issue you need the parent session to advise on.",
            },
          },
          required: ["question"],
        }),
        execute: async (input: any) => {
          const result = await consultParentSession(input.question);
          return result;
        },
      });
    }

    // delegate
    if (opts?.runDelegation) {
      const runDelegation = opts.runDelegation;
      tools.delegate = dynamicTool({
        description:
          "Launch a read-only BACKGROUND research agent (usually 'explore') that runs independently in a separate process. " +
          "Main decides whether independent background research will help. Give a concrete scope, exclusions and verification; avoid duplicating an active worker's assignment unless independent review is intentional. " +
          "Main session continues working immediately. Results are delivered later via notifications or delegation_read. " +
          "This is the PREFERRED tool over 'task' for explore/research to avoid blocking and timeouts.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            agent: { type: "string", description: "Sub-agent type (usually 'explore')" },
            description: { type: "string", description: "Short description of the research task" },
            prompt: { type: "string", description: "Detailed research instructions" },
            cwd: { type: "string", description: "Explicit worker workspace; never inferred from query text." },
            modelId: { type: "string", description: "Exact enabled authenticated catalog model from worker_models." },
            reasoningEffort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
            allowedMcpTools: {
              type: "array",
              items: { type: "string" },
              description:
                "Unsupported for read-only explore: nonempty grants are refused. For MCP work use task with agent=general and exact grants.",
            },
            maxToolRounds: {
              type: "number",
              description:
                "Optional maximum tool execution rounds (high values like 60+ expected for background research; do not use task for high values).",
            },
          },
          required: ["agent", "description", "prompt", ...(opts?.executionRole === "orchestrator" ? ["modelId"] : [])],
        }),
        execute: async (input: any) => {
          const result = await runDelegation({
            agent: input.agent,
            description: input.description,
            prompt: input.prompt,
            cwd: input.cwd,
            modelId: input.modelId,
            reasoningEffort: input.reasoningEffort,
            allowedMcpTools: input.allowedMcpTools,
            maxToolRounds: input.maxToolRounds,
          });
          return formatResult(result);
        },
      });
    }

    // delegation_read
    if (opts?.sendDelegation) {
      tools.delegation_send = dynamicTool({
        description:
          "Send a proactive instruction to an owned running worker: omit replyTo; no prior question is required. Include writeScope to atomically narrow/widen file permissions before the next write, including when replying to the exact pending worker question messageId. Scope decisions do not undo previous writes or change workspace/model/role/tool grants/approvals. Message text arrives at the next safe model step; headless correlated replies host-wait the next question or terminal result. Blank replyTo means instruction. No polling, ACK or acceptance.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            id: { type: "string" },
            message: { type: "string", minLength: 1, maxLength: 8000 },
            writeScope: {
              type: "array",
              maxItems: 64,
              items: { type: "string" },
              description:
                "Optional explicit owner scope decision for an already file-scoped worker: replaces current paths, [] revokes writes. Applies before the next write, including with a correlated reply. Does not change workspace/tools/approvals or undo earlier writes.",
            },
            replyTo: {
              type: "string",
              description:
                "Omit for proactive instructions. Only a reply uses the exact pending worker question messageId; do not invent correlation.",
            },
          },
          required: ["id", "message"],
          additionalProperties: false,
        }),
        execute: async (input: any, context: any) =>
          formatResult(
            await opts.sendDelegation!(
              input.id,
              input.message,
              input.replyTo,
              context?.toolCallId ?? "",
              context?.abortSignal,
              ...(input.writeScope !== undefined ? [input.writeScope] : []),
            ),
          ),
      });
    }
    if (opts?.readDelegation) {
      const readDelegation = opts.readDelegation;
      tools.delegation_read = dynamicTool({
        description:
          "Retrieve a completed background delegation result by ID, with execution/delivery/acknowledgement states. A completion notice already carries the result inline (or its first part); read only the remainder (offset/maxChars page the saved result), a raw tool artifact (toolCallId) or a council dossier file. Main must call delegation_ack with the jobId and resultVersion AFTER processing the evidence; reading alone does not ACK or verify it. Helpers forward the reference to main.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            id: { type: "string", description: "Delegation ID to read" },
            toolCallId: {
              type: "string",
              description:
                "Owned raw toolCallId, or report:<file> from the council dossier selectors (start with report:findings.json, then participants/evidence/reproduction). Version checked and paginated; no arbitrary paths.",
            },
            resultVersion: {
              type: "string",
              description: "Expected current saved result version for tool artifact retrieval.",
            },
            offset: { type: "integer", minimum: 0 },
            maxChars: { type: "integer", minimum: 256, maximum: 24000 },
          },
          required: ["id"],
        }),
        execute: async (input: any) => {
          // Without toolCallId, offset/maxChars page the saved result itself
          // (they were silently ignored before: session 4edc02516a92 asked for
          // maxChars=3000 and received 9-11k chars).
          const paged = input.offset !== undefined || input.maxChars !== undefined;
          const result = await readDelegation(
            input.id,
            input.toolCallId || paged
              ? {
                  ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
                  resultVersion: input.resultVersion,
                  offset: input.offset,
                  maxChars: input.maxChars,
                }
              : undefined,
          );
          return formatResult(result);
        },
      });
    }

    if (opts?.acknowledgeDelegation) {
      const acknowledge = opts.acknowledgeDelegation;
      tools.delegation_ack = dynamicTool({
        description:
          "Acknowledge a delivered background result AFTER you have processed it. Supply its jobId and resultVersion from delegation_read or its completion notice. This records handling, not a claim that verification passed. A stale version is rejected.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            jobId: { type: "string" },
            resultVersion: { type: "string" },
          },
          required: ["jobId", "resultVersion"],
        }),
        execute: async (input: any) => formatResult(await acknowledge(input.jobId, input.resultVersion)),
      });
    }

    if (opts?.acceptDelegation) {
      tools.delegation_accept = dynamicTool({
        description:
          "Accept a saved worker deliverable after a distinct current delivered reviewOf with strict JSON pass, matching host evidence and unchanged source. Documents may use successful read_file/grep inspection (static); runnable tests establish executed review. Any failed verification_run blocks acceptance. ACK and council advice do not accept work.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            jobId: { type: "string" },
            resultVersion: { type: "string" },
            reviewJobId: { type: "string" },
            reviewResultVersion: { type: "string" },
          },
          required: ["jobId", "resultVersion", "reviewJobId", "reviewResultVersion"],
          additionalProperties: false,
        }),
        execute: async (input: any) => formatResult(await opts.acceptDelegation!(input)),
      });
    }

    // delegation_list
    if (opts?.listDelegations) {
      const listDelegations = opts.listDelegations;
      tools.delegation_list = dynamicTool({
        description:
          "List background delegations with separately labelled execution, delivery and acknowledgement states. Complete execution can still have pending delivery or ACK; it does not mean a worker is running.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
        }),
        execute: async () => {
          const result = await listDelegations();
          return formatResult(result);
        },
      });
    }

    // delegation_kill
    if (opts?.killDelegation) {
      const killDelegation = opts.killDelegation;
      tools.delegation_kill = dynamicTool({
        description: "Terminate a running background delegation/subagent by ID.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            id: { type: "string", description: "Delegation ID to terminate" },
          },
          required: ["id"],
        }),
        execute: async (input: any) => {
          const result = await killDelegation(input.id);
          return formatResult(result);
        },
      });
    }
  }

  // Read-only modes also need recall and retrieval for their own compacted evidence.
  // ee_query — semantic recall over the Experience Engine brain. This is the
  // in-CLI counterpart of the MCP `ee.query` tool (src/mcp/ee-tools.ts):
  // without it, the Agent Operating Contract + checkpoint reminders instruct
  // the agent to "Use ee_query tool with 'tool-artifact id=XXX'" to rehydrate
  // compaction-elided tool outputs, but the in-CLI agent had no such tool in
  // its loop (session d95113d3be09: the anti-mù rehydrate path was a dead
  // reference). Exact artifact recovery is local only; semantic remote recall
  // cannot prove that a lesson is the requested tool result.
  // Routing (tool-artifact lookup vs /api/recall) and scope (task/shell cwd,
  // strict proof) are host-resolved, so the description names inputs only.
  tools.ee_query = dynamicTool({
    description:
      "Recall learned lessons, warnings and task checkpoints from the Experience Engine; hits carry `[id col]` handles " +
      "for ee_feedback. Scope defaults to this task's repository; pass cwd or project once for another repo. " +
      "action=projects lists slugs, scope/reset inspect or clear the binding, health probes reachability. " +
      "Lessons are not evidence and never replace a tool result.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        action: { type: "string", enum: ["recall", "scope", "projects", "reset", "health"] },
        query: { type: "string" },
        project: { type: "string", description: "Concrete EE project slug" },
        cwd: { type: "string", description: "Absolute repository path" },
        offset: { type: "integer", minimum: 0, description: "projects page offset" },
        maxChars: { type: "number", description: "500-20000, default 6000" },
      },
    }),
    execute: async (input: any) => {
      taskContext.alignCwd(bash.getCwd());
      const action = input?.action ?? "recall";
      if (action === "health") {
        // Former standalone ee_health (25 calls lifetime, none after 2026-10-19):
        // on demand here instead of a tool schema sent on every step.
        try {
          const { healthEE } = await import("../ee/search.js");
          return JSON.stringify({
            ...(await healthEE()),
            scope: taskContext.ee.scope(),
            lastRecall: taskContext.ee.lastRecall,
            note: "Health 200 proves reachability only, not recall readiness.",
          });
        } catch (e) {
          logger.file("warn", "ee", "Native EE health failed", { error: e instanceof Error ? e.message : String(e) });
          return `ERROR ee_unavailable: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (action === "scope")
        return JSON.stringify({ scope: taskContext.ee.scope(), lastRecall: taskContext.ee.lastRecall });
      if (action === "reset") {
        taskContext.ee.reset();
        return taskContext.ee.receipt();
      }
      if (action === "projects") {
        const { listEEProjects } = await import("../ee/search.js");
        return JSON.stringify(await listEEProjects(input?.offset));
      }
      if (action !== "recall") return "ERROR: action must be recall, scope, projects, reset or health";
      const query = typeof input?.query === "string" ? input.query.trim() : "";
      if (!query) {
        return 'ERROR: ee_query requires a non-empty "query" string (e.g. {"query":"tool-artifact id=abc123"}).';
      }
      try {
        if (isToolArtifactQuery(query)) {
          // Local-first (anti-mù durability): the compactor records each elided
          // output in-process by toolCallId. For an exact "tool-artifact id=X"
          // lookup this is the authoritative full content for THIS session and
          // works even when EE is down — the failure window long sessions hit.
          const { findArtifactByQuery, findArtifactByHint, findArtifactOnDisk } = await import(
            "../ee/artifact-cache.js"
          );
          // Lived-experience telemetry: record where the rehydrate came from so
          // a "cảm nhận trong CLI" question (and the measure-first instrumentation)
          // sees cache vs disk vs ee vs needed-but-unavailable.
          const { recordRehydration } = await import("../orchestrator/session-experience.js");
          const mem = findArtifactByQuery(query);
          const local = mem ?? (await findArtifactOnDisk(query));
          if (local) {
            const src = mem ? "in-session cache" : "local disk cache";
            recordRehydration(mem ? "cache" : "disk");
            return truncateOutput(
              `[tool-artifact id=${local.toolCallId} tool=${local.toolName} — rehydrated from ${src}]\n${local.content}`,
            );
          }
          // B (cheap-model anti-mù) — the exact id missed locally. Cheap models
          // often pass FILE PATHS instead of the opaque toolCallId, which
          // extractArtifactId can't parse. Try a path match against the local
          // cache before the EE round-trip so a botched id still recovers.
          const fuzzy = findArtifactByHint(query);
          if (fuzzy) {
            recordRehydration("cache");
            return truncateOutput(
              `[tool-artifact id=${fuzzy.toolCallId} tool=${fuzzy.toolName} — rehydrated by path match; your id was malformed (pass the exact id from the "[… elided id=X …]" stub next time)]\n${fuzzy.content}`,
            );
          }
          // Semantic lesson search cannot establish an exact artifact identity.
          recordRehydration("unavailable");
          return "[tool-artifact — not found in local evidence] For a worker result use delegation_read({id: jobId, toolCallId, resultVersion}). A resultVersion or digest is not a toolCallId. Semantic EE lessons are not substitutes for tool results.";
        }
        // General recall → /api/recall (recallMode, [id col] index + surface).
        const { recallEE, formatRecallForAgent } = await import("../ee/search.js");
        let request: ReturnType<TaskContext["ee"]["request"]>;
        try {
          request = taskContext.ee.request(input ?? {});
        } catch (error) {
          logger.file("warn", "ee", "Invalid native recall scope", {
            error: error instanceof Error ? error.message : String(error),
          });
          return `ERROR invalid_scope: ${error instanceof Error ? error.message : String(error)}`;
        }
        const resp = await recallEE(query, {
          cwd: request.cwd,
          strictProject: true,
          sourceSession: opts?.sessionId,
          project: request.project,
        });
        if (resp === null) {
          taskContext.ee.complete(request, null, []);
          return "[ee_unavailable] The configured EE recall request returned no usable response. See file diagnostics for transport/timeout/configuration details. Continue using repository evidence; local tool artifacts remain available.";
        }
        const formatted = truncateOutput(
          formatRecallForAgent(resp, {
            query,
            ...(typeof input?.maxChars === "number" ? { maxChars: input.maxChars } : {}),
          }),
        );
        const visibleEntries = displayedRecallEntries(resp.entries, formatted);
        const receipt = taskContext.ee.complete(request, resp, visibleEntries);
        // Record recalled entries as pending feedback debt in the same in-process
        // ledger the native ee_feedback builtin clears, so an in-CLI active recall
        // accrues a verdict obligation exactly like the external MCP ee.query does
        // (mcp/ee-tools.ts). Layer 3 surfaces this debt as a reminder on the next
        // enriched turn; without it the in-CLI recall arm was write-only and
        // ee_feedback.clear() was a no-op.
        try {
          const { sessionRecallLedger, isRecallLedgerEnabled } = await import("../ee/recall-ledger.js");
          if (isRecallLedgerEnabled()) sessionRecallLedger.record(visibleEntries, query);
        } catch (err) {
          console.error(`[tools:ee_query] recall-ledger record failed: ${(err as Error)?.message}`);
        }
        // Compact ranked `[id col]` index, not a JSON dump — the recallMode text
        // is ~30k (wide net), so JSON.stringify wasted the budget on escaping.
        return receipt ? `${receipt}\n${formatted}` : formatted;
      } catch (err) {
        console.error(`[tools:ee_query] EE recall failed: ${(err as Error)?.message}`, {
          query: query.slice(0, 120),
          stack: (err as Error)?.stack?.split("\n").slice(0, 3),
        });
        return `[ee_unavailable] EE recall threw: ${(err as Error)?.message ?? String(err)}. Proceed without EE recall.`;
      }
    },
  });

  tools.retrieve_tool_result = dynamicTool({
    description:
      "Retrieve the full output of a previous tool call by its tool_call_id. " +
      "Searches exact local cache, disk cache and database history in the current session family; never substitutes semantic EE lessons. " +
      "If the ID was lost or shortened after compaction, use view=index without tool_call_id to discover bounded local references; query is a literal tool-name, ID or input-path filter. Page with chunk_index. Copy the complete returned ID for the next exact read; metadata candidates are not evidence contents. A miss is not proof of cache loss, and EE is not required. " +
      "For another worker use delegation_read({id: jobId, toolCallId, resultVersion}) from its host manifest, not its filesystem path. A resultVersion/digest is not a tool_call_id. Set view=arguments to read captured original arguments from the current session family only; this never executes them. Arguments default to 4000-character pages. Optional max_chars and chunk_index allow paginated retrieval.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        tool_call_id: {
          type: "string",
          description: "The complete, unshortened tool call ID. Required for result/arguments; omit for view=index.",
        },
        view: {
          type: "string",
          enum: ["result", "arguments", "index"],
          description:
            "Default result; arguments reads captured original parameters; index discovers local evidence references in the current session family without reading their content.",
        },
        query: {
          type: "string",
          maxLength: 256,
          description:
            "Optional literal tool-name, ID or captured input-path filter for view=index. Empty lists recent references.",
        },
        max_chars: {
          type: "number",
          description: "Optional character limit for the returned chunk (useful for very large outputs).",
        },
        chunk_index: {
          type: "number",
          description: "Optional chunk index if splitting the output by max_chars (0-based, default 0).",
        },
      },
      anyOf: [{ required: ["tool_call_id"] }, { properties: { view: { const: "index" } }, required: ["view"] }],
    }),
    execute: async (input: any) => {
      if (input.view === "index") {
        if (input.chunk_index !== undefined && (!Number.isSafeInteger(input.chunk_index) || input.chunk_index < 0))
          return "ERROR: chunk_index must be a non-negative integer.";
        try {
          return JSON.stringify(
            await listToolEvidence(opts?.sessionId, { query: input.query, chunkIndex: input.chunk_index }),
          );
        } catch (err) {
          logger.file("warn", "storage", "Local evidence index unavailable", {
            error: err instanceof Error ? err.message : String(err),
          });
          return `ERROR: Local evidence index unavailable: ${err instanceof Error ? err.message : String(err)}. This does not establish that evidence was deleted.`;
        }
      }
      const toolCallId = typeof input.tool_call_id === "string" ? input.tool_call_id.trim() : "";
      if (!toolCallId) {
        return "ERROR: tool_call_id is required.";
      }
      const view = input.view ?? "result";
      if (view !== "result" && view !== "arguments") return "ERROR: view must be result or arguments.";
      const requestedMax = typeof input.max_chars === "number" ? input.max_chars : undefined;
      if (
        view === "arguments" &&
        requestedMax !== undefined &&
        (!Number.isSafeInteger(requestedMax) || requestedMax <= 0)
      )
        return "ERROR: max_chars must be a positive integer.";
      const maxChars = view === "arguments" ? Math.min(requestedMax ?? 4000, MAX_TOOL_OUTPUT_CHARS) : requestedMax;
      const chunkIndex = typeof input.chunk_index === "number" ? input.chunk_index : 0;
      if (view === "arguments" && (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0))
        return "ERROR: chunk_index must be a non-negative integer.";

      let content: string | null = null;
      let source = "";

      // Tier 1: LRU cache
      if (view === "result") {
        try {
          const { getArtifact } = await import("../ee/artifact-cache.js");
          const tier1 = getArtifact(toolCallId);
          if (tier1) {
            content = tier1.content;
            source = "Tier 1 LRU cache";
          }
        } catch (err) {
          console.error(`[tools:retrieve_tool_result] Tier 1 LRU check failed: ${(err as Error).message}`);
        }
      }

      // Tier 2: Disk cache
      if (view === "result" && !content) {
        try {
          const { findArtifactOnDisk } = await import("../ee/artifact-cache.js");
          const tier2 = await findArtifactOnDisk(`id=${toolCallId}`);
          if (tier2) {
            content = tier2.content;
            source = "Tier 2 disk cache";
          }
        } catch (err) {
          console.error(`[tools:retrieve_tool_result] Tier 2 disk check failed: ${(err as Error).message}`);
        }
      }

      // Tier 3: SQLite database
      if (!content && opts?.sessionId) {
        try {
          const { getSessionChain } = await import("../storage/index.js");
          const { getDatabase } = await import("../storage/db.js");
          const chain = getSessionChain(opts.sessionId);
          const db = getDatabase();
          for (let i = chain.length - 1; i >= 0; i--) {
            const row = db
              .prepare(
                view === "arguments"
                  ? `
                SELECT args_json AS output_json FROM tool_calls
                WHERE tool_call_id = ? AND session_id = ? LIMIT 1
              `
                  : `
                SELECT tr.output_json
                FROM tool_results tr
                JOIN tool_calls tc ON tc.id = tr.tool_call_row_id
                WHERE tc.tool_call_id = ? AND tc.session_id = ?
                LIMIT 1
              `,
              )
              .get(toolCallId, chain[i]) as { output_json: string } | undefined;

            if (row?.output_json) {
              const parsed = JSON.parse(row.output_json);
              if (parsed && typeof parsed === "object") {
                if (view === "arguments") {
                  if (carriesElidedArgsMarker(parsed))
                    return "ERROR: original arguments were not retained; the stored evidence contains only an elision marker. Do not replay it.";
                  content = JSON.stringify(parsed);
                } else if ("output" in parsed && typeof parsed.output === "string") {
                  content = parsed.output;
                } else if ("error" in parsed && typeof parsed.error === "string") {
                  content = `ERROR: ${parsed.error}`;
                } else {
                  content = JSON.stringify(parsed);
                }
              } else {
                content = String(parsed);
              }
              source = `Tier 3 SQLite database (session ${chain[i]})`;
              break;
            }
          }
        } catch (err) {
          logger.file("warn", "storage", "Tool evidence lookup failed", { toolCallId, view, error: err });
        }
      }

      if (content === null) {
        if (opts?.sessionId) {
          try {
            const candidates = await listToolEvidence(opts.sessionId, { prefix: toolCallId });
            const matches = candidates.entries.filter(
              (e) =>
                e.tool_call_id !== toolCallId && (view === "arguments" ? e.arguments_available : e.result_available),
            );
            if (matches.length)
              return `ERROR: Exact tool result/arguments not found for tool_call_id: ${toolCallId}. Matching local references still exist; do not infer cache loss. Copy a complete ID and retry the exact read; no candidate content was retrieved.\n${JSON.stringify({ ...candidates, entries: matches.map((e) => ({ ...e, retrieve: { ...e.retrieve, ...(view === "arguments" ? { view } : {}) } })) })}`;
          } catch (err) {
            logger.file("warn", "storage", "Missing tool evidence reference discovery failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (view === "arguments")
          return `ERROR: Original arguments not found for tool_call_id: ${toolCallId} in the current session family. No cache or remote fallback was used.`;
        return `ERROR: Tool result not found for tool_call_id: ${toolCallId} in local evidence. Discover complete local IDs with retrieve_tool_result({view:"index",query:"relevant path or tool name"}) before inferring lost evidence. For worker artifacts use delegation_read({id: jobId, toolCallId, resultVersion}) with the exact host manifest IDs. A resultVersion/digest is not a toolCallId. No semantic EE fallback was used.`;
      }

      const totalLength = content.length;
      if (maxChars !== undefined && maxChars > 0) {
        const totalChunks = Math.ceil(totalLength / maxChars);
        const start = chunkIndex * maxChars;
        const end = Math.min(start + maxChars, totalLength);
        if (start >= totalLength) {
          return `ERROR: chunk_index ${chunkIndex} is out of bounds. Total chunks available: ${totalChunks} (max_chars: ${maxChars}, total length: ${totalLength}).`;
        }
        const chunk = content.slice(start, end);
        return JSON.stringify(
          {
            tool_call_id: toolCallId,
            ...(view === "arguments" ? { view } : {}),
            source,
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            chunk_length: chunk.length,
            total_length: totalLength,
            content: chunk,
          },
          null,
          2,
        );
      }

      return JSON.stringify(
        {
          tool_call_id: toolCallId,
          source,
          total_length: totalLength,
          content,
        },
        null,
        2,
      );
    },
  });

  tools.search_session_history = dynamicTool({
    description:
      'Search the full message history across all sessions. Default query_mode=fts accepts SQLite FTS5 MATCH grammar: term* is a prefix search; bare * is invalid and never means browse all. Use query_mode=literal for a quoted phrase containing punctuation such as auto-edit; literal punctuation is not a match-all. In FTS expressions quote punctuated terms, e.g. "auto-edit" OR approval. ' +
      "Returns bounded excerpts with session/sequence references, not full transcripts. " +
      "Narrow the query for omitted field content; use next_offset to page through remaining matches.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "FTS5 MATCH expression query (e.g. 'compaction AND error' or 'content:Vitest').",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Match offset, starting at 0. Use next_offset for the next page.",
        },
        query_mode: {
          type: "string",
          enum: ["fts", "literal"],
          description:
            "fts (default) preserves MATCH operators; literal treats the entire query as a quoted phrase, not an operator expression.",
        },
      },
      required: ["query"],
    }),
    execute: async (input: any) => {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return "ERROR: query MATCH expression is required.";
      }
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) return "ERROR: offset must be a non-negative integer.";
      const queryMode = input.query_mode ?? "fts";
      if (queryMode !== "fts" && queryMode !== "literal") return "ERROR: query_mode must be fts or literal.";
      if (queryMode === "fts" && /^\*+$/.test(query))
        return "ERROR unsupported_fts_wildcard: bare * is not a valid SQLite FTS5 query and does not mean browse all sessions. Supply a word or term* prefix; use query_mode=literal for text containing punctuation. No search was executed.";
      const matchQuery = queryMode === "literal" ? `"${query.replace(/"/g, '""')}"` : query;
      try {
        const { getDatabase } = await import("../storage/db.js");
        const db = getDatabase();
        // Wrap FTS search query execution in try-catch to prevent malformed FTS syntax crashes (fixing GAP-03)
        const rows = db
          .prepare(`
            SELECT session_id, seq, role, tool_name, content, tool_args, tool_output
            FROM session_history_fts
            WHERE session_history_fts MATCH ?
            ORDER BY rank
            LIMIT 50 OFFSET ?
          `)
          .all(matchQuery, offset) as Array<{
          session_id: string;
          seq: number;
          role: string;
          tool_name: string | null;
          content: string | null;
          tool_args: string | null;
          tool_output: string | null;
        }>;

        if (rows.length === 0) {
          return `No session history matched the query: "${query.slice(0, 512)}${query.length > 512 ? "… [query truncated]" : ""}"`;
        }

        const results = rows.map((row) => {
          const truncatedFields: Record<string, number> = {};
          const excerpt = (field: string, value: string | null) => {
            if (value == null) return undefined;
            const fieldLimit = Math.min(512, Math.floor(MAX_TOOL_OUTPUT_CHARS / 64));
            if (value.length <= fieldLimit) return value;
            truncatedFields[field] = value.length;
            const head = Math.floor(fieldLimit * 0.75);
            return `${value.slice(0, head)}\n[excerpt; ${value.length} total characters]\n${value.slice(-(fieldLimit - head))}`;
          };
          return {
            session_id: row.session_id,
            seq: row.seq,
            role: row.role,
            tool_name: excerpt("tool_name", row.tool_name),
            content: excerpt("content", row.content),
            tool_args: excerpt("tool_args", row.tool_args),
            tool_output: excerpt("tool_output", row.tool_output),
            truncated_fields: truncatedFields,
          };
        });
        const serialize = () =>
          JSON.stringify(
            {
              query: query.slice(0, 512),
              query_truncated: query.length > 512,
              query_mode: queryMode,
              match_count: rows.length,
              returned_count: results.length,
              truncated:
                results.length < rows.length || results.some((r) => Object.keys(r.truncated_fields).length > 0),
              next_offset: results.length < rows.length || rows.length === 50 ? offset + results.length : null,
              results,
            },
            null,
            2,
          );
        let output = serialize();
        while (output.length > MAX_TOOL_OUTPUT_CHARS && results.length > 0) {
          results.pop();
          output = serialize();
        }
        return output;
      } catch (err) {
        logger.file("warn", "storage", "Session history search failed", { error: err });
        return `ERROR: FTS MATCH query failed: ${(err as Error).message}. Quote punctuated terms (e.g. "auto-edit") in FTS expressions, or use query_mode="literal" for a literal phrase.`;
      }
    },
  });

  if (mode === "agent" || opts?.executionRole === "orchestrator") {
    // Native muonroi-tools builtins — ee_health, ee_feedback, usage_forensics,
    // lsp_query, setup_guide, selfverify_*. These run IN-PROCESS; the CLI no
    // longer self-spawns itself as an MCP server to expose them to its own inner
    // agent (that self-spawn cold-started 2-3.5s and overran the build deadline,
    // and a seed-time bug once persisted a crashing vitest-worker command). The
    // muonroi-tools MCP server stays only for EXTERNAL agents. See native-tools.ts.
    registerNativeMuonroiTools(tools, { cwd: bash.getCwd(), getCwd: () => bash.getCwd(), eeContext: taskContext.ee });

    registerFlowWorkflowTools(tools, {
      cwd: bash.getCwd(),
      sessionModelId: opts?.modelId ?? "unknown",
      sessionId: opts?.sessionId,
      planReviewBudget: opts?.planReviewBudget,
      depth: opts?.depthTier ?? "standard",
      executionRole: opts?.executionRole,
      runTask: opts?.runTask,
      runDebate: opts?.runDebate,
      startPlanReview: opts?.startPlanReview,
      readPlanReview: opts?.readPlanReview,
    });
  }

  // Feature B2 — agent-callable entry into /ideal product-loop mode. Registered
  // only when the orchestrator wired an `enterIdeal` callback AND the flag is on.
  // The tool records a pending request; the top-level loop is dispatched after the
  // current turn's tool phase completes (a tool cannot stream the loop itself).
  const enterIdeal = opts?.enterIdeal;
  if (enterIdeal && isIdealToolEntryEnabled()) {
    tools.enter_ideal = dynamicTool({
      description:
        "Enter /ideal product-loop mode to plan+build the given idea; inherits the current conversation as context. " +
        "Use when the user has agreed to start building what was discussed. Records the request and hands off to the " +
        "product loop after this turn — do not call other tools expecting to continue the current turn afterward.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          idea: {
            type: "string",
            description: "The consolidated goal to build, phrased as a concrete product/feature request.",
          },
        },
        required: ["idea"],
      }),
      execute: async (input: any) => {
        const idea = typeof input?.idea === "string" ? input.idea.trim() : "";
        if (!idea) {
          return "ERROR: enter_ideal requires a non-empty `idea` describing what to build.";
        }
        enterIdeal(idea);
        return `Entering /ideal to build: ${idea}`;
      },
    });
  }

  // Vision proxy tools — only for text-only models (DeepSeek, etc.)
  if (opts?.modelId && needsVisionProxy(opts.modelId)) {
    const cwd = bash.getCwd();

    tools.analyze_image = dynamicTool({
      description:
        "Inspect an image and receive a <vision-observation> block — treat the result as your direct sight. " +
        "Use IMMEDIATELY when you encounter any image file (.png, .jpg, .gif, .webp, .svg, etc.) " +
        "or when the user references an image. Do not guess visual content. " +
        "Accepts file paths, data URIs, or base64 strings. " +
        "Optionally provide a question to focus the analysis (OCR, layout, specific UI element). " +
        "If details remain unclear, call ask_vision_proxy or ask the user for another screenshot.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          image_source: {
            type: "string",
            description: "File path to the image, a data URI (data:image/...), or raw base64 string",
          },
          question: {
            type: "string",
            description:
              "Optional specific question to focus the analysis (e.g. 'what text is in this image?', 'describe the layout')",
          },
        },
        required: ["image_source"],
      }),
      execute: async (input: any) => {
        return analyzeImageFromSource(input.image_source, input.question, cwd, undefined, opts?.sessionId);
      },
    });

    tools.ask_vision_proxy = dynamicTool({
      description:
        "Ask a follow-up about an image you are viewing (cached ID) or analyze a new file with a specific question. " +
        "Returns a <vision-observation> — respond as if you saw it yourself. " +
        "Use when any detail in a prior observation is unclear: zoom on a region, read text, compare colors, verify UI state. " +
        "Reference a cached image by ID (from list_vision_cache) or provide a file path for a new image.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Your specific question about the image",
          },
          image_id_or_path: {
            type: "string",
            description:
              "Cached image ID (e.g. img_1) OR a file path to a new image. If omitted, uses the most recent image.",
          },
        },
        required: ["question"],
      }),
      execute: async (input: any) => {
        return askVisionProxy(input.question, input.image_id_or_path, cwd, undefined, opts?.sessionId);
      },
    });

    tools.vision_done = dynamicTool({
      description:
        "Release a vision sub-session when you no longer need to look at its image(s). " +
        "While a session is open the image stays loaded and ask_vision_proxy answers follow-ups " +
        "from what it already saw — cheap and consistent. Call this ONCE you have finished " +
        "reasoning about the image (before your final answer, or when the user moves on), " +
        "so the image bytes are freed. Omit vision_session_id to close the most recent session.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          vision_session_id: {
            type: "string",
            description:
              "Session id from the <vision-observation> block (e.g. vs_1a2b3c4d). Defaults to the most recent.",
          },
        },
      }),
      execute: async (input: any) => {
        const id = input?.vision_session_id ?? mostRecentVisionSessionId();
        if (!id) return "No open vision session to close.";
        return closeVisionSessionAndCache(id);
      },
    });

    tools.list_vision_cache = dynamicTool({
      description:
        "List all cached images available for ask_vision_proxy queries. " +
        "Shows image IDs, sources, labels, and ages.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
      }),
      execute: async () => {
        const cached = listCachedImages();
        if (cached.length === 0) {
          return "No cached images. Use analyze_image to analyze an image file, or take a screenshot with browser_take_screenshot.";
        }
        const open = listOpenVisionSessions();
        const openBlock =
          open.length > 0
            ? `\n\nOpen vision sessions (follow-ups are free — no re-read):\n${open
                .map(
                  (s) =>
                    `${s.id}: ${s.imageCount} image(s) [${s.labels.join(", ")}], ${s.questionsAnswered} answered — close with vision_done`,
                )
                .join("\n")}`
            : "";
        return (
          cached
            .map((c) => `${c.id}: ${c.label} (${c.source}, ${c.age})${c.hasDescription ? " [analyzed]" : ""}`)
            .join("\n") + openBlock
        );
      },
    });
  }

  // todo_write — Claude-Code-style task list. Each call REPLACES the agent's
  // current todo snapshot; the orchestrator post-processes this tool's args
  // into a task_list_update StreamChunk that the UI renders as a sticky
  // checklist panel. Status flow: pending → in_progress → completed; only
  // ONE item should be in_progress at a time. Use this when the user asks
  // for a multi-step task (≥3 distinct steps) so progress is visible.
  tools.todo_write = dynamicTool({
    description:
      "Write the full current todo list. Replaces the previous list entirely on every call (no partial updates). Use when a user request resolves into ≥3 discrete steps so the UI can show progress. Mark exactly one item as in_progress at a time. Always emit the FULL list, not just the changed items.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "The full ordered list of todo items. Replaces any prior list. Keep order stable across updates so the UI doesn't reshuffle on every call.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id across updates (e.g. '1','2', or a slug)." },
              subject: { type: "string", description: "Short imperative title shown in the list." },
              activeForm: {
                type: "string",
                description:
                  "Present-continuous form shown while in_progress (e.g. 'Reading files'). Falls back to subject when absent.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Item status. Only ONE item should be in_progress at any time.",
              },
            },
            required: ["id", "subject", "status"],
          },
        },
      },
      required: ["todos"],
    }),
    execute: async (input: any) => {
      const todos: Array<{ id?: unknown; subject?: unknown; activeForm?: unknown; status?: unknown }> = Array.isArray(
        input?.todos,
      )
        ? input.todos
        : [];
      const counts = { completed: 0, inProgress: 0, pending: 0, total: todos.length };
      for (const t of todos) {
        if (t.status === "completed") counts.completed++;
        else if (t.status === "in_progress") counts.inProgress++;
        else counts.pending++;
      }
      return `Tracking ${counts.total} todo${counts.total !== 1 ? "s" : ""}: ${counts.completed} done · ${counts.inProgress} in progress · ${counts.pending} queued.`;
    },
  });

  // Vision-tool gate: drop the 3 vision-proxy tools on turns with no plausible
  // image involvement. Built then deleted (closures are cheap) to avoid
  // re-indenting the tool definitions above. todo_write + core tools untouched.
  if (opts?.includeVisionTools === false) {
    for (const name of VISION_TOOL_NAMES) delete tools[name];
  }

  // ── Agent introspection tools: help the inner agent discover capabilities ──
  // These are always added last (after all filtering) so list_tools reflects reality.
  if (opts?.executionRole === "orchestrator") {
    tools.worker_models = dynamicTool({
      description:
        "List enabled authenticated tool/text worker models, provider, tier, description, price and supported effort. Main chooses; no automatic router selection.",
      inputSchema: jsonSchema({ type: "object", properties: { offset: { type: "integer", minimum: 0 } } }),
      execute: async (input: any) => {
        const models = await workerModelInventory(opts.credentialedProvider);
        const offset = Number.isSafeInteger(input?.offset) && input.offset > 0 ? input.offset : 0;
        return {
          models: models.slice(offset, offset + 30),
          total: models.length,
          ...(offset + 30 < models.length ? { nextOffset: offset + 30 } : {}),
        };
      },
    });
    tools.worker_capabilities = dynamicTool({
      description:
        "List exact connected MCP capability names and descriptions main may explicitly grant to a worker. This does not execute them or grant orchestration tools.",
      inputSchema: jsonSchema({ type: "object", properties: { offset: { type: "integer", minimum: 0 } } }),
      execute: async (input: any) => {
        const { acquireMcpTools } = await import("../mcp/client-pool.js");
        const bundle = await acquireMcpTools(loadMcpServers());
        try {
          const capabilities = filterExecutionTools(bundle.tools, {}, "worker", Object.keys(bundle.tools));
          const entries = Object.entries(capabilities);
          const offset = Number.isSafeInteger(input?.offset) && input.offset > 0 ? input.offset : 0;
          return {
            isolation: WORKER_ISOLATION_CAPABILITIES,
            capabilities: entries
              .slice(offset, offset + 30)
              .map(([name, value]) => ({ name, description: value.description?.slice(0, 500) })),
            total: entries.length,
            ...(offset + 30 < entries.length ? { nextOffset: offset + 30 } : {}),
            errors: bundle.errors,
            needsKey: bundle.needsKey,
            readiness:
              "Connected inventory only; execution readiness is established by actual tool calls. Use integration_status for recent observed checks.",
            note: "Exact grants permit these capabilities for a general worker. Read-only explore/review jobs do not receive arbitrary MCP tools.",
          };
        } finally {
          await bundle.close();
        }
      },
    });
  }

  tools.list_mcp_servers = dynamicTool({
    description:
      "List every MCP server in the current user config (enabled or not). Returns id, label, enabled, transport, endpoint, and recommended_native (if any). " +
      "Use this to discover exactly what MCPs you have right now. For each MCP, see if there is a preferred native replacement (e.g. fetch_url instead of legacy fetch). " +
      "Memory, playwright, figma removed from defaults. Only enabled servers contribute tools this turn.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const servers = loadMcpServers();

      // Native replacement recommendations (helps agent choose better tools)
      const RECOMMENDATIONS: Record<string, string | null> = {
        fetch: "Prefer native fetch_url (faster, always available, no external spawn).",
        tavily: "Prefer native web_search (direct Tavily API call, same results).",
        context7: "Consider keeping for library docs, or cache important docs into Experience Engine for offline use.",
        "muonroi-docs": null, // already our own controlled service
        playwright: "Use for full browser interaction/screenshots only; fetch_url sufficient for most content needs.",
        memory: "Use native ee_query / ee_write (Experience Engine) instead.",
        figma: "Add manually only if needed; no native equivalent yet.",
      };

      const summary = servers.map((s) => {
        const rec = RECOMMENDATIONS[s.id] ?? null;
        return {
          id: s.id,
          label: s.label,
          enabled: s.enabled,
          transport: s.transport,
          endpoint: s.url || (s.command ? `${s.command} ${(s.args || []).join(" ")}` : undefined),
          recommended_native: rec,
        };
      });

      return JSON.stringify({ count: summary.length, servers: summary }, null, 2);
    },
  });

  tools.list_tools = dynamicTool({
    description:
      "Compact grouped summary of every tool available this turn. " +
      "native = always-on builtins (fetch_url, web_search, bash, read_file, grep, ee_query, list_mcp_servers, list_tools, ...). " +
      "mcp = tools from your enabled MCP servers (prefixed mcp_<server-id>__). " +
      "Each line: name + short description (tells you purpose and rough usage). " +
      "Call list_mcp_servers() to see your MCP sources, then this to see concrete tools + how to use them. Full parameter schemas are in the system tool list this turn.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["all", "native", "mcp"],
          description: "Optional filter.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const cat = (input?.category as string) || "all";
      const grouped: { native: string[]; mcp: string[] } = { native: [], mcp: [] };

      const visible =
        opts?.getToolSet?.() ?? (boundWriteScope ? filterScopedWorkerTools(tools, tools) : (liveToolSet ?? tools));
      for (const [name, tool] of Object.entries(visible)) {
        const t = tool as { description?: string };
        const shortDesc = (t.description || "").split("\n")[0].slice(0, 140);
        const entry = `${name}: ${shortDesc}`;
        if (name.startsWith("mcp_")) {
          if (cat === "all" || cat === "mcp") grouped.mcp.push(entry);
        } else {
          if (cat === "all" || cat === "native") grouped.native.push(entry);
        }
      }

      grouped.native.sort();
      grouped.mcp.sort();

      return JSON.stringify(
        {
          total: Object.keys(visible).length,
          native_count: grouped.native.length,
          mcp_count: grouped.mcp.length,
          ...grouped,
          note: "Native tools are always preferred. MCP tools only from servers where enabled=true (see list_mcp_servers).",
        },
        null,
        2,
      );
    },
  });

  tools.describe_tool = dynamicTool({
    description:
      "Get detailed usage information for a specific tool by name. Returns description, full input schema (parameters), and a short usage example or note. " +
      "Call this when you need precise 'how to use' details for a tool (e.g. describe_tool with name='fetch_url' or name='mcp_context7__something'). " +
      "This complements list_tools and list_mcp_servers.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Exact tool name (e.g. 'fetch_url', 'web_search', 'mcp_context7__search' or any from list_tools)",
        },
      },
      required: ["name"],
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return "ERROR: name is required";

      const tool = (
        (opts?.getToolSet?.() ??
          (boundWriteScope ? filterScopedWorkerTools(tools, tools) : (liveToolSet ?? tools))) as any
      )[name];
      if (!tool) {
        return JSON.stringify(
          {
            name,
            error: "Tool not found in current tool set. Use list_tools to see available names.",
          },
          null,
          2,
        );
      }

      const t = tool as { description?: string; inputSchema?: unknown; [MCP_FULL_INPUT_SCHEMA]?: unknown };
      // MCP tools ship a permissive placeholder schema to the model (Phase M1
      // lazy schema loading, src/mcp/runtime.ts). Serving that placeholder here
      // made describe_tool useless for exactly the tools it exists for: a model
      // asking "what are this MCP tool's parameters?" got `{properties:{}}` and
      // then guessed. Prefer the real schema the MCP server advertised.
      const schema = t[MCP_FULL_INPUT_SCHEMA] || t.inputSchema || (tool as any).parameters || null;

      // Provide a minimal example note for common tools
      const examples: Record<string, string> = {
        fetch_url: 'Example: {"url": "https://example.com/docs", "format": "markdown"}',
        web_search: 'Example: {"query": "muonroi building block best practices", "maxResults": 5}',
        list_mcp_servers: "Call with no args: {}",
        list_tools: 'Example: {"category": "native"}',
      };

      return JSON.stringify(
        {
          name,
          description: t.description,
          inputSchema: schema,
          example: examples[name] || "See inputSchema above. Call with correct parameters.",
          note: "Use the exact parameters from inputSchema when calling this tool.",
        },
        null,
        2,
      );
    },
  });

  // N1 — executor-side malformed-args guard, applied to EVERY builtin after all
  // register* helpers have contributed, so a tool added later cannot miss it.
  // The provider does not enforce the schemas it is shown (`grep` declares
  // required:["pattern"] and still received 94 keyless calls), so this is the
  // only layer that can stop a keyless / elision-marker call before it runs.
  // See src/tools/arg-guard.ts for the measured failure it exists for.
  // Host-executed recipe gates for file-scoped agent workers (src/tools/run-gate.ts).
  // Registered before the arg guard so it gets the same malformed-args protection.
  if (boundWriteScope && mode === "agent")
    registerRunGateTool(tools, {
      cwd: bash.getCwd(),
      catalog: opts?.gateCatalog ?? resolveGateCatalog(bash.getCwd()),
      boundScope: boundWriteScope,
      currentScope: opts?.currentWriteScope,
      onViolation: opts?.onGateViolation,
    });

  installArgGuards(tools, gitSafetyKey);

  return opts?.writeScope !== undefined ? filterScopedWorkerTools(tools, tools) : tools;
}
