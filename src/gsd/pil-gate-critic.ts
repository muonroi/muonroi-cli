import type { GateContextBundle } from "./pil-gate-context.js";

export type GateVerdict = "adequate" | "enriched" | "needs-user";

export interface CriticResult {
  verdict: GateVerdict;
  brief: string;
}

export type RunCriticFn = (prompt: string) => Promise<string>;

const RANK: Record<GateVerdict, number> = { adequate: 0, enriched: 1, "needs-user": 2 };
const CRITIC_ROLES = ["grounding", "noise", "sufficiency"] as const;
type CriticRole = (typeof CRITIC_ROLES)[number];

const ROLE_MANDATE: Record<CriticRole, string> = {
  grounding:
    "Strip any claim not traceable to the provided context. Flag ANY area/file reference not explicitly hedged as 'confirm via grep before anchoring' — an asserted file path is a defect.",
  noise:
    "Strip any line that does not change what the coding agent does. If most of the brief is noise, downgrade the verdict.",
  sufficiency:
    "Decide whether 'adequate' is honest or a blocker (intent/target/scope/acceptance) is being papered over. You may flip to needs-user; you may NOT upgrade toward adequate.",
};

export function buildCriticPrompt(
  role: CriticRole,
  draftBrief: string,
  draftVerdict: GateVerdict,
  bundle: GateContextBundle,
): string {
  return [
    `You are the ${role} critic for a prompt-enrichment gate. You may only TIGHTEN — downgrade the verdict and strip lines, never upgrade or add.`,
    ROLE_MANDATE[role],
    "",
    "Provided context (the ONLY sources the brief may draw on):",
    bundle.conversationDigest ? `Recent conversation:\n${bundle.conversationDigest}` : "(no recent conversation)",
    bundle.eeContext ? `EE recall:\n${bundle.eeContext}` : "(no EE recall)",
    bundle.priorPlan ? `Prior plan:\n${bundle.priorPlan}` : "(no prior plan)",
    bundle.projectHints ? `Project hints:\n${bundle.projectHints}` : "(no project hints)",
    "",
    `Producer verdict: ${draftVerdict}`,
    "Producer brief:",
    draftBrief || "(empty)",
    "",
    "Respond with ONLY a fenced block:",
    "```gate-critic",
    '{ "verdict": "adequate|enriched|needs-user", "strippedBrief": "the brief with noise/ungrounded/unhedged lines removed" }',
    "```",
  ].join("\n");
}

function parseCritic(raw: string): { verdict: GateVerdict; strippedBrief: string } | null {
  const m = raw.match(/```gate-critic\s*([\s\S]*?)```/);
  const body = m?.[1] ?? raw;
  const brace = body.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try {
    const parsed = JSON.parse(brace[0]) as { verdict?: string; strippedBrief?: string };
    if (parsed.verdict !== "adequate" && parsed.verdict !== "enriched" && parsed.verdict !== "needs-user") return null;
    return { verdict: parsed.verdict, strippedBrief: String(parsed.strippedBrief ?? "") };
  } catch (err) {
    console.error(`[pil-gate] critic parse failed: ${(err as Error).message}`);
    return null;
  }
}

/** Worst-wins AND downgrade-only: the result is never less severe than the producer verdict. */
export function mergeCriticVerdicts(producer: GateVerdict, criticVerdicts: GateVerdict[]): GateVerdict {
  let worst = producer;
  for (const v of criticVerdicts) {
    if (RANK[v] > RANK[worst]) worst = v;
  }
  return worst;
}

export async function runGateCritics(args: {
  draftBrief: string;
  draftVerdict: GateVerdict;
  bundle: GateContextBundle;
  runCritic: RunCriticFn;
}): Promise<CriticResult> {
  const settled = await Promise.all(
    CRITIC_ROLES.map((role) =>
      args
        .runCritic(buildCriticPrompt(role, args.draftBrief, args.draftVerdict, args.bundle))
        .then((raw) => parseCritic(raw))
        .catch((err) => {
          console.error(`[pil-gate] critic ${role} threw: ${(err as Error).message}`);
          return null;
        }),
    ),
  );
  // Parse/throw failure is conservative: a null critic votes needs-user and keeps the producer brief.
  const verdicts: GateVerdict[] = settled.map((r) => r?.verdict ?? "needs-user");
  const verdict = mergeCriticVerdicts(args.draftVerdict, verdicts);
  // Prefer the shortest surviving stripped brief (most noise removed) among successful critics;
  // fall back to the producer brief when none parsed.
  const stripped = settled
    .filter(
      (r): r is { verdict: GateVerdict; strippedBrief: string } => r !== null && r.strippedBrief.trim().length > 0,
    )
    .map((r) => r.strippedBrief)
    .sort((a, b) => a.length - b.length)[0];
  return { verdict, brief: (stripped ?? args.draftBrief).slice(0, 1500) };
}
