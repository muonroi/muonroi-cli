import type { GrayAreaQuestion } from "../gsd/gray-areas.js";

/**
 * The 6 hardcoded dimensions for the Product Ideal Loop's Gather stage.
 * These are used as seed questions for the clarifier to ensure high-confidence
 * grounding before research/scoping begins.
 */
export const SEED_DIMENSIONS: GrayAreaQuestion[] = [
  {
    dimension: "persona",
    id: "persona",
    question: "Who are the primary users for this product?",
    options: ["developers using this codebase", "internal team members", "external end-users"],
    isRequired: true,
  },
  {
    dimension: "core-features",
    id: "core-features",
    question: "What are the top 3 must-have features?",
    options: ["core logic only", "API endpoints", "CLI interface", "web UI"],
    isRequired: true,
  },
  {
    dimension: "non-functional",
    id: "non-functional",
    question: "What are the performance, privacy, offline, or scale targets?",
    options: ["no specific targets (best effort)", "high performance / low latency", "strict privacy requirements"],
    isRequired: true,
  },
  {
    dimension: "tech-constraints",
    id: "tech-constraints",
    question: "What language, framework, or existing repo constraints apply?",
    options: ["match existing project stack", "TypeScript / Node.js", "Python / FastApi"],
    isRequired: true,
  },
  {
    dimension: "success-metric",
    id: "success-metric",
    question: "How will 'done' be measured (e.g., metric, threshold)?",
    options: ["100% test pass with >80% coverage", "user approval of final demo", "specific performance benchmark"],
    isRequired: true,
  },
  {
    dimension: "cost-tolerance",
    id: "cost-tolerance",
    question: "Is there a hard cost cap or a soft target?",
    options: ["$50 soft target", "$100 hard cap", "no strict limit"],
    isRequired: true,
  },
];
