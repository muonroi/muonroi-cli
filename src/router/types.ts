export type Tier = "hot" | "warm" | "cold" | "degraded";

export interface ClassifierResult {
  tier: "hot" | "abstain";
  confidence: number; // 0..1
  reason: string; // 'regex:create-file' | 'tree-sitter:typescript' | 'low-confidence' etc
  modelHint?: string; // optional preferred model id from heuristic
}

export interface RouteDecision {
  tier: Tier;
  model: string;
  provider: string; // ProviderId -- kept loose to avoid circular import
  reason: string;
  confidence?: number;
  cap_overridden?: boolean;
  taskHash?: string;
  source?: string;
  reasoningEffort?: "low" | "medium" | "high";
}
