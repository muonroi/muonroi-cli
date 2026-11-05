import { canServeTextRequests, getModelInfo, MODELS } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { getConfiguredProviders } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";
import type { ModelInfo, ReasoningEffort, TaskRequest } from "../types/index.js";
import { getReasoningEffortForModel, isModelDisabled, isProviderDisabled } from "../utils/settings.js";

export type ExecutionRole = "orchestrator" | "worker" | "infrastructure";
export const REVIEW_TOOL_NAMES = [
  "read_file",
  "grep",
  "lsp_query",
  "verification_run",
  "retrieve_tool_result",
  "worker_message",
] as const;
const REVIEW_TOOLS: ReadonlySet<string> = new Set(REVIEW_TOOL_NAMES);
export function filterReviewTools<T extends Record<string, unknown>>(merged: T, native: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(merged).filter(([name, tool]) => REVIEW_TOOLS.has(name) && native[name] === tool),
  ) as T;
}
const tierRank = { fast: 0, balanced: 1, premium: 2 } as const;

export function isWorkerModelEligible(model: ModelInfo): boolean {
  return (
    !!model.provider &&
    canServeTextRequests(model) &&
    getProviderCapabilities(model.provider as ProviderId).supportsClientTools(model)
  );
}

/** Provider ownership is invariant. Pricing is a catalog tie-breaker, not a quality claim. */
export function selectOrchestratorModel(
  provider: string,
  catalog: readonly ModelInfo[] = MODELS,
  disabled: (id: string) => boolean = isModelDisabled,
): ModelInfo {
  const eligible = catalog.filter(
    (row) => row.provider === provider && !disabled(row.id) && isWorkerModelEligible(row),
  );
  eligible.sort(
    (a, b) =>
      tierRank[b.tier ?? "fast"] - tierRank[a.tier ?? "fast"] ||
      b.outputPrice - a.outputPrice ||
      b.inputPrice - a.inputPrice,
  );
  if (!eligible.length)
    throw new Error(
      `No eligible enabled text/tool model for provider "${provider}". Enable a catalog model or select another provider.`,
    );
  return eligible[0]!;
}

export function orchestrationEffort(modelId: string): ReasoningEffort | undefined {
  const info = getModelInfo(modelId);
  return (
    getReasoningEffortForModel(modelId) ??
    (info?.reasoning && info.supportsReasoningEffort !== false ? "high" : undefined)
  );
}

export async function configuredWorkerProviders(currentProvider?: ProviderId): Promise<Set<ProviderId>> {
  const providers = new Set(await getConfiguredProviders());
  if (currentProvider) providers.add(currentProvider);
  for (const provider of providers) if (isProviderDisabled(provider)) providers.delete(provider);
  return providers;
}

export async function workerModelInventory(currentProvider?: ProviderId): Promise<Array<Record<string, unknown>>> {
  const providers = await configuredWorkerProviders(currentProvider);
  return MODELS.filter(
    (row) =>
      row.provider &&
      providers.has(row.provider as ProviderId) &&
      !isModelDisabled(row.id) &&
      isWorkerModelEligible(row),
  ).map((row) => ({
    modelId: row.id,
    provider: row.provider,
    name: row.name,
    tier: row.tier,
    description: row.description.slice(0, 700),
    roles: row.roles,
    contextWindow: row.contextWindow,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    reasoning: row.reasoning,
    supportsClientTools: true,
    supportsVision: row.supportsVision === true,
    reasoningEfforts: row.reasoning && row.supportsReasoningEffort !== false ? ["low", "medium", "high", "xhigh"] : [],
    defaultReasoningEffort: getReasoningEffortForModel(row.id) ?? row.defaultReasoningEffort,
  }));
}

export async function validateWorkerSelection(
  request: TaskRequest,
  currentProvider?: ProviderId,
): Promise<TaskRequest> {
  const grantError = workerMcpGrantError(request);
  if (grantError) throw new Error(grantError);
  if (!request.modelId)
    throw new Error("worker_model_required: choose an explicit modelId from worker_models before dispatch.");
  const model = getModelInfo(request.modelId);
  if (!model || !isWorkerModelEligible(model) || isModelDisabled(model.id)) {
    throw new Error(
      `worker_model_unavailable: "${request.modelId}" is unknown, disabled, or cannot execute text/tool work. Use worker_models.`,
    );
  }
  const providers = await configuredWorkerProviders(currentProvider);
  if (!providers.has(model.provider as ProviderId)) {
    throw new Error(
      `worker_provider_unconfigured: authenticate provider "${model.provider}" before selecting "${model.id}".`,
    );
  }
  if (
    request.reasoningEffort !== undefined &&
    (!model.reasoning ||
      model.supportsReasoningEffort === false ||
      !["low", "medium", "high", "xhigh"].includes(request.reasoningEffort))
  ) {
    throw new Error(
      `worker_effort_unsupported: "${model.id}" cannot use reasoningEffort "${request.reasoningEffort}". Omit it or choose an effort-capable model.`,
    );
  }
  return { ...request, modelId: model.id };
}

export function workerMcpGrantError(request: TaskRequest): string | undefined {
  if (
    request.writeScope !== undefined &&
    (!Array.isArray(request.writeScope) ||
      request.allowedMcpTools?.length ||
      (!["general", "explore"].includes(request.agent) && !request.reviewOf))
  ) {
    return "worker_write_scope_refused: file-scoped jobs use general/explore (or static reviewOf) with native file tools only (general also gets run_gate for verify-recipe gates). Shell/MCP/LSP/bootstrap cannot be contained by file allowlists; no worker was started. Use a separately authorized execution worker for commands; OS sandbox is unavailable.";
  }
  if (
    request.allowedMcpTools?.length &&
    (request.agent === "explore" || request.agent === "verify-detect" || request.reviewOf)
  ) {
    return "worker_capability_role_refused: read-only explore, verify-detect and reviewOf jobs do not receive arbitrary MCP tools. Use task with agent=general and exact allowedMcpTools for MCP work, or remove the grant for a native-only read-only job. No worker was started.";
  }
  return undefined;
}

const ORCHESTRATION_TOOLS = new Set([
  "read_file",
  "grep",
  "task",
  "delegate",
  "delegation_read",
  "delegation_list",
  "delegation_kill",
  "delegation_ack",
  "delegation_accept",
  "delegation_send",
  "worker_models",
  "worker_capabilities",
  "integration_status",
  "convene_council",
  "ask_user",
  "todo_write",
  "ee_query",
  "ee_write",
  "ee_feedback",
  "ee_health",
  "retrieve_tool_result",
  "compact",
  "context_load",
  "read_pil_context",
  "flow_status",
  "flow_discuss",
  "flow_plan",
  "flow_plan_review",
]);
const WORKER_FORBIDDEN = new Set([
  ...ORCHESTRATION_TOOLS,
  "enter_ideal",
  "flow_execute",
  "flow_verify",
  "flow_ship",
  "flow_next",
  "consult_parent_session",
  "invoke_subagent",
  "spawn_agent",
  "spawn_worker",
  "run_task",
  "run_delegation",
]);
for (const name of [
  "read_file",
  "grep",
  "ee_query",
  "ee_write",
  "ee_feedback",
  "ee_health",
  "retrieve_tool_result",
  "context_load",
  "compact",
  "todo_write",
  "ask_user",
]) {
  WORKER_FORBIDDEN.delete(name);
}

/** Final, post-merge boundary. Authorization is native object identity, never a name/prefix alone. */
export function filterExecutionTools<T extends Record<string, unknown>>(
  merged: T,
  native: Record<string, unknown>,
  role: ExecutionRole,
  allowedMcpTools: readonly string[] = [],
): T {
  const nativeObjects = new Set(Object.values(native));
  const granted = new Set(allowedMcpTools);
  const entries = Object.entries(merged).filter(([name, tool]) => {
    if (role === "orchestrator")
      return ORCHESTRATION_TOOLS.has(name) && Object.hasOwn(native, name) && native[name] === tool;
    const operation = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
    if (operation === "worker_message")
      return name === "worker_message" && Object.hasOwn(native, name) && native[name] === tool;
    if (
      WORKER_FORBIDDEN.has(name) ||
      WORKER_FORBIDDEN.has(operation) ||
      name.startsWith("flow_") ||
      operation.startsWith("flow_")
    )
      return false;
    if (Object.hasOwn(native, name) && native[name] === tool) return true;
    if (nativeObjects.has(tool)) return false;
    return name.startsWith("mcp_") && granted.has(name);
  });
  return Object.fromEntries(entries) as T;
}

/**
 * Orchestrator prose contract. Only rules the host cannot enforce live here;
 * host-enforced ones (write scope, dispatch capability/overlap guards, run_gate,
 * root-goal pin + completion gate, acceptance checks, council allowance and
 * dossier decisions, live delegation ledger) are carried by those tools' own
 * schemas, receipts and refusals. Every step re-sends this text, so each line
 * costs once per model call — see orchestration-policy.test.ts for the
 * behaviors it must still state.
 */
export const ORCHESTRATOR_CONTRACT = `You are the main orchestrator: own the user's goal, plan, questions, worker selection, evidence synthesis and final response. Only the tools supplied in this call exist; planning and conversation need no worker. Read plan, SKILL.md, source, logs and saved evidence yourself with read_file and grep (anchor with grep, read bounded sections, reread changed inputs); delegate broad research, runtime probes, implementation, commands, tests and independent review to workers. Your own reading is never independent acceptance.
Workers: choose modelId from worker_models (its inventory is stable for the session: call it once, then reuse it). A worker prompt states role, scope/workspace, input, question, exclusions, budget and evidence to return. Give every bounded file-edit task an explicit writeScope; the host enforces scope, tool grants and dispatch capability, and a scoped worker builds/tests only through run_gate. No OS sandbox exists (worker_capabilities reports the isolation backend) and an omitted scope is shared execution: never describe either as sandboxed. Change a running worker's scope only via delegation_send writeScope after inspecting its current effects; never claim rollback of applied changes. Decide ambiguity or out-of-scope requests before the worker continues.
Background work: workers and councils run in the background. A completion notice carries the saved result inline, or its first part plus the delegation_read offset to continue; call delegation_read only for that remainder, raw tool artifacts (toolCallId from the host manifest) or council dossier files. After processing a result call delegation_ack with its jobId and resultVersion; ACK records handling, not acceptance. When only background jobs remain, end the turn: never poll or sleep, each result wakes you. Instruct a running worker with delegation_send without replyTo; answer its question with that exact messageId as replyTo.
Goal and completion: keep the user's root goal distinct from the current wave, preflight and delegated scope. A finished worker, accepted partial change, passing scan, commit or approved plan does not finish the whole task: before claiming completion, check every deliverable and acceptance criterion against current evidence, otherwise report partial progress and the remaining work. Keep completed scope, evidence IDs, remaining deliverables and the next action in the working ledger (context_load). Do not re-ask decisions the admitted plan already settled.
Evidence: base claims on current bounded evidence and label missing checks; a model's narration is not proof of effects. Use separate implementation and review workers; static review is not executed tests. For saved runtime-output claims dispatch a bounded reviewOf with the target jobId/resultVersion; artifact corroboration is not test execution, and a small evidence comparison is not a source audit. jobId, resultVersion, toolCallId and digest are distinct opaque IDs: copy them unchanged across compaction; find an unknown one with retrieve_tool_result({view:"index",query}) and never ask the user for internal IDs. An ID miss or unavailable EE does not prove evidence was lost, and current files do not reproduce historical runtime output. EE lessons are guidance, never evidence, approval or model choice; an auth failure needs credentials, not repeated fan-out.
Councils: verdicts are advice. Adjudicate each finding against the dossier evidence and current plan citations (proposed reproduction steps are unexecuted); reproduce disputed material claims with a bounded verify worker and finish the plan changes before spending another council; never start a new request to reset the council allowance; never accept a blocker only because several roles agree or a leader labels it confirmed. Judge test claims against their stated purpose: a clean-corpus true-negative expects zero detections; a complete negative sweep needs its patterns, roots, a successful command and a verified file count.
Failures: report the exact blocker or repair the worker's execution/approval channel; never take over the assigned work, invent tools or repeat unsupported probes. Read the host failure observations and version-bound captured tool results, then current files, before assigning a bounded repair. Missing final output does not mean no work happened; never replay an applied edit or infer rollback. A ModelMessage schema refusal is not context overflow; Access denied does not identify a lock owner; a later success does not prove the earlier cause fixed; an output-limit stop is explained by its finish reason and output budget, not by input size.
User-facing: keep coordination private (job IDs, worker lifecycle, ACKs, EE bookkeeping) unless the user asks; give concise progress, actionable blockers or questions, and the outcome. Reply in the user's language; reasoning, tool and code text stay English.`;

/**
 * Append the contract to an assembled system prompt unless it already carries
 * it. The static prefix includes it for non-chitchat orchestrator turns, so an
 * unconditional append sent it twice on every call.
 */
export function withOrchestratorContract(system: string, executionRole?: ExecutionRole): string {
  if (executionRole !== "orchestrator" || system.includes(ORCHESTRATOR_CONTRACT)) return system;
  return `${system}\n\n${ORCHESTRATOR_CONTRACT}`;
}
