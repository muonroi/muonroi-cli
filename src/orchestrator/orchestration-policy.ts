import { canServeTextRequests, getModelInfo, MODELS } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { getConfiguredProviders } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";
import type { ModelInfo, ReasoningEffort, TaskRequest } from "../types/index.js";
import { logger } from "../utils/logger.js";
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

/**
 * A worker must cost less than the orchestrator that dispatches it: a lower catalog tier and
 * no higher input or output price. In the 2026-11 delegation records 227 of 375 explicit-model
 * workers dispatched by a step-5-preview (premium) orchestrator ran step-5-preview itself: the
 * explicit modelId required since b014c9b9 bypasses resolveModelForTask's parentTier ceiling.
 * When no candidate qualifies (a fast orchestrator, a premium-only setup) the orchestrator's own
 * model is the only worker allowed, never one above it. undefined = no ceiling, because the
 * orchestrator model is not in the catalog and so has no tier or price to compare against.
 */
export function workerCostCeiling(
  orchestratorModelId: string | undefined,
  candidates: readonly ModelInfo[],
): ((model: ModelInfo) => boolean) | undefined {
  if (!orchestratorModelId) return undefined;
  const parent = getModelInfo(orchestratorModelId);
  if (!parent?.tier) {
    logger.warn("orchestrator", "Worker cost ceiling skipped: orchestrator model has no catalog tier", {
      orchestratorModelId,
    });
    return undefined;
  }
  const cheaper = (m: ModelInfo) =>
    tierRank[m.tier ?? "fast"] < tierRank[parent.tier!] &&
    m.inputPrice <= parent.inputPrice &&
    m.outputPrice <= parent.outputPrice;
  if (candidates.some(cheaper)) return cheaper;
  return (m) => m.id === parent.id;
}

async function eligibleWorkerModels(currentProvider?: ProviderId, orchestratorModelId?: string): Promise<ModelInfo[]> {
  const providers = await configuredWorkerProviders(currentProvider);
  const candidates = MODELS.filter(
    (row) =>
      row.provider &&
      providers.has(row.provider as ProviderId) &&
      !isModelDisabled(row.id) &&
      isWorkerModelEligible(row),
  );
  const ceiling = workerCostCeiling(orchestratorModelId, candidates);
  return ceiling ? candidates.filter(ceiling) : candidates;
}

/**
 * The worker model when the HOST dispatches on main's behalf and no orchestrator chose one:
 * the highest-tier model under workerCostCeiling on main's own provider, cheapest on a tie.
 * The plan revalidation verifier had no modelId and inherited main's model: all 23 such jobs
 * in the 2026-11 delegation records ran step-5-preview (premium). Main's provider only, because
 * the host hands main's credential to the worker (StartDelegationOptions.workerApiKey).
 */
export async function hostWorkerModel(orchestratorModelId: string): Promise<string> {
  const provider = getModelInfo(orchestratorModelId)?.provider as ProviderId | undefined;
  if (!provider) return orchestratorModelId;
  const allowed = (await eligibleWorkerModels(provider, orchestratorModelId)).filter((m) => m.provider === provider);
  allowed.sort(
    (a, b) =>
      tierRank[b.tier ?? "fast"] - tierRank[a.tier ?? "fast"] ||
      a.outputPrice - b.outputPrice ||
      a.inputPrice - b.inputPrice,
  );
  return allowed[0]?.id ?? orchestratorModelId;
}

export async function workerModelInventory(
  currentProvider?: ProviderId,
  orchestratorModelId?: string,
): Promise<Array<Record<string, unknown>>> {
  return (await eligibleWorkerModels(currentProvider, orchestratorModelId)).map((row) => ({
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

/**
 * Worker model ids for the task/delegate `modelId` enum, read from the same
 * live inventory worker_models returns (catalog + configured providers +
 * enable state; no hardcoded ids). undefined when it cannot be read — the
 * schema then stays a free string and validateWorkerSelection still refuses
 * an ineligible id at dispatch.
 */
export async function liveWorkerModelIds(
  currentProvider?: ProviderId,
  orchestratorModelId?: string,
): Promise<string[] | undefined> {
  try {
    const ids = (await workerModelInventory(currentProvider, orchestratorModelId)).map((row) => String(row.modelId));
    return ids.length ? ids : undefined;
  } catch (err) {
    logger.warn("orchestrator", "Worker model inventory unavailable for the modelId schema", {
      provider: currentProvider,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** JSON schema for a worker `modelId`: an enum of the live inventory when known. */
export function workerModelIdSchema(ids?: readonly string[]): Record<string, unknown> {
  return ids?.length
    ? {
        type: "string",
        enum: [...ids],
        description: "Worker model from the live inventory (worker_models describes tier, price and roles).",
      }
    : { type: "string", description: "Exact enabled authenticated catalog model from worker_models." };
}

export async function validateWorkerSelection(
  request: TaskRequest,
  currentProvider?: ProviderId,
  orchestratorModelId?: string,
): Promise<TaskRequest> {
  const grantError = workerMcpGrantError(request) ?? workerWriteScopeRequiredError(request);
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
  const allowed = await eligibleWorkerModels(currentProvider, orchestratorModelId);
  if (!allowed.some((row) => row.id === model.id)) {
    throw new Error(
      `worker_model_above_orchestrator: "${model.id}" (${model.tier ?? "no tier"}) does not cost less than the orchestrator model "${orchestratorModelId}". No worker was started. Choose one of: ${allowed.map((row) => `${row.id} (${row.tier})`).join(", ")}.`,
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

/**
 * Built-in roles that never receive a file-edit assignment: read-only (explore,
 * verify-detect run in ask mode) or verification/analysis roles whose writes
 * are incidental (verify, verify-manifest, vision). Everything else — general,
 * computer and configured custom sub-agents — runs in agent mode with
 * write_file/edit_file and bash.
 */
const WRITE_SCOPE_EXEMPT_AGENTS: ReadonlySet<string> = new Set([
  "explore",
  "verify-detect",
  "verify",
  "verify-manifest",
  "vision",
]);

/**
 * M9: an edit-capable dispatch must state its write grant. Omitting writeScope
 * used to mean "legacy shared execution" silently (worker-dispatch-guard.ts
 * footprint = whole cwd), and 87 of 110 general dispatches in the recorded
 * delegations since 2026-10-20 were unscoped, including bounded single-file
 * edits ("Amend PLAN.md", "Fix stale gate comment in scan_corpus.py"). A safe
 * default scope cannot be chosen by the host: a scoped worker has no shell
 * (worker-write-scope.ts), and the same set includes build/test/git steps
 * ("Build and run TCIS.MCP.Docs.Tests gate", "Commit C9 corpus-scan text fix")
 * that only an unscoped worker can run. So the omission is refused and the
 * model must choose: writeScope, or sharedExecution:true for shell work.
 */
export function workerWriteScopeRequiredError(request: TaskRequest): string | undefined {
  // `writeScope: []` is the documented read-only grant, but sharedExecution:true asks for
  // unscoped writes: the pair contradicts (session 26516fe0c62e started a worker that could
  // write nothing and was killed 8s later). Refuse it rather than guess which one was meant.
  if (request.sharedExecution === true && Array.isArray(request.writeScope) && request.writeScope.length === 0)
    return `worker_write_scope_contradiction: agent=${request.agent} has sharedExecution:true (writes anywhere in cwd) but writeScope:[] (no writes allowed). No worker was started. Omit writeScope for shared execution, or list the paths the worker may write; drop sharedExecution for a read-only worker.`;
  if (request.writeScope !== undefined || request.reviewOf || request.sharedExecution === true) return undefined;
  if (WRITE_SCOPE_EXEMPT_AGENTS.has(request.agent)) return undefined;
  return `worker_write_scope_required: agent=${request.agent} can edit files, so the dispatch must state its write grant. No worker was started. Set writeScope to the exact files or directories (ending in '/') this task may change ([] for no writes); or, only when the task must run shell commands (build, test, git) that a scoped worker cannot, set sharedExecution:true — it writes anywhere in cwd and is not isolated. Read-only research uses delegate/explore; test runs can use agent=verify.`;
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
  "skill_load",
  "skill_create",
  "read_pil_context",
  "flow_status",
  "flow_discuss",
  "flow_plan",
  "flow_plan_review",
  // Phase transitions and verification are recorded by the orchestrator itself;
  // workers do the work and the independent checks and cannot call flow_*.
  // Without these three the root-goal completion gate (implementationVerification
  // must be recorded_pass) was unsatisfiable from the orchestrator role
  // (session 55c5b65b6938: every `root_status=complete` claim was refused).
  "flow_execute",
  "flow_verify",
  "flow_ship",
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
  // Workers read skills the owner names; only main authors them (skill_create stays forbidden).
  "skill_load",
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
 * host-enforced ones (write scope + the writeScope/sharedExecution choice,
 * dispatch capability/overlap guards, run_gate, worker modelId enum and the
 * structured brief, result ACK after a processed turn, running-job read
 * refusal, ID-kind routing in retrieve_tool_result, internal-ID refusal in
 * ask_user, root-goal pin + completion gate, acceptance checks, council
 * allowance and dossier decisions, live delegation ledger) are carried by those
 * tools' own schemas, receipts and refusals. Every step re-sends this text, so each line
 * costs once per model call — see orchestration-policy.test.ts for the
 * behaviors it must still state.
 */
/**
 * Opening words of the orchestrator contract. Exported so anything that must
 * recognise a main-orchestrator call (harness recordings, mock routes) derives
 * from the same text instead of a copied literal — the contract trim in
 * e0f9a4ff changed "orchestrator." to "orchestrator:" and silently broke six
 * harness specs that matched the old punctuation.
 */
export const ORCHESTRATOR_ROLE_PREFIX = "You are the main orchestrator";

export const ORCHESTRATOR_CONTRACT = `${ORCHESTRATOR_ROLE_PREFIX}: own the user's goal, plan, questions, worker selection, evidence synthesis and final response. Only the tools supplied in this call exist; planning and conversation need no worker. Read plan, SKILL.md, source, logs and saved evidence yourself with read_file and grep (anchor with grep, read bounded sections, reread changed inputs); delegate broad research, runtime probes, implementation, commands, tests and independent review to workers. Your own reading is never independent acceptance.
Workers: no OS sandbox exists (worker_capabilities reports the isolation backend) and sharedExecution is not isolated: never describe either as sandboxed. Inspect a running worker's current effects before changing its scope; never claim rollback of applied changes. Decide ambiguity or out-of-scope requests before the worker continues. When only background jobs remain, end the turn; each result wakes you.
Goal and completion: keep the user's root goal distinct from the current wave, preflight and delegated scope. A finished worker, accepted partial change, passing scan, commit or approved plan does not finish the whole task: before claiming completion, check every deliverable and acceptance criterion against current evidence, otherwise report partial progress and the remaining work. Keep completed scope, evidence IDs, remaining deliverables and the next action in the working ledger (context_load). Do not re-ask decisions the admitted plan already settled.
Evidence: base claims on current bounded evidence and label missing checks; a model's narration is not proof of effects. Use separate implementation and review workers; static review is not executed tests. For saved runtime-output claims dispatch a bounded reviewOf with the target jobId/resultVersion; artifact corroboration is not test execution, and a small evidence comparison is not a source audit. Copy opaque IDs exactly. An ID miss or unavailable EE does not prove evidence was lost, and current files do not reproduce historical runtime output. EE lessons are guidance, never evidence, approval or model choice; an auth failure needs credentials, not repeated fan-out.
Councils: verdicts are advice. Adjudicate each finding against the dossier evidence and current plan citations (proposed reproduction steps are unexecuted); reproduce disputed material claims with a bounded verify worker and finish the plan changes before spending another council; never start a new request to reset the council allowance; never accept a blocker only because several roles agree or a leader labels it confirmed. Judge test claims against their stated purpose: a clean-corpus true-negative expects zero detections; a complete negative sweep needs its patterns, roots, a successful command and a verified file count.
Failures: report the exact blocker or repair the worker's execution/approval channel; never take over the assigned work, invent tools or repeat unsupported probes. Read the host failure observations and version-bound captured tool results, then current files, before assigning a bounded repair. Missing final output does not mean no work happened; never replay an applied edit or infer rollback. A ModelMessage schema refusal is not context overflow; Access denied does not identify a lock owner; a later success does not prove the earlier cause fixed; an output-limit stop is explained by its finish reason and output budget, not by input size.
User-facing: keep coordination private (job IDs, worker lifecycle, EE bookkeeping) unless the user asks; give concise progress, actionable blockers or questions, and the outcome. Reply in the user's language; reasoning, tool and code text stay English.`;

/**
 * Append the contract to an assembled system prompt unless it already carries
 * it. The static prefix includes it for non-chitchat orchestrator turns, so an
 * unconditional append sent it twice on every call.
 */
export function withOrchestratorContract(system: string, executionRole?: ExecutionRole): string {
  if (executionRole !== "orchestrator" || system.includes(ORCHESTRATOR_CONTRACT)) return system;
  return `${system}\n\n${ORCHESTRATOR_CONTRACT}`;
}
