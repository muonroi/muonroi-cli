import type { DelegationFailureRecovery } from "../types/index.js";

interface FailureRecord {
  error?: string;
  artifactError?: string;
  toolArtifacts?: Array<{ toolCallId: string; toolName: string; digest: string }>;
}
const MUTATIONS = new Set(["edit_file", "write_file", "apply_patch"]);
const COMMANDS = new Set(["bash", "verification_run", "run_gate"]);

export function workerFailureRecovery(record: FailureRecord): DelegationFailureRecovery {
  const error = record.error ?? "";
  // Exclude earlier partial model narration. Match only explicit terminal markers.
  const marker = error.lastIndexOf("Task failed:");
  const terminal = (marker >= 0 ? error.slice(marker + "Task failed:".length) : error).trim();
  let symptom: DelegationFailureRecovery["symptom"] = "unclassified";
  if (/^worker_incomplete: no final answer was produced\b/.test(terminal)) symptom = "missing-final-answer";
  else if (/^worker_incomplete:.*output.limit/i.test(terminal)) symptom = "output-limit";
  else if (/^Invalid prompt: The messages do not match the ModelMessage\[\] schema\b/.test(terminal))
    symptom = "model-message-schema";
  const artifacts = record.toolArtifacts ?? [];
  return {
    symptom,
    rootCause: "not-established",
    capturedToolCalls: artifacts.length,
    mutationToolCalls: artifacts.filter((a) => MUTATIONS.has(a.toolName)).length,
    commandToolCalls: artifacts.filter((a) => COMMANDS.has(a.toolName)).length,
    ...(record.artifactError ? { artifactError: record.artifactError } : {}),
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
    "A schema error does not establish prompt length or context overflow. Access denied does not identify a lock holder. A later successful worker establishes recovery for its own run, not a fix to the earlier root cause. Preserve the exact error and evidence limits; do not terminate external processes or clear shared caches to diagnose it.",
  ].join("\n");
}
