import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import { canInferOutcome, countFileReferences, hasExplicitScope, hasOperationalScope } from "./clarity-gate.js";
import type { ClarifiedIntent, ClarityDimension, ClarityGap, ProjectContext } from "./discovery-types.js";
import type { TaskType } from "./types.js";

export function detectClarityGaps(
  raw: string,
  taskType: TaskType | null,
  confidence: number,
  projectContext: ProjectContext,
): ClarityGap[] {
  const gaps: ClarityGap[] = [];

  // PIL-L6 fix — debug joins the autofill set. For "fix ci fail" the outcome
  // is trivially "error resolved / pipeline green" and forcing an askcard
  // there produces noise (the user already said "goal: ci green").
  const AUTOFILL_OUTCOME_TYPES: Set<TaskType> = new Set(["analyze", "plan", "documentation", "debug"]);
  if (!canInferOutcome(taskType, raw)) {
    if (taskType && AUTOFILL_OUTCOME_TYPES.has(taskType)) {
      // These task types have predictable outcomes — auto-fill without asking
    } else {
      const outcomeOptions = buildOutcomeOptions(taskType, projectContext);
      gaps.push({
        dimension: "outcome",
        description: "Cannot infer the expected outcome from the prompt",
        suggestedQuestion: `What's the expected outcome? ${taskType === "debug" ? "(e.g., error gone, test passes, behavior fixed)" : "(e.g., feature works, file updated, test passes)"}`,
        options: outcomeOptions,
        defaultIndex: pickBestOutcomeIndex(taskType, outcomeOptions, raw),
      });
    }
  }

  // PIL-L6 fix — operational scope (CI / build / deploy / lint) is enough
  // even without a file path. The task's target is the pipeline itself.
  if (countFileReferences(raw) === 0 && !hasExplicitScope(raw) && !hasOperationalScope(raw)) {
    const scopeOptions = buildScopeOptions(raw, projectContext);
    gaps.push({
      dimension: "scope",
      description: "No specific file or module referenced",
      suggestedQuestion: "Which part of the codebase should this target?",
      options: scopeOptions,
      defaultIndex: 0,
    });
  }

  const hasConstraint = /\b(\d+\s*ms|\d+\s*%|faster|slower|before|deadline|limit|max|min)\b/i.test(raw);
  const isPerformanceTask = /\b(optimi[zs]e|performance|speed|fast|slow|latency|throughput)\b/i.test(raw);
  if (isPerformanceTask && !hasConstraint) {
    gaps.push({
      dimension: "constraint",
      description: "Performance target not specified",
      suggestedQuestion: "Any specific performance target? (e.g., <200ms response, 50% faster)",
      options: ["General improvement", "Specific latency target", "Reduce bundle size"],
      defaultIndex: 0,
    });
  }

  return gaps;
}

/**
 * Phase 5 F8 — context-aware default option for outcome askcards.
 *
 * The askcard's "Recommended" badge previously pinned to options[0]
 * regardless of prompt content. For prompts like "improve test coverage"
 * (generate options: Feature implemented / File created / Tests added),
 * defaulting to "Feature implemented" was wrong — the user explicitly
 * mentioned tests. This picks a more relevant option based on prompt
 * keywords, with a fallback to 0 when nothing matches.
 *
 * Keep this list short — overengineering breaks predictability. We only
 * encode the keyword→index pairs we've actually seen mismatch in the
 * 5-baseline + sanity sessions.
 */
function pickBestOutcomeIndex(taskType: TaskType | null, options: string[], raw: string): number {
  if (options.length <= 1) return 0;
  const lower = raw.toLowerCase();
  const has = (re: RegExp): boolean => re.test(lower);
  const find = (substring: string): number => options.findIndex((o) => o.toLowerCase().includes(substring));

  switch (taskType) {
    case "generate": {
      // "improve coverage", "add tests", "viết test" → "Tests added"
      if (has(/\b(coverage|unit test|viết test|viet test|spec|jest|vitest|pytest)\b/) || has(/\btest(?:s|ing)?\b/)) {
        const idx = find("test");
        if (idx >= 0) return idx;
      }
      // "scaffold", "boilerplate", "tạo file mới" → "File created with boilerplate"
      if (has(/\b(scaffold|boilerplate|template|skeleton)\b/) || has(/\btạo file\b|\btao file\b/)) {
        const idx = find("file created");
        if (idx >= 0) return idx;
      }
      return 0; // "Feature implemented and working"
    }
    case "refactor": {
      // "performance", "speed", "faster" → "Better performance"
      if (has(/\b(performance|speed|fast(er)?|slow|latency|throughput|optimi[zs]e)\b/)) {
        const idx = find("performance");
        if (idx >= 0) return idx;
      }
      // "test", "testable" → "Easier to test"
      if (has(/\b(testable|easier to test|unit test)\b/)) {
        const idx = find("test");
        if (idx >= 0) return idx;
      }
      return 0; // "Code cleaner, same behavior"
    }
    case "debug": {
      // "test fail", "test pass" → "Test passes"
      if (has(/\btest(?:s|ing)? (?:fail|pass)/) || has(/\bspec fail/)) {
        const idx = find("test passes");
        if (idx >= 0) return idx;
      }
      return 0; // "Error disappears"
    }
    case "documentation": {
      if (has(/\b(readme)\b/)) {
        const idx = find("readme");
        if (idx >= 0) return idx;
      }
      if (has(/\b(api docs|api documentation|openapi|swagger)\b/)) {
        const idx = find("api docs");
        if (idx >= 0) return idx;
      }
      return 0;
    }
    case "plan": {
      if (has(/\b(trade-?offs?|alternative|compare)\b/)) {
        const idx = find("trade");
        if (idx >= 0) return idx;
      }
      if (has(/\b(step.?by.?step|phase|roadmap)\b/)) {
        const idx = find("step-by-step");
        if (idx >= 0) return idx;
      }
      return 0;
    }
    case "analyze": {
      if (has(/\b(root cause|why|tại sao|tai sao|crash|stack trace)\b/)) {
        const idx = find("root cause");
        if (idx >= 0) return idx;
      }
      if (has(/\b(recommend|suggest|đề xuất|de xuat)\b/)) {
        const idx = find("recommendations");
        if (idx >= 0) return idx;
      }
      return 0;
    }
    default:
      return 0;
  }
}

function buildOutcomeOptions(taskType: TaskType | null, ctx: ProjectContext): string[] {
  switch (taskType) {
    case "debug":
      return ["Error disappears", "Test passes", "Feature works correctly"];
    case "refactor":
      return ["Code cleaner, same behavior", "Better performance", "Easier to test"];
    case "generate":
      return ["Feature implemented and working", "File created with boilerplate", "Tests added"];
    case "documentation":
      return ["Docs updated", "README reflects current state", "API docs generated"];
    case "plan":
      return ["Architecture decided", "Step-by-step plan", "Trade-offs documented"];
    case "analyze":
      return ["Root cause identified", "Report generated", "Recommendations listed"];
    default:
      return ["Task completed", "Issue resolved"];
  }
}

function buildScopeOptions(raw: string, ctx: ProjectContext): string[] {
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const matching = ctx.boundedContexts.filter((bc) => {
    const name = bc.name.toLowerCase();
    return words.some((w) => name.includes(w) || w.includes(name));
  });
  const options = matching.map((bc) => `${bc.path} (${bc.name})`);
  if (options.length === 0 && ctx.boundedContexts.length > 0) {
    // Phase 5 F4 — when no keyword matches a module name, the previous
    // fallback returned the first 3 alphabetically (which on muonroi-cli
    // surfaced `agent-harness`, `billing`, `chat` — three OLD scaffolding
    // folders that almost never match a fresh prompt). Rank by recency
    // signal instead: most recently modified module dir comes first.
    const ranked = rankModulesByRecency(ctx.boundedContexts, ctx.cwd);
    options.push(...ranked.slice(0, 3).map((bc) => `${bc.path} (${bc.name})`));
  }
  options.push("Entire project");
  return options.slice(0, 4);
}

/**
 * F4 — rank bounded contexts by recency-of-modification of any tracked file
 * inside. Falls back to alphabetical order when stat() throws for the dir.
 * The 4-level depth cap + 50-entry-per-level cap keeps the walk under 200ms
 * even on huge monorepos.
 */
function rankModulesByRecency(
  contexts: ReadonlyArray<{ path: string; name: string }>,
  cwd: string,
): Array<{ path: string; name: string }> {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const scored = contexts.map((bc) => {
    const dirPath = path.join(cwd, bc.path);
    let maxMtime = 0;
    try {
      // walk up to 4 levels deep, cap entries per level
      const walk = (dir: string, depth: number): void => {
        if (depth > 4) return;
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(dir).slice(0, 50);
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.startsWith(".") || e === "node_modules" || e === "dist") continue;
          try {
            const full = path.join(dir, e);
            const st = fs.statSync(full);
            if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
            if (st.isDirectory()) walk(full, depth + 1);
          } catch {
            /* skip unreadable entries */
          }
        }
      };
      walk(dirPath, 0);
    } catch {
      /* fall back to mtime=0 — keeps the entry at the bottom of the ranked list */
    }
    return { bc, mtime: maxMtime };
  });
  scored.sort((a, b) => b.mtime - a.mtime);
  return scored.map((s) => s.bc);
}

export function buildInterviewQuestion(gap: ClarityGap, questionId: string): CouncilQuestionData {
  const options: CouncilQuestionOption[] = gap.options.map((label) => ({
    label,
    value: label,
    kind: "choice" as const,
  }));
  options.push({
    label: "Type something",
    description: "Enter a custom answer",
    value: "",
    kind: "freetext" as const,
  });

  return {
    questionId,
    question: gap.suggestedQuestion,
    context: gap.description,
    isRequired: false,
    phase: "pil-interview" as CouncilQuestionData["phase"],
    options,
    defaultIndex: gap.defaultIndex,
  };
}

export function resolveGapsNonInteractive(
  gaps: ClarityGap[],
  projectContext: ProjectContext,
  raw: string,
): ClarifiedIntent {
  let outcome = "";
  let scope: string[] = [];
  const constraints: string[] = [];

  for (const gap of gaps) {
    const defaultAnswer = gap.options[gap.defaultIndex] ?? gap.options[0] ?? "";
    switch (gap.dimension) {
      case "outcome":
        outcome = defaultAnswer;
        break;
      case "scope": {
        const relevant = projectContext.relevantModules.map((m) => m.path);
        scope = relevant.length > 0 ? relevant : [defaultAnswer];
        break;
      }
      case "constraint":
        constraints.push(defaultAnswer);
        break;
    }
  }

  if (!outcome) outcome = getDefaultOutcome(raw);
  if (scope.length === 0) {
    scope = projectContext.relevantModules.map((m) => m.path);
    if (scope.length === 0) scope = ["project root"];
  }

  return {
    outcome,
    scope,
    constraints,
    gaps: gaps.map((g) => ({ ...g, answer: null })),
  };
}

const DEFAULT_OUTCOMES: Partial<Record<TaskType, string>> = {
  analyze: "Report generated",
  plan: "Step-by-step plan",
  documentation: "Docs updated",
  debug: "Error resolved, expected behavior restored",
};

export function getAutofilledOutcome(taskType: TaskType | null, raw?: string): string | null {
  if (!taskType) return null;
  // PIL-L6 fix — operational debug tasks have a stronger default outcome
  // ("CI green / pipeline passing") than the generic "error resolved".
  if (taskType === "debug" && raw && hasOperationalScope(raw)) {
    return "Pipeline green, all checks passing";
  }
  return DEFAULT_OUTCOMES[taskType] ?? null;
}

function getDefaultOutcome(raw: string): string {
  return `Complete the task described in: "${raw.slice(0, 80)}"`;
}
