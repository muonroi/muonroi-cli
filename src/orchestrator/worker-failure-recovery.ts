import { getModelInfo } from "../models/registry.js";
import type { DelegationFailureRecovery, DelegationRun } from "../types/index.js";
import { logger } from "../utils/logger.js";

interface FailureRecord {
  error?: string;
  /** Worker model of the job (StoredDelegation.modelId / model); names its provider. */
  modelId?: string;
  model?: string;
  artifactError?: string;
  toolArtifacts?: Array<{ toolCallId: string; toolName: string; digest: string }>;
}
const MUTATIONS = new Set(["edit_file", "write_file", "apply_patch"]);
const COMMANDS = new Set(["bash", "verification_run", "run_gate"]);
const MAX_ATTEMPTED_WRITE_PATHS = 20;

export function isMutationTool(toolName: string): boolean {
  return MUTATIONS.has(toolName);
}

/**
 * File paths named by captured mutation calls, newest last, de-duplicated.
 * Read from the saved tool inputs (`file_path`/`path`), so they say which files
 * a worker ATTEMPTED to change — not that the change landed or survived. The
 * orchestrator still has to inspect the files; this tells it where to look.
 * Measured need (session 4edc02516a92): after clever-amber-heron and
 * keen-ivory-heron failed mid-edit, the orchestrator's next dispatch was a
 * read-only state check (quiet-white-badger, steady-ivory-owl) just to learn
 * what the failed worker had touched.
 */
export function attemptedWritePaths(
  captures: ReadonlyArray<{ toolName: string; input?: unknown }>,
  limit = MAX_ATTEMPTED_WRITE_PATHS,
): string[] | undefined {
  const paths: string[] = [];
  for (const capture of captures) {
    if (!MUTATIONS.has(capture.toolName)) continue;
    const input = capture.input as { file_path?: unknown; path?: unknown } | undefined;
    const target = typeof input?.file_path === "string" ? input.file_path : input?.path;
    if (typeof target !== "string" || !target) continue;
    const at = paths.indexOf(target);
    if (at >= 0) paths.splice(at, 1);
    paths.push(target);
  }
  return paths.length ? paths.slice(-limit) : undefined;
}

// Provider answers, matched on the TERMINAL failure text only (never on partial
// narration before "Task failed:"). Order matters: a 401 body that mentions
// "rate" is still an auth failure; a context-length 400 is not a schema refusal.
const AUTH_FAILURE_RE =
  /^HTTP 40[13]\b|\b(?:invalid|incorrect|missing|expired|revoked)[ _-]?(?:api[ _-]?key|x-api-key|token|credentials?)\b|\binvalid_api_key\b|\bunauthori[sz]ed\b|\bauthentication(?:_error| failed| error| required)\b|^API key required\b|\boauth\b.{0,40}\b(?:expired|invalid|revoked|refresh failed)\b/i;
const RATE_LIMIT_RE =
  /^HTTP 429\b|^Rate-limited by the provider account\b|\brate[ _-]?limit(?:ed)?\b.{0,30}\b(?:reached|exceeded|hit)\b|\btoo many requests\b|\binsufficient_quota\b/i;
const CONTEXT_OVERFLOW_RE =
  /^Input ceiling exceeded\b|\bcontext[ _-]length[ _-]exceeded\b|\bmaximum context length\b|\bcontext window\b.{0,40}\b(?:exceed|too (?:long|large))|\bprompt is too long\b|\btoo many (?:input )?tokens\b|\brequest too large\b|\binput (?:is )?too long\b|\breduce the length of the messages\b/i;
const PROVIDER_SCHEMA_RE =
  /\binvalid (?:json )?schema\b|\bschema (?:validation failed|is invalid)\b|\binvalid_function_parameters\b|\bfunction(?:s)?\.parameters\b|\btools\[\d+\]\b.{0,60}\b(?:invalid|schema)\b|\bresponse_format\b.{0,40}\binvalid\b/i;

/** Host instruction per typed symptom — the orchestrator does not interpret raw errors. */
const SYMPTOM_ACTION: Partial<Record<DelegationFailureRecovery["symptom"], string>> = {
  "auth-failure":
    "The worker's provider rejected its credentials. Further workers on this provider are refused for the session; pick a worker model from another provider or ask the user to re-authenticate.",
  "rate-limit":
    "The provider account is rate-limited (shared by every agent). Do not re-launch at once; wait for running workers or use another provider.",
  "context-overflow":
    "The worker's input exceeded the model's context or the host input ceiling. Re-dispatch with a narrower assignment or fewer files; do not resend the same prompt.",
  "provider-schema-refusal":
    "The provider rejected a tool/response schema before any work ran. Retrying the same request will fail the same way; use a worker model from another provider.",
  "output-limit":
    "The answer hit the output-token limit. Ask for a shorter deliverable (or split it); the partial text is not a complete result.",
  "model-message-schema":
    "The host message history failed the AI SDK schema. This is not evidence of context overflow or prompt length.",
};

/** Provider of a job's worker model from the catalog, or undefined. */
function providerOf(record: FailureRecord): string | undefined {
  const model = record.modelId ?? record.model;
  if (!model) return undefined;
  try {
    return getModelInfo(model)?.provider;
  } catch (err) {
    logger.file("warn", "orchestrator", "Worker failure provider lookup failed", { model, error: String(err) });
    return undefined;
  }
}

/** Typed symptom of a failure's terminal text. */
export function classifyFailureTerminal(error: string): DelegationFailureRecovery["symptom"] {
  // Exclude earlier partial model narration. Match only explicit terminal markers.
  const marker = error.lastIndexOf("Task failed:");
  const terminal = (marker >= 0 ? error.slice(marker + "Task failed:".length) : error).trim();
  // A host-labelled incomplete result is "<worker_incomplete: …>\n<partial>": the marker line is the failure.
  const head = terminal.startsWith("worker_incomplete:") ? (terminal.split("\n", 1)[0] ?? terminal) : terminal;
  if (/^worker_incomplete: no final answer was produced\b/.test(head)) return "missing-final-answer";
  if (/^worker_incomplete: provider stalled\b/.test(head)) return "provider-stall";
  if (/^worker_incomplete:.*output.limit/i.test(head)) return "output-limit";
  if (head.startsWith("worker_incomplete:")) return "unclassified";
  if (/^Invalid prompt: The messages do not match the ModelMessage\[\] schema\b/.test(head))
    return "model-message-schema";
  if (/^Provider stalled\b|no response from the model provider/i.test(head)) return "provider-stall";
  if (AUTH_FAILURE_RE.test(head)) return "auth-failure";
  if (RATE_LIMIT_RE.test(head)) return "rate-limit";
  if (CONTEXT_OVERFLOW_RE.test(head)) return "context-overflow";
  if (/^HTTP 4\d\d\b/.test(head) && PROVIDER_SCHEMA_RE.test(head)) return "provider-schema-refusal";
  return "unclassified";
}

export function workerFailureRecovery(
  record: FailureRecord,
  captures?: ReadonlyArray<{ toolName: string; input?: unknown }>,
): DelegationFailureRecovery {
  const symptom = classifyFailureTerminal(record.error ?? "");
  const provider = providerOf(record);
  const action = SYMPTOM_ACTION[symptom];
  const artifacts = record.toolArtifacts ?? [];
  const writePaths = captures ? attemptedWritePaths(captures) : undefined;
  return {
    symptom,
    ...(provider ? { provider } : {}),
    ...(action ? { action } : {}),
    rootCause: "not-established",
    capturedToolCalls: artifacts.length,
    mutationToolCalls: artifacts.filter((a) => MUTATIONS.has(a.toolName)).length,
    commandToolCalls: artifacts.filter((a) => COMMANDS.has(a.toolName)).length,
    ...(record.artifactError ? { artifactError: record.artifactError } : {}),
    ...(writePaths ? { attemptedWritePaths: writePaths } : {}),
    inspect: artifacts
      .filter((a) => MUTATIONS.has(a.toolName) || COMMANDS.has(a.toolName))
      .slice(-8)
      .map(({ toolCallId, toolName, digest }) => ({ toolCallId, toolName, digest })),
  };
}

/**
 * Providers whose worker failed authentication earlier in this session. One
 * auth failure is enough: every later worker on that provider would spend a
 * dispatch (and the user's wait) to receive the same 401.
 */
export function authFailedProviders(runs: ReadonlyArray<DelegationRun>): Map<string, string> {
  const failed = new Map<string, string>();
  for (const run of runs) {
    const recovery = run.failureRecovery;
    if (run.status !== "error" || recovery?.symptom !== "auth-failure" || !recovery.provider) continue;
    if (!failed.has(recovery.provider)) failed.set(recovery.provider, run.id);
  }
  return failed;
}

/** Refusal for a worker dispatch to a provider that already failed auth this session, or null. */
export function authFanoutRefusal(runs: ReadonlyArray<DelegationRun>, provider: string | undefined): string | null {
  if (!provider) return null;
  const jobId = authFailedProviders(runs).get(provider);
  if (!jobId) return null;
  return `worker_provider_auth_refused: provider "${provider}" rejected authentication for worker jobId=${jobId} earlier this session, so no further workers are dispatched to it. Choose a worker model from another provider (worker_models), or have the user re-authenticate ("muonroi-cli keys login ${provider}") and start a new session.`;
}

export function failureRecoveryGuidance(recovery: DelegationFailureRecovery): string {
  return [
    ...(recovery.action ? [`Host failure type: ${recovery.symptom}. ${recovery.action}`] : []),
    `Host failure observations: ${JSON.stringify(recovery)}`,
    "Do not replay the original edit/command assignment. A failed worker can leave applied or partial changes; captured calls are not proof of success, rollback or current file contents. Read the raw captures using this jobId/resultVersion and the manifest toolCallIds, then inspect current files/diff before assigning only the remaining repair. In-flight or uncaptured effects remain unknown. Keep execution failed and acceptance unverified until fresh scoped verification succeeds.",
    "attemptedWritePaths (when present) names the files the worker's captured edit/write calls targeted — where to look first, not proof any change landed.",
    "A schema error does not establish prompt length or context overflow. Access denied does not identify a lock holder. A later successful worker establishes recovery for its own run, not a fix to the earlier root cause. Preserve the exact error and evidence limits; do not terminate external processes or clear shared caches to diagnose it.",
  ].join("\n");
}
