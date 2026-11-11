/**
 * Structured worker brief (M18). The orchestrator contract used to tell the
 * model in prose that "a worker prompt states role, scope/workspace, input,
 * question, exclusions, budget and evidence to return"; the host could not
 * check it. These are now schema fields of task/delegate: the schema requires
 * all seven when a brief is given, and the host assembles them into the worker
 * prompt. A plain `prompt` stays accepted (backward compatibility) and is
 * appended as additional instructions when both are supplied.
 */

export const WORKER_BRIEF_FIELDS = [
  ["role", "Role", "e.g. implementer, reviewer"],
  ["scope", "Scope/workspace", "files/dirs/workspace"],
  ["input", "Input", "starting facts, paths, prior evidence"],
  ["question", "Question", "exact task"],
  ["exclusions", "Exclusions", "out of scope"],
  ["budget", "Budget", "steps/files/output bound"],
  ["evidence", "Return evidence", "e.g. file:line, command+exit, test names"],
] as const;

export type WorkerBriefField = (typeof WORKER_BRIEF_FIELDS)[number][0];
export type WorkerBrief = Record<WorkerBriefField, string>;

export const WORKER_BRIEF_SCHEMA = {
  type: "object",
  description: "Worker brief; the host assembles it into the worker prompt.",
  properties: Object.fromEntries(
    WORKER_BRIEF_FIELDS.map(([key, , description]) => [key, { type: "string", minLength: 1, description }]),
  ),
  required: WORKER_BRIEF_FIELDS.map(([key]) => key),
  additionalProperties: false,
} as const;

/** Assemble the worker prompt from `brief` and/or `prompt`; an error string when neither is usable. */
export function assembleWorkerPrompt(input: {
  prompt?: unknown;
  brief?: unknown;
}): { prompt: string } | { error: string } {
  const extra = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (input.brief === undefined || input.brief === null) {
    return extra
      ? { prompt: input.prompt as string }
      : {
          error:
            "worker_prompt_required: supply brief (all seven fields) or a non-empty prompt. No worker was started.",
        };
  }
  const brief = typeof input.brief === "object" ? (input.brief as Record<string, unknown>) : {};
  const missing = WORKER_BRIEF_FIELDS.filter(
    ([key]) => typeof brief[key] !== "string" || !String(brief[key]).trim(),
  ).map(([key]) => key);
  if (missing.length)
    return {
      error: `worker_brief_incomplete: brief is missing ${missing.join(", ")}. Every field is required (use "none" where nothing applies). No worker was started.`,
    };
  const lines = WORKER_BRIEF_FIELDS.map(([key, label]) => `${label}: ${String(brief[key]).trim()}`);
  return { prompt: extra ? `${lines.join("\n")}\n\nAdditional instructions:\n${extra}` : lines.join("\n") };
}
