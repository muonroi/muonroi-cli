import type { DelegationFailureRecovery } from "../types/index.js";

interface FailureRecord {
  error?: string;
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
  return paths.length ? paths.slice(-MAX_ATTEMPTED_WRITE_PATHS) : undefined;
}

export function workerFailureRecovery(
  record: FailureRecord,
  captures?: ReadonlyArray<{ toolName: string; input?: unknown }>,
): DelegationFailureRecovery {
  const error = record.error ?? "";
  // Exclude earlier partial model narration. Match only explicit terminal markers.
  const marker = error.lastIndexOf("Task failed:");
  const terminal = (marker >= 0 ? error.slice(marker + "Task failed:".length) : error).trim();
  let symptom: DelegationFailureRecovery["symptom"] = "unclassified";
  if (/^worker_incomplete: no final answer was produced\b/.test(terminal)) symptom = "missing-final-answer";
  else if (/^worker_incomplete: provider stalled\b/.test(terminal)) symptom = "provider-stall";
  else if (/^worker_incomplete:.*output.limit/i.test(terminal)) symptom = "output-limit";
  else if (/^Invalid prompt: The messages do not match the ModelMessage\[\] schema\b/.test(terminal))
    symptom = "model-message-schema";
  else if (/^Provider stalled\b|no response from the model provider/i.test(terminal)) symptom = "provider-stall";
  const artifacts = record.toolArtifacts ?? [];
  const writePaths = captures ? attemptedWritePaths(captures) : undefined;
  return {
    symptom,
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

export function failureRecoveryGuidance(recovery: DelegationFailureRecovery): string {
  return [
    `Host failure observations: ${JSON.stringify(recovery)}`,
    "Do not replay the original edit/command assignment. A failed worker can leave applied or partial changes; captured calls are not proof of success, rollback or current file contents. Read the raw captures using this jobId/resultVersion and the manifest toolCallIds, then inspect current files/diff before assigning only the remaining repair. In-flight or uncaptured effects remain unknown. Keep execution failed and acceptance unverified until fresh scoped verification succeeds.",
    "attemptedWritePaths (when present) names the files the worker's captured edit/write calls targeted — where to look first, not proof any change landed.",
    "A schema error does not establish prompt length or context overflow. Access denied does not identify a lock holder. A later successful worker establishes recovery for its own run, not a fix to the earlier root cause. Preserve the exact error and evidence limits; do not terminate external processes or clear shared caches to diagnose it.",
  ].join("\n");
}
