/**
 * capability-registry.ts — Native vendored byLoopPoint data from gsd-core
 *
 * ADR-894 §5 — role-partitioned Capability Registry.
 * Contains the byLoopPoint data used by the loop resolver.
 * This is the frozen first-party registry used as the fallback default.
 */

export interface LoopHook {
  capId: string;
  kind: "step" | "contribution" | "gate";
  point?: string;
  ref?: Record<string, unknown>;
  fragment?: { path?: string; inline?: string };
  when?: string;
  onError?: string;
  produces?: string[];
  consumes?: string[];
  into?: string;
  check?: unknown;
  blocking?: boolean;
  configValues?: Record<string, unknown>;
}

export interface LoopPointEntry {
  steps: LoopHook[];
  contributions: LoopHook[];
  gates: LoopHook[];
}

export interface CapabilityRegistry {
  byLoopPoint: Record<string, LoopPointEntry>;
}

const byLoopPoint: Record<string, LoopPointEntry> = {
  "discuss:pre": {
    steps: [],
    contributions: [
      {
        capId: "mempalace",
        kind: "contribution",
        point: "discuss:pre",
        into: "orchestrator",
        fragment: {
          path: "fragments/recall-discuss.md",
          inline: `<!--\n  MemPalace capability — contribution fragment.\n  Rendered into the discuss:pre orchestrator prompt when \`mempalace.recall_on_discuss\` is true.\n  Contributes DATA (recall instructions), not control flow. onError: skip — never blocks discussion.\n-->\n### Memory recall (MemPalace)\n\n...contribution content elided for brevity...`,
        },
        produces: [],
        consumes: [],
        when: "mempalace.enabled",
        onError: "skip",
      },
    ],
    gates: [],
  },
  "discuss:post": {
    steps: [
      {
        capId: "mempalace",
        kind: "step",
        point: "discuss:post",
        ref: { skill: "mempalace-capture" },
        produces: [],
        consumes: ["CONTEXT.md"],
        when: "mempalace.enabled",
        onError: "skip",
      },
    ],
    contributions: [],
    gates: [],
  },
  "plan:pre": {
    steps: [
      {
        capId: "ai-integration",
        kind: "step",
        point: "plan:pre",
        ref: { skill: "ai-integration-phase" },
        produces: ["AI-SPEC.md"],
        consumes: ["CONTEXT.md"],
        when: "workflow.ai_integration_phase",
        onError: "skip",
      },
      {
        capId: "intel",
        kind: "step",
        point: "plan:pre",
        ref: { command: "intel api-surface" },
        produces: [".planning/intel/API-SURFACE.md"],
        consumes: [],
        when: "intel.enabled",
        onError: "skip",
      },
      {
        capId: "mempalace",
        kind: "step",
        point: "plan:pre",
        ref: { skill: "mempalace-recall" },
        produces: ["MEMORY-RECALL.md"],
        consumes: ["CONTEXT.md"],
        when: "mempalace.enabled",
        onError: "skip",
      },
      {
        capId: "research",
        kind: "step",
        point: "plan:pre",
        ref: { agent: "gsd-phase-researcher" },
        produces: ["RESEARCH.md"],
        consumes: ["CONTEXT.md"],
        when: "workflow.research",
        onError: "skip",
      },
      {
        capId: "ui",
        kind: "step",
        point: "plan:pre",
        ref: { skill: "ui-phase" },
        produces: ["UI-SPEC.md"],
        consumes: ["CONTEXT.md"],
        when: "workflow.ui_phase",
        onError: "skip",
      },
      {
        capId: "pattern-mapper",
        kind: "step",
        point: "plan:pre",
        ref: { agent: "gsd-pattern-mapper" },
        produces: ["PATTERNS.md"],
        consumes: ["RESEARCH.md"],
        when: "workflow.pattern_mapper",
        onError: "skip",
      },
      {
        capId: "schema-gate",
        kind: "step",
        point: "plan:pre",
        ref: { skill: "schema-gate" },
        produces: [],
        consumes: ["CONTEXT.md"],
        when: "workflow.schema_gate",
        onError: "halt",
      },
    ],
    contributions: [
      {
        capId: "assumption-delta",
        kind: "contribution",
        point: "plan:pre",
        into: "planner",
        fragment: { path: "fragments/plan-pre.md" },
        produces: [],
        consumes: ["CONTEXT.md"],
        when: "workflow.assumption_delta",
        onError: "skip",
      },
    ],
    gates: [],
  },
  "plan:post": {
    steps: [
      {
        capId: "nyquist",
        kind: "step",
        point: "plan:post",
        ref: { skill: "validate-phase" },
        produces: ["VALIDATION.md"],
        consumes: ["PLAN.md"],
        when: "workflow.nyquist_validation",
        onError: "halt",
      },
    ],
    contributions: [],
    gates: [],
  },
  "execute:pre": {
    steps: [],
    contributions: [],
    gates: [],
  },
  "execute:wave:pre": {
    steps: [],
    contributions: [],
    gates: [],
  },
  "execute:wave:post": {
    steps: [],
    contributions: [
      {
        capId: "mempalace",
        kind: "contribution",
        point: "execute:wave:post",
        into: "verifier",
        fragment: { path: "fragments/capture-problems.md" },
        produces: [],
        consumes: [],
        when: "mempalace.enabled",
        onError: "skip",
      },
    ],
    gates: [
      {
        capId: "drift",
        kind: "gate",
        point: "execute:wave:post",
        check: { query: "verify.schema-drift" },
        when: "workflow.schema_drift_gate",
        blocking: true,
        onError: "skip",
      },
      {
        capId: "drift",
        kind: "gate",
        point: "execute:wave:post",
        check: { query: "verify.codebase-drift" },
        when: "workflow.schema_drift_gate",
        blocking: false,
        onError: "skip",
      },
      {
        capId: "ui",
        kind: "gate",
        point: "execute:wave:post",
        check: { query: "ui.safety-gate" },
        when: "workflow.ui_safety_gate",
        blocking: true,
        onError: "halt",
      },
    ],
  },
  "execute:post": {
    steps: [
      {
        capId: "code-review",
        kind: "step",
        point: "execute:post",
        ref: { skill: "code-review" },
        produces: ["REVIEW.md"],
        consumes: ["SUMMARY.md"],
        when: "workflow.code_review",
        onError: "skip",
      },
    ],
    contributions: [],
    gates: [
      {
        capId: "tdd",
        kind: "gate",
        point: "execute:post",
        check: { query: "tdd.review-checkpoint" },
        when: "workflow.tdd_mode",
        blocking: false,
        onError: "skip",
      },
    ],
  },
  "verify:pre": {
    steps: [],
    contributions: [],
    gates: [],
  },
  "verify:post": {
    steps: [
      {
        capId: "mempalace",
        kind: "step",
        point: "verify:post",
        ref: { skill: "mempalace-capture" },
        produces: [],
        consumes: ["SUMMARY.md"],
        when: "mempalace.enabled",
        onError: "skip",
      },
      {
        capId: "nyquist",
        kind: "step",
        point: "verify:post",
        ref: { skill: "validate-phase" },
        produces: ["VALIDATION.md"],
        consumes: ["SUMMARY.md"],
        when: "workflow.nyquist_validation",
        onError: "halt",
      },
      {
        capId: "security",
        kind: "step",
        point: "verify:post",
        ref: { skill: "secure-phase" },
        produces: ["SECURITY.md"],
        consumes: ["SUMMARY.md"],
        when: "workflow.security_enforcement",
        onError: "halt",
      },
      {
        capId: "ui",
        kind: "step",
        point: "verify:post",
        ref: { skill: "ui-review" },
        produces: ["UI-REVIEW.md"],
        consumes: ["UI-SPEC.md"],
        when: "workflow.ui_review",
        onError: "skip",
      },
    ],
    contributions: [],
    gates: [],
  },
  "ship:pre": {
    steps: [],
    contributions: [],
    gates: [
      {
        capId: "security",
        kind: "gate",
        point: "ship:pre",
        check: {
          predicate: {
            kind: "artifact-frontmatter-equals",
            artifact: "SECURITY.md",
            field: "threats_open",
            equals: 0,
          },
        },
        when: "workflow.security_enforcement",
        blocking: true,
        onError: "halt",
      },
    ],
  },
  "ship:post": {
    steps: [
      {
        capId: "mempalace",
        kind: "step",
        point: "ship:post",
        ref: { agent: "gsd-mempalace-curator" },
        produces: [],
        consumes: ["UAT.md"],
        when: "mempalace.enabled",
        onError: "skip",
      },
    ],
    contributions: [],
    gates: [],
  },
} as const;

export const REGISTRY: CapabilityRegistry = {
  byLoopPoint,
} as const;

/**
 * debate:error — stubbed per Test-First Registry Specialist's strengthening.
 * Handler is unwired in sprint 1. Drop recovery deferred to sprint 2.
 * The fixture is assertable so the registry contract test catches both
 * wrong-model dispatch AND missing error channel.
 */
export const debateErrorStub: {
  kind: "debate:error";
  onError: "halt";
  blocking: true;
} = {
  kind: "debate:error",
  onError: "halt",
  blocking: true,
} as const;

Object.freeze(debateErrorStub);
Object.freeze(REGISTRY);
Object.freeze(REGISTRY.byLoopPoint);
