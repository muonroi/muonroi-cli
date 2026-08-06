import type { CouncilQuestionOption } from "../types/index.js";
import { buildIntentOptions, INTENT_COPY } from "./intent-card.js";
import type { IntentKind } from "./types.js";

/**
 * `council/launch-card` — design S1, the launch configurator.
 *
 * Today `/council` resolves a panel, a round budget and a research mode, then
 * starts spending without showing the user any of it. This is the one screen
 * between "I typed a topic" and "money is being spent": what the panel is, how
 * many rounds it may run, and the two ways to change the shape of the run
 * before it starts.
 *
 * Pure builder — no I/O, no yields — so the copy and the option set are unit
 * testable and the caller stays a thin emit.
 */

export interface LaunchPanelist {
  role: string;
  model: string;
  /** Task-adaptive persona name, when the planner assigned one. */
  stanceName?: string;
}

export interface LaunchCardInput {
  topic: string;
  leaderModelId: string;
  participants: readonly LaunchPanelist[];
  plannedRounds: number;
  /** Hard ceiling emergent rounds may reach, when known. */
  roundCeiling?: number | null;
  researchOn: boolean;
  costAware: boolean;
  /** Resolved debate language ("auto" when following the user's brief). */
  language?: string;
  /**
   * Measured mean spend per round from this machine's history, or null when
   * there is not enough history to project from. Null OMITS the cost line
   * entirely — see the estimate note below.
   */
  usdPerRound?: number | null;
  /** Provider id per model, injected so this module stays free of runtime lookups. */
  providerOf?: (modelId: string) => string | undefined;
  /**
   * Intent gate (design 2026-08-04). When present, the card leads with "what do
   * you want out of this run" and the answer LOCKS spec.intentKind before any
   * spend. Absent only where no human is present to answer
   * (`suppressPreDebateCards` — the agent-convened convene_council / runDebate
   * callers — or `sprintPlanningMode`), which keep the shape-only card. BOTH
   * the `/council` slash path and auto-council DO show the intent block.
   */
  intent?: { proposedKind: IntentKind; intentSummary: string };
}

export interface LaunchCard {
  question: string;
  context: string;
  options: CouncilQuestionOption[];
  defaultIndex: number;
}

/** `deepseek ×3 · siliconflow ×2` — the lineup, deduped in first-seen order. */
export function summariseProviders(
  participants: readonly LaunchPanelist[],
  providerOf?: (modelId: string) => string | undefined,
): string {
  if (!providerOf) return "";
  const counts = new Map<string, number>();
  for (const p of participants) {
    const id = providerOf(p.model);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  const parts = [...counts.entries()].map(([id, n]) => (n > 1 ? `${id} ×${n}` : id));
  return counts.size > 1 ? `${parts.join(" · ")} (multi-provider lineup)` : parts.join(" · ");
}

/** `3 max (up to 5 · leader may stop early on convergence)` */
export function summariseRoundBudget(planned: number, ceiling?: number | null): string {
  const base = `${planned} max`;
  const tail =
    ceiling && ceiling > planned
      ? `(up to ${ceiling} · leader may stop early on convergence)`
      : "(leader may stop early on convergence)";
  return `${base} ${tail}`;
}

/**
 * The projected bill, or "" when there is nothing to project from.
 *
 * Deliberately a RANGE anchored on measured history, and labelled with the fact
 * that it comes from past runs. A single point estimate implies a precision this
 * has no basis for: round cost varies with panel size and how long the models
 * argue, neither of which is known before the debate.
 */
export function summariseEstimate(usdPerRound: number | null | undefined, plannedRounds: number): string {
  if (!usdPerRound || !(usdPerRound > 0) || plannedRounds <= 0) return "";
  const low = usdPerRound * plannedRounds * 0.6;
  const high = usdPerRound * plannedRounds * 1.6;
  const fmt = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
  return `${fmt(low)}–${fmt(high)} (from this machine's past council rounds)`;
}

const CHEAP_ROUNDS = 2;
const CHEAP_PANEL = 3;

/** Round budget + panel size a "cheap run" collapses to. Exported for the caller. */
export function cheapRunShape(input: { plannedRounds: number; panelSize: number }): {
  rounds: number;
  panelists: number;
} {
  return {
    rounds: Math.max(1, Math.min(CHEAP_ROUNDS, input.plannedRounds)),
    panelists: Math.max(2, Math.min(CHEAP_PANEL, input.panelSize)),
  };
}

export function buildLaunchCard(input: LaunchCardInput): LaunchCard {
  const label = (p: LaunchPanelist) => p.stanceName ?? p.role;
  const rows: Array<[string, string]> = [];
  if (input.intent) rows.push(["Intent", INTENT_COPY[input.intent.proposedKind].label]);
  rows.push(["Panel", input.participants.map(label).join(" · ") || "(none resolved)"]);
  const providers = summariseProviders(input.participants, input.providerOf);
  if (providers) rows.push(["Providers", providers]);
  rows.push(["Round budget", summariseRoundBudget(input.plannedRounds, input.roundCeiling)]);
  rows.push(["Research", input.researchOn ? "on · web + repo grounding" : "off"]);
  if (input.costAware) rows.push(["Cost-aware", "on · cheaper models for non-debate calls"]);
  rows.push(["Language", input.language && input.language !== "auto" ? input.language : "auto (follows your brief)"]);
  // Omitted, not zero-filled, when there is no history: see summariseEstimate.
  const estimate = summariseEstimate(input.usdPerRound, input.plannedRounds);
  if (estimate) rows.push(["Est. cost", estimate]);

  const cheap = cheapRunShape({ plannedRounds: input.plannedRounds, panelSize: input.participants.length });
  const options: CouncilQuestionOption[] = [
    ...(input.intent ? buildIntentOptions(input.intent.proposedKind, input.intent.intentSummary) : []),
    {
      label: "Start debate",
      description: `Run up to ${input.plannedRounds} round${input.plannedRounds === 1 ? "" : "s"} with the panel above`,
      value: "start",
      kind: "choice",
    },
    {
      label: "Cheap run",
      description: `${cheap.rounds} rounds · ${cheap.panelists} panelists · cost-aware model tier`,
      value: "cheap",
      kind: "choice",
    },
    {
      label: "Refine the topic first",
      description: "Go back to the composer — nothing is spent",
      value: "refine",
      kind: "choice",
    },
    { label: "Cancel", description: "Drop this council run", value: "cancel", kind: "choice" },
  ];

  return {
    question: input.topic.trim() || "Start the council debate?",
    context: [
      `${input.leaderModelId} will lead · ${input.participants.length} panelist${
        input.participants.length === 1 ? "" : "s"
      } resolved from catalog`,
      ...rows.map(([k, v]) => `${k}: ${v}`),
    ].join("\n"),
    options,
    defaultIndex: 0,
  };
}
