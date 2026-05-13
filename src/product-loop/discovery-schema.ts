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
    prompt: "Database strategy: greenfield, existing schema, or migration?",
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

export function isFePolicyAccepted(library: string): boolean {
  return ACCEPTED_FE_LIBRARIES.has(library);
}

const WEB_PLATFORMS = new Set<PlatformT>(["web"]);

export function isRequiredForPlatform(questionId: string, platforms: PlatformT[]): boolean {
  if (questionId === "frontendApproach") {
    return platforms.some((p) => WEB_PLATFORMS.has(p));
  }
  return false;
}

const PRODUCT_TYPES = new Set(["saas", "internal-tool", "consumer-app", "b2b-platform", "marketplace", "other"]);
const SCALES = new Set(["1-100", "100-1k", "1k-100k", "100k-1M", "1M+"]);

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
      const v = value as { library?: string };
      if (!v?.library || !isFePolicyAccepted(v.library)) {
        return { ok: false, reason: "FE policy: library must be one of shadcn/radix/headlessui/none" };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}
