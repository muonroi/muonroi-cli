import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClarifiedIntent, FeasibilityResult, ProjectContext } from "./discovery-types.js";

type ExistsFn = (p: string) => boolean;

export async function checkFeasibility(
  intent: ClarifiedIntent,
  projectContext: ProjectContext,
  exists: ExistsFn = (p) => existsSync(join(projectContext.cwd, p)),
): Promise<FeasibilityResult> {
  const warnings: string[] = [];
  const adjustedScope: string[] = [];

  for (const scopeItem of intent.scope) {
    if (scopeItem === "project root" || scopeItem === "Entire project") {
      adjustedScope.push(scopeItem);
      continue;
    }
    const cleanPath = scopeItem.replace(/\s*\(.*\)\s*$/, "").trim();
    if (exists(cleanPath)) {
      adjustedScope.push(cleanPath);
    } else {
      warnings.push(`File/directory not found: ${cleanPath}`);
      const matchingBc = projectContext.boundedContexts.find(
        (bc) => cleanPath.startsWith(bc.path) || bc.path.startsWith(cleanPath),
      );
      if (matchingBc) {
        adjustedScope.push(matchingBc.path);
        warnings.push(`→ Adjusted scope to nearest module: ${matchingBc.path}`);
      }
    }
  }

  return {
    viable: true,
    warnings,
    adjustedScope: adjustedScope.length > 0 ? adjustedScope : intent.scope,
  };
}
