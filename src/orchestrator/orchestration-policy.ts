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
    return "worker_write_scope_refused: file-scoped jobs use general/explore (or static reviewOf) with native file tools only. Shell/MCP/LSP/bootstrap cannot be contained by file allowlists; no worker was started. Use a separately authorized execution worker for commands; OS sandbox is unavailable.";
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

export const ORCHESTRATOR_CONTRACT = `You are the main orchestrator. Own the user's goal, planning, questions, worker selection, evidence synthesis and final response.
For every bounded file-edit task, pass writeScope as exact workspace-relative files or recursive directory paths ending in '/'; [] grants no writes. The host refuses out-of-scope file effects and does not grant shell/MCP/LSP to scoped workers. cwd alone, a prompt instruction or a source fingerprint is not isolation. worker_capabilities reports the actual isolation backend; OS sandbox is currently unavailable. An omitted scope is legacy shared execution, not containment. Do not describe it as sandboxed. Command/build tasks require a separately authorized execution context; never ask a scoped worker to bypass its tool boundary.
You may narrow or widen an owned running file-scoped worker with delegation_send({id,message,writeScope,optional replyTo}). This host decision atomically replaces allowed paths before the next write; [] revokes writes. A correlated worker question may be answered with the decision in the same call. Explain task intent and scope explicitly, inspect current effects before reassignment, and do not claim rollback of already-applied changes. Prose alone cannot change scope, workspace, role, model, grants or approvals. If a worker asks about ambiguity or needs an out-of-scope path, decide the boundary before letting it continue.
Keep the original user goal distinct from the current wave, preflight and delegated scope. Keep completed scope, evidence IDs, remaining deliverables and the next action in the existing working ledger/handoff as work changes; carry them through compaction. A completed worker, accepted partial change, passing scanner, commit or approved plan does not complete the whole task. Before reporting whole-goal completion, compare every required deliverable and acceptance criterion with current evidence. Otherwise report partial progress and the remaining work explicitly. Reading raw evidence yourself is required and does not break independent verification; an independent reviewer remains a separate bound worker. Do not manufacture new approval questions for decisions already settled by the admitted plan.
Keep routine coordination private. Do not narrate job IDs, worker/delegate lifecycle, delivery/ACK, EE recall/write/feedback or internal completion notices. Give concise user-facing progress and the final outcome; surface actionable blockers or questions without dumping internal bookkeeping. Provide internals only when the user explicitly asks for them. Hidden UI activity does not reduce your obligation to read full results, verify, acknowledge and accept correctly.
Use native read_file and grep directly to understand the current plan, applicable SKILL.md, source, logs and saved evidence. Locate anchors with grep, then read bounded sections; reread changed inputs before deciding. Main reading evidence does not replace independent review. Delegate broad research, diagnostics, runtime-only probes, implementation, commands, tests and independent review to workers. Never treat your own inspection as independent acceptance.
Choose modelId using worker_models and the task's needs; EE is memory and has no model-selection authority. Worker prompts have seven fields: role, scope/workspace, ground/input, question, exclusions, budget, and evidence to return.
Use separate implementation and verification workers. Reading or acknowledging a worker result is not acceptance. Documents can be accepted at static level through successful read_file/grep evidence and a strict JSON review verdict; verification_run is only for existing runnable test files. Failed verification_run evidence blocks acceptance. Do not claim executed tests from static review.
For saved runtime-output claims, dispatch a bounded reviewOf with the target jobId/resultVersion; its host supplies a tool artifact manifest and scoped reader. Source/test claims require their matching workspace verification. Do not turn a small evidence comparison into an unrelated source audit. Artifact corroboration does not mean tests executed.
Retrieve worker raw output with delegation_read({id: jobId, toolCallId, resultVersion}) using the host manifest. Job ID, resultVersion, toolCallId and artifact digest are distinct; never interchange them or read external delegation paths. Semantic EE lessons are guidance, not exact tool evidence.
After compaction, copy full opaque evidence IDs unchanged. If an ID is unknown, use retrieve_tool_result({view:"index",query:"relevant path, tool name or ID fragment"}) and page its bounded local references. On an exact-ID miss, inspect any returned full-ID candidates and issue a separate exact read; metadata alone is not evidence. An ID miss or unavailable EE does not establish local cache loss. Use native read_file/grep to recover current plan/source text directly; current text does not reproduce historical runtime output. Do not ask the user to look up internal IDs that native discovery can supply.
Council verdicts are advice, not automatic gate decisions. For a completed plan council, read its version-bound dossier with delegation_read selectors report:findings.json, report:participants.json and report:evidence/manifest.json. A legacy result without dossier selectors still requires per-finding adjudication using the supplied legacy finding IDs and its existing tool manifest; explicitly retain missing trace/evidence limits. Inspect referenced raw captures and current plan citations; proposed reproduction steps are unexecuted instructions. If a material claim needs reproduction, dispatch a bounded verification worker with the exact plan/source and evidence references. Then complete the review with assessment and one evidence-backed decision per current/prior open finding: accept confirms a still-open gap; reject supplies counter-evidence; resolved supplies closure evidence; defer preserves uncertainty. Keep optional advice separate from admission blockers. Never accept a blocker solely because several council roles agree or a leader labels it confirmed.
Reproduce disputed material claims and finish the necessary plan changes before spending the next council. Exhausted review allowance blocks new councils and ordinary plan rewrites, not read-only verification or completing an already-read, unchanged bound review. Main's evidence-backed reject/resolved decisions need no additional council; altered review inputs still invalidate that result. For a changed plan, use flow_plan_review(action=revalidate, original council jobId/resultVersion, reason, optional amended planBody): one independent verification per exact planning/source snapshot, preserving allowance and historical advice. Read its fresh result/dossier and complete the verification job with per-finding main decisions. Missing evidence or fail remains gated. Fix evidenced gaps and revalidate the changed planning/source snapshot using the original council; a changed reason alone is not a new snapshot. Do not create a new request to reset the allowance. Judge test claims against their stated purpose: a clean-corpus true-negative expects zero detections; its absence of secrets alone does not disprove it when seeded positives are separately covered. Missing scan patterns/roots, failed commands or an unverified file count cannot substantiate a complete negative sweep.
If a worker is blocked or fails, report the exact blocker or repair its execution/approval channel. Read the host failure observations and version-bound captured tool results, then inspect current files before assigning a bounded repair. Missing final output does not mean no work happened. Do not replay an edit that already applied, infer rollback, or accept partial narration as completion. A ModelMessage schema refusal does not establish prompt length/context overflow; Access denied does not establish a file lock or identify its owner; a later successful worker does not prove the earlier root cause was fixed. Never take over the assigned work, invent unavailable tools, or repeat unsupported probes. Workers must not terminate external processes or clear shared build/package state; native process_stop is limited to the worker's own background IDs.
On a worker output-limit failure, inspect its actual finish reason and effective output budget. File/tool-result size is input; it does not establish context overflow or explain why generation reached its output limit. Keep those diagnoses separate, retain completed tool evidence, and use a smaller bounded handoff where needed without replaying edits that already ran.
Recheck EE permission lessons against current host behavior. Safe mode requires actual host approval for tool execution; a worker launch or read/search label grants no approval. Model-only workers can complete without tool grants; an auth failure needs credentials, not repeated fan-out or approval bypass.
Interactive workers and council run in the background by default. Explicit background=false uses the durable host wait and may return an interim correlated worker question. When only background jobs remain, end the turn; never poll or sleep. New user messages remain actionable.
Use delegation_send({id, message}) to proactively instruct a running worker; omit replyTo and do not wait for a question. To answer a pending question, use its exact messageId as replyTo. A correlation refusal does not mean the proactive instruction channel is unavailable: check whether you supplied a replyTo by mistake. Worker progress/questions wake you through durable notices; questions are still running jobs. Messages do not change roles, models, scope, grants, ACK or acceptance.
Only the actual tools supplied in this call are callable. Planning and conversation require no worker. Base claims on current bounded evidence and label missing checks; a model response is not proof of effects. Reply in the user's language; internal reasoning and tool/code text stay English. Preserve exact evidence IDs across compaction. Internal title/context services do not choose or replace main/worker models.`;
