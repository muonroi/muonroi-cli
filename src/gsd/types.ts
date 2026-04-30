export const GSD_PHASES = ["discuss", "plan", "execute", "verify", "review"] as const;

export type GsdPhase = (typeof GSD_PHASES)[number];

export function isGsdPhase(value: string): value is GsdPhase {
  return (GSD_PHASES as readonly string[]).includes(value);
}

const PHASE_KEYWORDS: Record<GsdPhase, string[]> = {
  discuss: ["discuss", "brainstorm", "explore", "think about", "consider"],
  plan: ["plan", "design", "architect", "outline", "roadmap"],
  execute: ["execute", "implement", "build", "create", "write", "code", "develop"],
  verify: ["verify", "validate", "test", "check", "confirm", "ensure"],
  review: ["review", "audit", "inspect", "examine", "evaluate"],
};

export function detectGsdPhase(text: string): GsdPhase | null {
  const lower = text.toLowerCase();
  let bestPhase: GsdPhase | null = null;
  let bestPos = Infinity;

  for (const [phase, keywords] of Object.entries(PHASE_KEYWORDS) as [GsdPhase, string[]][]) {
    for (const kw of keywords) {
      const pos = lower.indexOf(kw);
      if (pos !== -1 && pos < bestPos) {
        bestPos = pos;
        bestPhase = phase;
      }
    }
  }

  return bestPhase;
}
