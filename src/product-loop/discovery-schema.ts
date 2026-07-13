// src/product-loop/discovery-schema.ts
import type { PlatformT } from "./types.js";

export type RecommendMode = "leader" | "council";

export interface DiscoveryQuestion {
  id: string;
  required: boolean;
  recommendMode: RecommendMode;
  prompt: string;
}

export const DISCOVERY_QUESTIONS: DiscoveryQuestion[] = [
  { id: "productType", required: true, recommendMode: "leader", prompt: "What kind of product is this?" },
  { id: "targetPlatform", required: true, recommendMode: "leader", prompt: "Which platforms must this run on?" },
  {
    id: "audience",
    required: true,
    recommendMode: "leader",
    prompt: "Who is the audience? (persona, scale, geography)",
  },
  {
    id: "backendArchitecture",
    required: true,
    recommendMode: "council",
    prompt: "What backend architecture fits this scale and team?",
  },
  { id: "backendStack", required: true, recommendMode: "council", prompt: "Which backend language and framework?" },
  {
    id: "dbStrategy",
    required: true,
    recommendMode: "council",
    prompt:
      "Database strategy: none (stateless — no persistent storage), greenfield, existing schema, or migration? Choose none for a CLI/tool/filter that keeps no data.",
  },
  {
    id: "frontendApproach",
    required: false,
    recommendMode: "leader",
    prompt: "Frontend approach (headless UI library + framework)?",
  },
  { id: "baStatus", required: false, recommendMode: "leader", prompt: "Business analysis status?" },
  { id: "designStatus", required: false, recommendMode: "leader", prompt: "Design system status?" },
  { id: "deployment", required: false, recommendMode: "council", prompt: "Deployment target and CI/CD?" },
];

export const REQUIRED_QUESTION_IDS = DISCOVERY_QUESTIONS.filter((q) => q.required).map((q) => q.id);
export const OPTIONAL_QUESTION_IDS = DISCOVERY_QUESTIONS.filter((q) => !q.required).map((q) => q.id);
export const BIG_4_QUESTION_IDS = DISCOVERY_QUESTIONS.filter((q) => q.recommendMode === "council").map((q) => q.id);

const ACCEPTED_FE_LIBRARIES = new Set(["shadcn", "radix", "headlessui", "none"]);
const ACCEPTED_AGENT_HARNESS = new Set(["core", "react", "angular", "opentui", "none"]);

export function isFePolicyAccepted(library: string): boolean {
  return ACCEPTED_FE_LIBRARIES.has(library);
}

export function isAgentHarnessAccepted(value: string): boolean {
  return ACCEPTED_AGENT_HARNESS.has(value);
}

const WEB_PLATFORMS = new Set<PlatformT>(["web"]);

export function isRequiredForPlatform(questionId: string, platforms: PlatformT[]): boolean {
  if (questionId === "frontendApproach") {
    return platforms.some((p) => WEB_PLATFORMS.has(p));
  }
  return false;
}

const PRODUCT_TYPES = new Set([
  "saas",
  "internal-tool",
  "consumer-app",
  "b2b-platform",
  "marketplace",
  // Small-scope builds that previously had no home in the enum and so were
  // forced to "other" — the exact "recommend other" bad UX users hit for a
  // hello-world script. A trivial CLI/script/library now maps cleanly.
  "cli-tool",
  "script",
  "library",
  "other",
]);
const SCALES = new Set(["1-100", "100-1k", "1k-100k", "100k-1M", "1M+"]);

/**
 * Schema hint for the leader prompt — surfaces the enum/shape that
 * `validateAnswer` will check for this question. Without it the LLM
 * hallucinates free-form strings (e.g. "web application" for productType)
 * which fail validation and trap the interview in an infinite re-ask loop.
 *
 * Only the questions whose values are enforced by `validateAnswer` get a
 * constraint. Questions in its `default: { ok: true }` branch
 * (backendArchitecture, dbStrategy, baStatus, designStatus, deployment) are
 * left unconstrained — they accept any value and inventing a fake enum here
 * would risk conflicting with downstream prompt expectations.
 */
export function getSchemaHintForLeader(questionId: string): string {
  switch (questionId) {
    case "productType":
      return `value MUST be one of: ${Array.from(PRODUCT_TYPES)
        .map((v) => JSON.stringify(v))
        .join(", ")} (string)`;
    case "targetPlatform":
      return `value MUST be a non-empty array of strings drawn from: "web", "ios", "android", "desktop", "cli"`;
    case "audience":
      return `value MUST be an object {"persona": string, "scale": one of ${Array.from(SCALES)
        .map((s) => JSON.stringify(s))
        .join("|")}, "geography": string}`;
    case "dbStrategy":
      // F7 — give the recommender an explicit "no persistence" option so it
      // stops mis-ranking "greenfield" for stateless products (CLI/tool/filter).
      return `value MUST be an object {"mode": one of "none"|"greenfield"|"existing-schema"|"migrate-from", "engine": string, "notes"?: string}. Pick "mode":"none" with "engine":"" when the product keeps NO persistent data (e.g. a stateless CLI, filter, or one-shot tool) — do NOT default to "greenfield" in that case.`;
    case "frontendApproach":
      return `value MUST be an object {"library": one of ${Array.from(ACCEPTED_FE_LIBRARIES)
        .map((l) => JSON.stringify(l))
        .join("|")}, "framework": string, "agentHarness"?: one of ${Array.from(ACCEPTED_AGENT_HARNESS)
        .map((h) => JSON.stringify(h))
        .join(
          "|",
        )} — pick the @muonroi/agent-harness-* wrapper matching the framework ("react" for React/Next, "angular" for Angular, "opentui" for terminal UI, "core" for headless integration, "none" only if not building UI)}`;
    default:
      return "";
  }
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateAnswer(questionId: string, value: unknown): ValidationResult {
  switch (questionId) {
    case "productType":
      return PRODUCT_TYPES.has(value as string) ? { ok: true } : { ok: false, reason: "invalid productType" };
    case "audience": {
      const v = value as { persona?: string; scale?: string; geography?: string };
      if (!v || typeof v !== "object") return { ok: false, reason: "audience must be object" };
      if (!v.persona) return { ok: false, reason: "audience.persona required" };
      if (!v.scale || !SCALES.has(v.scale)) return { ok: false, reason: "audience.scale invalid" };
      if (!v.geography) return { ok: false, reason: "audience.geography required" };
      return { ok: true };
    }
    case "frontendApproach": {
      const v = value as { library?: string; agentHarness?: string };
      if (!v?.library || !isFePolicyAccepted(v.library)) {
        return { ok: false, reason: "FE policy: library must be one of shadcn/radix/headlessui/none" };
      }
      if (v.agentHarness !== undefined && !isAgentHarnessAccepted(v.agentHarness)) {
        return {
          ok: false,
          reason: "FE policy: agentHarness must be one of core/react/angular/opentui/none when provided",
        };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}
