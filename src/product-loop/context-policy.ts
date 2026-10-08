import type { CustomerDecision, Phase, PhaseDigestEntry, PhaseHistoryEntry } from "./types.js";

/*
 * Sprint context assembly for the phase-orchestrated `/ideal` loop.
 *
 * The context used to be squeezed into byte budgets (8,192 bytes for the whole
 * sprint context, 4,096 for the phase digest, oldest entries dropped first).
 * Those were character budgets, not a context-window guard: they bound what a
 * sprint may know about its own run regardless of the model's window. `/ideal`
 * has no limits (user decision), so every block is kept whole. The request still
 * has to fit the model's real window — that is compaction's job in the
 * orchestrator, which reads the actual window, not this module's.
 */

export interface BuildSprintContextArgs {
  projectContextFormatted: string;
  customerDecisions: CustomerDecision[];
  phaseHistory: PhaseHistoryEntry[];
  currentPhase: Phase;
  phaseDigest: PhaseDigestEntry[];
  sprintTail: string;
}

function renderDecisions(items: CustomerDecision[]): string {
  if (!items.length) return "## Customer Decisions\n(none)";
  const lines = ["## Customer Decisions (verbatim, never summarized)"];
  for (const d of items) {
    const fb = d.feedback ? ` — ${d.feedback}` : "";
    lines.push(`- seq ${d.seq}, phase ${d.phaseId} sprint ${d.sprintN}: ${d.verdict.toUpperCase()}${fb}`);
  }
  return lines.join("\n");
}

function renderHistory(items: PhaseHistoryEntry[]): string {
  if (!items.length) return "## Phase History\n(none)";
  const lines = ["## Phase History"];
  for (const h of items) lines.push(`- ${h.phaseId} (exited ${h.exitedAtUtc}): ${h.exitSummary}`);
  return lines.join("\n");
}

function renderCurrent(p: Phase): string {
  return [
    `## Current Phase`,
    `Goal: ${p.goal}`,
    `SuccessCriteria: ${p.successCriteria.join("; ")}`,
    `Scope: ${p.scope}`,
  ].join("\n");
}

function renderDigest(items: PhaseDigestEntry[]): string {
  if (!items.length) return "## Phase Digest\n(none)";
  const lines = ["## Phase Digest"];
  for (const d of items) lines.push(`- sprint ${d.sprintN} (${d.timestampUtc}): ${d.lessonText}`);
  return lines.join("\n");
}

export function buildSprintContext(args: BuildSprintContextArgs): string {
  return [
    args.projectContextFormatted,
    renderDecisions(args.customerDecisions),
    renderHistory(args.phaseHistory),
    renderCurrent(args.currentPhase),
    renderDigest(args.phaseDigest),
    `## Sprint Tail\n${args.sprintTail}`,
  ].join("\n\n");
}

export function digestSprintIntoPhase(existing: PhaseDigestEntry[], newEntry: PhaseDigestEntry): PhaseDigestEntry[] {
  return [...existing, newEntry];
}

export async function handoffPhaseToNext(args: {
  phaseId: string;
  sprintsExecuted: number;
  criteriaMet: number;
  totalCriteria: number;
  leader: import("./discovery-prompt-parser.js").LeaderLike;
  backoffDelays?: number[];
}): Promise<{ exitSummary: string; usedFallback: boolean }> {
  const prompt =
    `Summarize phase ${args.phaseId}: ${args.sprintsExecuted} sprints executed, ` +
    `${args.criteriaMet}/${args.totalCriteria} criteria met. ` +
    `Output a single sentence (≤300 chars) describing outcome and key carryover for the next phase.`;
  try {
    const { withRateLimitBackoff } = await import("./discovery-recommender.js");
    const res = await withRateLimitBackoff(
      () => args.leader.generate({ system: "You write concise phase exit summaries.", prompt, maxTokens: 200 }),
      { delays: args.backoffDelays },
    );
    return { exitSummary: res.content.trim().slice(0, 300), usedFallback: false };
  } catch (err) {
    console.error(
      `[context-policy] phase handoff summary failed for ${args.phaseId}; using the deterministic summary: ${(err as Error)?.message}`,
    );
    return { exitSummary: deterministicHandoff(args), usedFallback: true };
  }
}

function deterministicHandoff(args: {
  phaseId: string;
  sprintsExecuted: number;
  criteriaMet: number;
  totalCriteria: number;
}): string {
  return `Phase ${args.phaseId} exited after ${args.sprintsExecuted} sprints, ${args.criteriaMet}/${args.totalCriteria} criteria met`;
}
