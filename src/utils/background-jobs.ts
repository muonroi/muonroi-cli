/**
 * src/utils/background-jobs.ts
 *
 * Shared vocabulary for work the main agent spawns and does NOT wait on:
 * background delegations (`delegate`, `task` with the explore agent) and
 * backgrounded shells (`bash background:true`, or a command bash auto-detects
 * as long-running).
 *
 * The spawning tools return a plain-text "started" line to the model, and that
 * same text is all the UI receives as the tool result. A started job is NOT a
 * finished one, so the UI recovers the job's id from that line and asks the
 * orchestrator for the job's live state instead of treating the tool result as
 * the outcome. The format and the parser live together here so they cannot
 * drift apart.
 */

export type BackgroundJobState = "running" | "done" | "failed";

export interface BackgroundDelegationState {
  state: BackgroundJobState;
  /** One-line result summary once the delegation has finished. */
  summary?: string;
}

export interface BackgroundProcessState {
  state: BackgroundJobState;
  exitCode: number | null;
}

/** Live state of every background job the current CLI process can see. */
export interface BackgroundJobSnapshot {
  /** Keyed by delegation id (e.g. "brisk-amber-fox"). */
  delegations: Record<string, BackgroundDelegationState>;
  /** Keyed by {@link processJobKey} — the id alone restarts at 1 every CLI run. */
  processes: Record<string, BackgroundProcessState>;
  /**
   * Epoch ms since which `processes` is complete. A shell spawned before it
   * (a resumed session's transcript) belonged to an earlier CLI run and is gone.
   */
  processesSince?: number;
}

export const EMPTY_BACKGROUND_SNAPSHOT: BackgroundJobSnapshot = { delegations: {}, processes: {} };

const DELEGATION_STARTED = "Delegation started: ";
const DELEGATION_STARTED_RE = /Delegation started: ([a-z]+-[a-z]+-[a-z]+)/;

const PROCESS_STARTED_RE = /Background process started \(id: (\d+), pid: (\d+)\)/;

export function formatDelegationStarted(id: string): string {
  return `${DELEGATION_STARTED}${id}`;
}

export function parseDelegationStartedId(text: string | undefined): string | null {
  if (!text) return null;
  return DELEGATION_STARTED_RE.exec(text)?.[1] ?? null;
}

export function formatBackgroundProcessStarted(id: number, pid: number): string {
  return `Background process started (id: ${id}, pid: ${pid})`;
}

export function parseBackgroundProcessStarted(text: string | undefined): { id: number; pid: number } | null {
  if (!text) return null;
  const m = PROCESS_STARTED_RE.exec(text);
  return m ? { id: Number(m[1]), pid: Number(m[2]) } : null;
}

/** Stable key for a background process: process ids are only unique per CLI run. */
export function processJobKey(id: number, pid: number): string {
  return `${id}:${pid}`;
}

/**
 * Told to the model with every "started" result. Without it, cheap models
 * fill the wait with `sleep 120; cat out.txt`, which keeps the turn — and the
 * user's prompt — locked for the whole job.
 */
export const BACKGROUND_WAIT_GUIDANCE =
  "Do NOT wait for it with sleep or by polling. If you have nothing else to do, end your turn now — " +
  "you will be woken automatically with the result when it finishes, and the user can keep working meanwhile.";

/** A single `sleep` at or above this many seconds while background jobs run is a poll. */
export const SLEEP_POLL_THRESHOLD_SECONDS = 20;

const SLEEP_RE = /(?:^|[;&|(]|\bdo|\bthen)\s*sleep\s+(\d+(?:\.\d+)?)(s|m|h)?\b/g;
const START_SLEEP_RE = /\bStart-Sleep\b[^;&|]*?(?:-s(?:econds)?\s+)?(\d+(?:\.\d+)?)/gi;
const TIMEOUT_RE = /(?:^|[;&|])\s*timeout\s+\/t\s+(\d+)/gi;

/**
 * Longest single sleep a shell command performs, in seconds (0 when none).
 * Recognises POSIX `sleep N[smh]`, PowerShell `Start-Sleep [-Seconds] N` and
 * cmd `timeout /t N` at the start of any command segment.
 */
export function longestSleepSeconds(command: string): number {
  let max = 0;
  for (const m of command.matchAll(SLEEP_RE)) {
    const unit = m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 1;
    max = Math.max(max, Number(m[1]) * unit);
  }
  for (const m of command.matchAll(START_SLEEP_RE)) {
    // `-Milliseconds N` is not seconds — skip rather than misread it.
    if (/-m(?:illiseconds)?\s/i.test(m[0])) continue;
    max = Math.max(max, Number(m[1]));
  }
  for (const m of command.matchAll(TIMEOUT_RE)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Refusal text for a foreground sleep that would only wait on background jobs. */
export function sleepPollRefusal(seconds: number): string {
  return (
    `Refused: \`sleep ${seconds}\` while background jobs are running only blocks the user — the turn stays ` +
    '"running" and they cannot send anything until it ends. ' +
    "End your turn instead: you will be woken automatically with each job's result when it finishes. " +
    "If you need a job's output right now, read it once with process_logs(id) or delegation_read(id)."
  );
}

/**
 * Auto-wake: when background jobs finish while the agent is idle, the UI starts
 * a turn with their results so the agent picks the work back up by itself.
 * On by default; `MUONROI_BACKGROUND_AUTOWAKE=0` leaves the notices in the
 * transcript for the user's next message instead.
 */
export function isBackgroundAutoWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MUONROI_BACKGROUND_AUTOWAKE?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** The user turn that wakes the agent with finished background jobs' notices. */
export function buildBackgroundWakePrompt(notices: string[]): string {
  return [
    "[background jobs finished]",
    ...notices,
    "",
    "Background work you launched earlier has finished (notices above). Continue the task that was waiting " +
      "on it, using these results. If nothing depends on them, give the user a brief summary of the outcome.",
  ].join("\n\n");
}

/** Transcript line shown in place of the full wake prompt. */
export function backgroundWakeLabel(count: number): string {
  return count === 1 ? "⟲ background job finished — resuming" : `⟲ ${count} background jobs finished — resuming`;
}

export interface ProviderCapacity {
  provider: string;
  concurrency?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  /** Agents that will be calling this provider: the main agent plus running background agents. */
  agents: number;
}

/**
 * Note appended to a delegation's "started" result once the agents sharing a
 * provider reach its concurrency limit. Calls past the limit are queued by the
 * machine-wide ledger (no 429), so extra agents make the fan-out SLOWER, not
 * faster — the agent needs to know that to size its next fan-out. Null below
 * the limit, so the common case costs no tokens.
 */
export function providerCapacityNote(c: ProviderCapacity): string | null {
  if (!c.concurrency || c.agents < c.concurrency) return null;
  const limits = [
    `${c.concurrency} concurrent requests`,
    c.requestsPerMinute ? `${c.requestsPerMinute} requests/min` : null,
    c.tokensPerMinute ? `${c.tokensPerMinute.toLocaleString("en-US")} tokens/min` : null,
  ]
    .filter(Boolean)
    .join(" / ");
  return (
    `Capacity: ${c.agents} agents (you + ${c.agents - 1} background) now share the ${c.provider} account limit of ${limits}. ` +
    "Requests past the limit wait for a free slot (paced, no 429), so more agents than that run slower, not faster. " +
    "Do not launch more until some finish; prefer fewer, broader delegations."
  );
}

/**
 * Parallel background agents allowed for a provider whose catalog/account
 * declares no concurrency. A policy number, not a claim about any provider:
 * every provider rate-limits, and an undeclared limit is not an absent one.
 */
export const UNDECLARED_MAX_PARALLEL_AGENTS = 3;

/**
 * How many background agents may run at once against one provider account.
 * One concurrency slot is left for the main agent itself. Override with
 * `MUONROI_MAX_PARALLEL_DELEGATIONS` (a positive integer).
 *
 * The SAME number is told to the agent (system-prompt rule) and enforced by the
 * CLI (delegation start refuses past it), so the rule and the guard never
 * disagree.
 */
export function maxParallelBackgroundAgents(
  concurrency: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env.MUONROI_MAX_PARALLEL_DELEGATIONS);
  if (Number.isInteger(override) && override > 0) return override;
  if (concurrency && concurrency > 0) return Math.max(1, concurrency - 1);
  return UNDECLARED_MAX_PARALLEL_AGENTS;
}

/** Refusal for a delegation launched past {@link maxParallelBackgroundAgents}. */
export function parallelLimitRefusal(provider: string, running: number, max: number): string {
  return (
    `Refused: ${running} background agents are already running on the ${provider} account and the limit is ${max} ` +
    "at once (they share one rate-limit budget with you; more in parallel only produces 429 rate-limit errors). " +
    "End your turn or do other work — you will be woken as each finishes — then launch the next one."
  );
}

export interface RateLimitRuleInput {
  provider: string;
  concurrency?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxParallelAgents: number;
}

/**
 * The agent-facing half of rate-limit handling, appended to the main agent's
 * system prompt for EVERY provider (the CLI half is the machine-wide ledger +
 * retry + the parallel-agent guard). Numbers come from the catalog/account
 * settings; an undeclared limit is stated as such, never as "unlimited".
 */
export function buildRateLimitRule(r: RateLimitRuleInput): string {
  const limits = [
    r.concurrency ? `${r.concurrency} concurrent requests` : null,
    r.requestsPerMinute ? `${r.requestsPerMinute} requests/min` : null,
    r.tokensPerMinute ? `${r.tokensPerMinute.toLocaleString("en-US")} tokens/min` : null,
  ].filter(Boolean);
  const declared = limits.length > 0 ? limits.join(", ") : "not published — treat it as limited";
  return [
    "",
    "PROVIDER RATE LIMITS (one account budget shared by you AND every sub-agent / background agent):",
    `- ${r.provider} account limit: ${declared}.`,
    `- Run at most ${r.maxParallelAgents} background agents at once; the CLI refuses more. Launch in batches of at most ${r.maxParallelAgents} and wait for completion notices before the next batch.`,
    "- Every agent's prompt and context count against tokens/min. Keep delegation prompts focused; a large main context alone can exhaust the budget, so compact before fanning out.",
    "- The CLI already paces calls and retries rate-limit (429) errors with backoff. If a call or a delegation still fails with a rate-limit error, the budget is exhausted: do NOT respawn at once or launch probe agents to test availability — reduce parallelism, end your turn and retry after the wait.",
  ].join("\n");
}
