// src/product-loop/discovery-context-format.ts
import type { ProjectContext } from "./types.js";

/**
 * Format a ProjectContext for inclusion in leader/council prompts.
 *
 * `ProjectContext.context` is typed as fully-populated but at runtime it
 * is `Partial<DiscoveryContext>` (see buildProjectContextFromState — the
 * cast lies about coverage). Any field may be missing when:
 *   - the interview was aborted mid-way
 *   - a prefilled-flag-without-prefill-value combination shipped (was the
 *     case for backendStack pre-fix — see session e2660a052918 crash:
 *     "undefined is not an object (evaluating 'ctx.context.backendStack.language')")
 *   - a skipped non-required question
 *
 * Every nested access must be guarded so the formatter NEVER throws —
 * the result is consumed by leader prompts that fail-open on missing
 * details, but crash on missing properties.
 */
export function formatProjectContextForPrompt(ctx: ProjectContext): string {
  const c = ctx.context as Partial<ProjectContext["context"]>;
  const lines: string[] = [];
  lines.push(`Idea: ${ctx.idea}`);
  if (c.productType) lines.push(`Product type: ${c.productType}`);
  if (c.targetPlatform?.length) lines.push(`Platform: ${c.targetPlatform.join(", ")}`);
  if (c.audience) {
    lines.push(
      `Audience: ${c.audience.persona ?? "(unknown)"} (scale ${c.audience.scale ?? "?"}, ${c.audience.geography ?? "?"})`,
    );
  }
  if (c.backendArchitecture) lines.push(`Backend arch: ${c.backendArchitecture}`);
  if (c.backendStack?.language || c.backendStack?.framework) {
    const lang = c.backendStack.language ?? "(unspecified)";
    const fw = c.backendStack.framework ?? "(unspecified)";
    const runtime = c.backendStack.runtime ? ` on ${c.backendStack.runtime}` : "";
    lines.push(`Backend stack: ${lang} / ${fw}${runtime}`);
  }
  if (c.dbStrategy) {
    lines.push(
      c.dbStrategy.mode === "none"
        ? "Database: none (stateless — no persistent storage)"
        : `Database: ${c.dbStrategy.mode ?? "(unspecified)"} ${c.dbStrategy.engine ?? ""}`.trimEnd(),
    );
  }
  if (c.frontendApproach) {
    const harness = c.frontendApproach.agentHarness
      ? ` (harness: @muonroi/agent-harness-${c.frontendApproach.agentHarness})`
      : "";
    lines.push(
      `Frontend: ${c.frontendApproach.library ?? "(none)"} + ${c.frontendApproach.framework ?? "(none)"}${harness}`,
    );
  }
  if (c.deployment) {
    const provider = c.deployment.provider ? ` on ${c.deployment.provider}` : "";
    lines.push(`Deployment: ${c.deployment.target ?? "(unspecified)"}${provider}`);
  }
  const fePolicy = ctx.recommendations?.constraints?.fePolicy;
  if (fePolicy) lines.push(`Constraints: fePolicy=${fePolicy}`);
  return lines.join("\n");
}
