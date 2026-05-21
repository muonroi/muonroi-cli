import type { CustomerDecision, Phase, PhaseDigestEntry, PhaseHistoryEntry } from "./types.js";

export const CONTEXT_CAPS = {
  SPRINT_CONTEXT_BYTES: 8192,
  PHASE_DIGEST_BYTES: 4096,
  PHASE_HISTORY_BYTES: 2048,
} as const;

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

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncTail(s: string, budget: number): string {
  if (bytes(s) <= budget) return s;
  const trimmed = s.slice(0, Math.max(0, budget - 32));
  return `${trimmed}\n[…truncated ${bytes(s) - bytes(trimmed)} bytes]`;
}

function truncOldestFirst(lines: string[], header: string, budget: number): string {
  const joined = [header, ...lines].join("\n");
  if (bytes(joined) <= budget) return joined;
  let dropped = 0;
  while (lines.length > 1 && bytes([header, ...lines].join("\n")) > budget - 32) {
    lines.shift();
    dropped += 1;
  }
  return [header, ...lines, `[…truncated ${dropped} oldest entries]`].join("\n");
}

export function buildSprintContext(args: BuildSprintContextArgs): string {
  const project = args.projectContextFormatted;
  const decisions = renderDecisions(args.customerDecisions);
  const essentialSize = bytes(project) + bytes(decisions) + 4;

  if (essentialSize > CONTEXT_CAPS.SPRINT_CONTEXT_BYTES) {
    return [
      project,
      decisions,
      `[oversize: essential blocks alone = ${essentialSize} bytes; raise SPRINT_CONTEXT_BYTES or trim project-context]`,
    ].join("\n\n");
  }

  const remaining = CONTEXT_CAPS.SPRINT_CONTEXT_BYTES - essentialSize;
  const current = renderCurrent(args.currentPhase);
  const history = renderHistory(args.phaseHistory);
  const digest = renderDigest(args.phaseDigest);
  const tail = `## Sprint Tail\n${args.sprintTail}`;

  let used = 0;
  const out: string[] = [project, decisions];

  const addIfFits = (block: string): boolean => {
    const blockSize = bytes(block) + 2;
    if (used + blockSize <= remaining) {
      out.push(block);
      used += blockSize;
      return true;
    }
    return false;
  };

  if (!addIfFits(history)) {
    const lines = args.phaseHistory.map((h) => `- ${h.phaseId} (exited ${h.exitedAtUtc}): ${h.exitSummary}`);
    out.push(truncOldestFirst(lines, "## Phase History", remaining - used - 2));
    used = remaining;
  }

  if (used < remaining) addIfFits(current);

  if (used < remaining && !addIfFits(digest)) {
    const lines = args.phaseDigest.map((d) => `- sprint ${d.sprintN} (${d.timestampUtc}): ${d.lessonText}`);
    out.push(truncOldestFirst(lines, "## Phase Digest", remaining - used - 2));
    used = remaining;
  }

  if (used < remaining) {
    const tailBudget = remaining - used - 2;
    out.push(truncTail(tail, tailBudget));
  }

  return out.join("\n\n");
}

export function digestSprintIntoPhase(existing: PhaseDigestEntry[], newEntry: PhaseDigestEntry): PhaseDigestEntry[] {
  const next = [...existing, newEntry];
  let dropped = 0;
  while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), "utf8") > CONTEXT_CAPS.PHASE_DIGEST_BYTES) {
    next.shift();
    dropped += 1;
  }
  if (dropped > 0) {
    next.unshift({
      sprintN: -1,
      timestampUtc: new Date().toISOString(),
      lessonText: `[digest pruned: ${dropped} entries dropped, oldest-first]`,
    });
  }
  return next;
}

export async function handoffPhaseToNext(args: {
  phaseId: string;
  sprintsExecuted: number;
  criteriaMet: number;
  totalCriteria: number;
  leader: import("./discovery-prompt-parser.js").LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<{ exitSummary: string; usedFallback: boolean }> {
  const floor = Math.max(0.05, 0.005 * args.capUsd);
  if (args.remainingUsd < floor) {
    return { exitSummary: deterministicHandoff(args), usedFallback: true };
  }
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
  } catch {
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
