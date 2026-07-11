/**
 * loop-host-contract.ts — Native replacement for gsd-core/bin/lib/loop-host-contract.cjs
 *
 * ADR-894 §3 — Loop Host Contract, generated from workflow markers.
 * 12 points: discuss:pre/post, plan:pre/post, execute:pre/wave:pre/wave:post/post,
 * verify:pre/post, ship:pre/post. Per-step agentRoles and coreArtifacts.
 */
export interface LoopHostContractEntry {
  step: string;
  points: string[];
  agentRoles: string[];
  coreArtifacts: { produces: string[]; consumes: string[] };
}

export const LOOP_HOST_CONTRACT: LoopHostContractEntry[] = [
  {
    step: "discuss",
    points: ["discuss:pre", "discuss:post"],
    agentRoles: ["orchestrator"],
    coreArtifacts: { produces: ["CONTEXT.md"], consumes: [] },
  },
  {
    step: "plan",
    points: ["plan:pre", "plan:post"],
    agentRoles: ["researcher", "planner", "checker"],
    coreArtifacts: { produces: ["PLAN.md"], consumes: ["CONTEXT.md"] },
  },
  {
    step: "execute",
    points: ["execute:pre", "execute:wave:pre", "execute:wave:post", "execute:post"],
    agentRoles: ["executor", "verifier"],
    coreArtifacts: { produces: ["SUMMARY.md"], consumes: ["PLAN.md"] },
  },
  {
    step: "verify",
    points: ["verify:pre", "verify:post"],
    agentRoles: ["orchestrator"],
    coreArtifacts: { produces: ["UAT.md"], consumes: ["SUMMARY.md"] },
  },
  {
    step: "ship",
    points: ["ship:pre", "ship:post"],
    agentRoles: ["orchestrator"],
    coreArtifacts: { produces: [], consumes: ["UAT.md"] },
  },
];

/**
 * All canonical loop points derived from LOOP_HOST_CONTRACT.
 */
export function getAllCanonicalPoints(): string[] {
  return LOOP_HOST_CONTRACT.flatMap((e) => e.points);
}
