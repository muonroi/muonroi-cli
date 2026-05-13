// src/product-loop/discovery-context-format.ts
import type { ProjectContext } from "./types.js";

export function formatProjectContextForPrompt(ctx: ProjectContext): string {
  const lines: string[] = [];
  lines.push(`Idea: ${ctx.idea}`);
  lines.push(`Product type: ${ctx.context.productType}`);
  lines.push(`Platform: ${ctx.context.targetPlatform.join(", ")}`);
  lines.push(
    `Audience: ${ctx.context.audience.persona} (scale ${ctx.context.audience.scale}, ${ctx.context.audience.geography})`,
  );
  lines.push(`Backend arch: ${ctx.context.backendArchitecture}`);
  lines.push(
    `Backend stack: ${ctx.context.backendStack.language} / ${ctx.context.backendStack.framework}${ctx.context.backendStack.runtime ? " on " + ctx.context.backendStack.runtime : ""}`,
  );
  lines.push(`Database: ${ctx.context.dbStrategy.mode} ${ctx.context.dbStrategy.engine}`);
  if (ctx.context.frontendApproach) {
    lines.push(`Frontend: ${ctx.context.frontendApproach.library} + ${ctx.context.frontendApproach.framework}`);
  }
  if (ctx.context.deployment) {
    lines.push(
      `Deployment: ${ctx.context.deployment.target}${ctx.context.deployment.provider ? " on " + ctx.context.deployment.provider : ""}`,
    );
  }
  lines.push(`Constraints: fePolicy=${ctx.recommendations.constraints.fePolicy}`);
  return lines.join("\n");
}
