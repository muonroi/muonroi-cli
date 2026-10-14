/**
 * src/ui/utils/background-wake.ts
 *
 * Resume the agent when a background job it started finishes.
 *
 * Without this, "background" only described how the job was spawned: nothing
 * told the agent when it ended, so the model held its turn open with
 * `sleep 120; cat result` to wait — the CLI stayed busy and the user could not
 * keep working. Now the agent ends its turn, the UI poll claims the job's
 * completion notice (already appended to the agent's context as a system
 * message), and sends this prompt to start a turn that acts on it.
 */

export const BACKGROUND_WAKE_PROMPT =
  "[Background job finished] A background job you started has finished — its result is in the system message just above. Continue the task with it. If nothing is left to do, give the user a short summary of the result.";

/** What the transcript shows for the resume turn, instead of the prompt. */
export const BACKGROUND_WAKE_DISPLAY = "↻ Background job finished — resuming";

/** On by default; `MUONROI_BACKGROUND_WAKE=0` keeps notices transcript-only. */
export function isBackgroundWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MUONROI_BACKGROUND_WAKE?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}
