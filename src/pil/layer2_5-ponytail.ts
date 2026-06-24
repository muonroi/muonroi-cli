import { truncateToBudget } from "./budget.js";
import { isPonytailModeEnabled } from "./config.js";
import type { PipelineContext } from "./types.js";

const PONYTAIL_INSTRUCTION = `[LAZY SENIOR / PONYTAIL MODE ACTIVE]
"The best code is the code you never wrote." You MUST adhere to the following Decision Ladder:
1. Standard Library first.
2. Native platform features next.
3. 1-line solution next.
4. YAGNI: Do not write it if not strictly necessary.
5. Smallest correct change.

DOCUMENTATION RULE: If you bypass a complex/scalable pattern in favor of a simple one to adhere to this rule, you MUST add a comment in the code starting exactly with "// Intentional simplification: [Reason]".`;

export async function layer2_5Ponytail(ctx: PipelineContext): Promise<PipelineContext> {
  // If task is not coding/action-related (e.g., chitchat), we might not need it, but pipeline.ts already skips layers if taskType is null.
  if (!isPonytailModeEnabled()) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        {
          name: "ponytail-mode",
          applied: false,
          delta: "skipped:disabled-by-config",
        },
      ],
    };
  }

  const trimmed = truncateToBudget(PONYTAIL_INSTRUCTION, Math.floor(ctx.tokenBudget * 0.15));

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "ponytail-mode",
        applied: true,
        delta: `chars=${trimmed.length}`,
      },
    ],
  };
}
