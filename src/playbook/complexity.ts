/**
 * src/playbook/complexity.ts
 *
 * Work-depth tier used by the [playbook] directive injected per turn.
 *
 *   - "quick"    → trivial single-shot tasks (typo, rename, read-and-explain).
 *   - "standard" → ordinary feature/bugfix work. Short plan → check → impl → verify.
 *   - "heavy"    → architectural / multi-file / wide / ambiguous. Full
 *                  discuss → research → plan → check-plan → implement → verify.
 *
 * The depth is decided AGENT-FIRST by the model (the 5th word of the layer1
 * `llm-classify` call → `ctx.modelDepthTier`), NOT by a regex scan of the
 * prompt. The old keyword `scoreComplexity` scorer was removed (2026-06-18,
 * no-regex rule): keyword matching mis-tiered plainly-phrased tasks, which is
 * exactly what made the agent skip the rigor a task needed.
 */

export type ComplexityTier = "quick" | "standard" | "heavy";
