export const FLOW_PHASES = ["discuss", "plan", "execute", "verify", "review", "debug"] as const;

export type FlowPhase = (typeof FLOW_PHASES)[number];

export type WorkflowKind = "task" | "product";

export function isFlowPhase(value: string): value is FlowPhase {
  return (FLOW_PHASES as readonly string[]).includes(value);
}
