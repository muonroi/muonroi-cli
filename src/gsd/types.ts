export const GSD_PHASES = ["discuss", "plan", "execute", "verify", "review", "debug"] as const;

export type GsdPhase = (typeof GSD_PHASES)[number];

export type WorkflowKind = "task" | "product";

export function isGsdPhase(value: string): value is GsdPhase {
  return (GSD_PHASES as readonly string[]).includes(value);
}

// PHASE_KEYWORDS notes (session 127140a47b56 root cause):
// - "debug" is a phase that detection must prefer over "verify" / "execute"
//   when bug/fail/error language is present. Without it, "fix CI fail check"
//   matched "check" → verify, and the agent entered GSD-quick verify flow on
//   what was actually a debug request.
// - "fix" is now part of `debug` keywords (was missing); "build" stays in
//   execute but loses precedence to debug fix-language.
// - Vietnamese verbs added so multilingual prompts route correctly.
const PHASE_KEYWORDS: Record<GsdPhase, string[]> = {
  debug: ["debug", "fix", "bug", "broken", "fail", "failing", "error", "crash", "regression", "sửa", "lỗi", "hỏng"],
  discuss: ["discuss", "brainstorm", "explore", "think about", "consider", "thảo luận"],
  plan: ["plan", "design", "architect", "outline", "roadmap", "lập kế hoạch"],
  execute: ["execute", "implement", "build", "create", "write", "code", "develop", "triển khai", "viết"],
  verify: ["verify", "validate", "test", "check", "confirm", "ensure", "kiểm tra"],
  review: ["review", "audit", "inspect", "examine", "evaluate", "đánh giá"],
};

// PHASE_PRIORITY notes:
// - debug ranks ABOVE execute and verify. When a prompt contains both "fix"
//   (debug) and "check" (verify), the debug intent should win — the user is
//   asking us to fix something, the check is incidental.
const PHASE_PRIORITY: Record<GsdPhase, number> = {
  debug: 6,
  execute: 5,
  verify: 4,
  discuss: 3,
  plan: 2,
  review: 1,
};

export function detectGsdPhase(text: string): GsdPhase | null {
  const lower = text.toLowerCase();

  let bestPhase: GsdPhase | null = null;
  let bestPos = Infinity;
  let bestPriority = -1;

  for (const [phase, keywords] of Object.entries(PHASE_KEYWORDS) as [GsdPhase, string[]][]) {
    for (const kw of keywords) {
      const pos = lower.indexOf(kw);
      if (pos === -1) continue;

      const priority = PHASE_PRIORITY[phase];
      if (pos < bestPos || (pos === bestPos && priority > bestPriority)) {
        bestPhase = phase;
        bestPos = pos;
        bestPriority = priority;
      }
    }
  }

  return bestPhase;
}
