/**
 * EE HTTP client type contracts.
 *
 * These are the wire shapes sent to/received from the Experience Engine
 * running at localhost:8082. The EE protocol deliberately excludes provider
 * API keys — only toolName + toolInput + cwd cross the HTTP boundary (T-00.06-01).
 *
 * Phase 1 cross-phase changes:
 *   EE-04: tenantId is REQUIRED on every request (single-tenant local = "local")
 *   EE-05: Scope union required on InterceptRequest + PostToolPayload
 *   EE-06: principle_uuid + embedding_model_version on every InterceptMatch
 */

export type Scope =
  | { kind: "global" }
  | { kind: "ecosystem"; name: "muonroi" }
  | { kind: "repo"; remote: string }
  | { kind: "branch"; remote: string; branch: string };

export interface InterceptRequest {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  tenantId: string; // EE-04: required
  scope: Scope; // EE-05: required
}

export interface InterceptMatch {
  principle_uuid: string; // EE-06
  embedding_model_version: string; // EE-06
  confidence: number;
  why: string;
  message: string;
  expectedBehavior?: string;
  scope_label: string;
  last_matched_at: string;
}

export interface InterceptResponse {
  decision: "allow" | "block";
  matches?: InterceptMatch[];
  // back-compat aliases for Phase 0 internals — keep optional
  suggestions?: string[];
  surfacedIds?: string[];
  reason?: string;
}

export interface PostToolPayload {
  toolName: string;
  toolInput: unknown;
  outcome: {
    success: boolean;
    exitCode?: number;
    durationMs?: number;
    error?: string;
  };
  cwd: string;
  tenantId: string; // EE-04: required
  scope: Scope; // EE-05: required
  surfacedIds?: string[];
}

// Plan 03 types — keep tenantId required:
export interface RouteModelRequest {
  prompt: string;
  tenantId: string;
  cwd: string;
}

export interface RouteModelResponse {
  model: string;
  provider: string;
  tier: "warm" | "cold";
  confidence: number;
  reason: string;
}

export interface ColdRouteRequest {
  prompt: string;
  tenantId: string;
  cwd: string;
}

export interface ColdRouteResponse {
  model: string;
  provider: string;
  tier: "cold";
  reason: string;
}

// Plan 08 — feedback + touch contract:
export type Classification = "FOLLOWED" | "IGNORED" | "IRRELEVANT";

export interface FeedbackPayload {
  principle_uuid: string;
  classification: Classification;
  tool_name: string;
  duration_ms: number;
  tenantId: string;
}

export interface EEClient {
  health(): Promise<{ ok: boolean; status: number }>;
  intercept(req: InterceptRequest): Promise<InterceptResponse>;
  posttool(payload: PostToolPayload): void;
  routeModel(
    req: RouteModelRequest,
    signal?: AbortSignal,
  ): Promise<RouteModelResponse | null>;
  coldRoute(
    req: ColdRouteRequest,
    signal?: AbortSignal,
  ): Promise<ColdRouteResponse | null>;
  feedback(payload: FeedbackPayload): void; // Plan 08 implements
  touch(principle_uuid: string, tenantId: string): void; // Plan 08 implements
}
