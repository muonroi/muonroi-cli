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

// ─── P0: Route model types (aligned with EE server.js actual response) ────────
export interface RouteModelRequest {
  task: string;
  tenantId: string;
  cwd: string;
  context?: {
    projectSlug?: string;
    phase?: string;
    files?: string[];
    domain?: string;
    activeRun?: string;
    localRoute?: { tier: string; confidence: number };
  };
  runtime?: "claude" | "gemini" | "codex" | "opencode";
}

export type RouteTier = "fast" | "balanced" | "premium";
export type RouteSource = "default" | "keyword" | "history" | "history-upgrade" | "brain";

export interface RouteModelResponse {
  model: string;
  tier: RouteTier;
  confidence: number;
  reason: string;
  source: RouteSource;
  taskHash: string;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface ColdRouteRequest {
  task: string;
  tenantId: string;
  cwd: string;
  context?: RouteModelRequest["context"];
  runtime?: RouteModelRequest["runtime"];
}

export interface ColdRouteResponse {
  model: string;
  tier: RouteTier;
  reason: string;
  taskHash: string;
}

// ─── P0: Route feedback ──────────────────────────────────────────────────────
export type RouteOutcome = "success" | "fail" | "retry" | "cancelled";

export interface RouteFeedbackPayload {
  taskHash: string;
  outcome: RouteOutcome;
  tier?: string | null;
  model?: string | null;
  retryCount?: number;
  duration?: number | null;
}

// ─── Feedback + touch contract ───────────────────────────────────────────────
export type Classification = "FOLLOWED" | "IGNORED" | "IRRELEVANT";

export interface FeedbackPayload {
  principle_uuid: string;
  classification: Classification;
  tool_name: string;
  duration_ms: number;
  tenantId: string;
}

// ─── P1: Prompt-stale reconciliation ─────────────────────────────────────────
export interface PromptStaleRequest {
  state: {
    surfacedIds?: string[];
    sessionId?: string;
    timestamp?: string;
  };
  nextPromptMeta?: {
    trigger: "compact" | "clear" | "auto-compact" | "session-end";
    cwd?: string;
    tenantId?: string;
  };
}

export interface PromptStaleResponse {
  ok: boolean;
  unused: string[];
  irrelevant: string[];
  expired: string[];
}

// ─── P1: Session extract ─────────────────────────────────────────────────────
export interface ExtractRequest {
  transcript: string;
  projectPath: string;
  meta?: {
    sessionId?: string;
    tenantId?: string;
    source?: "cli-exit" | "cli-clear" | "hook-stop";
  };
}

export interface ExtractResponse {
  ok: boolean;
  mistakes?: number;
  stored?: number;
}

// ─── P2: Knowledge visibility ────────────────────────────────────────────────
export interface EEStatsResponse {
  totalIntercepts: number;
  suggestions: number;
  misses: number;
  mistakesDetected?: number;
  lessonsStored?: number;
  extractSessions?: number;
  evolution?: {
    promoted: number;
    demoted: number;
    abstracted: number;
    archived: number;
  };
  perProject?: Record<string, { intercepts: number; suggestions: number }>;
  feedbackCounts?: Record<string, number>;
  noiseCounts?: Record<string, number>;
  costLedger?: Array<{ date: string; embed: number; brain: number; judge: number; extract: number }>;
  routingStats?: {
    byTier: Record<string, number>;
    bySource: Record<string, number>;
    outcomes: Record<string, number>;
  };
}

export interface EEGraphEdge {
  type: "generalizes" | "relates-to" | "supersedes" | "contradicts";
  target: string;
  weight: number;
  direction: "incoming" | "outgoing";
  createdAt: string;
}

export interface EEGraphResponse {
  id: string;
  edges: EEGraphEdge[];
  count: number;
}

export interface EETimelineEntry {
  id: string;
  trigger: string;
  solution: string;
  tier: number;
  confirmedAt: string[];
  createdAt: string;
  superseded?: boolean;
  score: number;
}

export interface EETimelineResponse {
  topic: string;
  timeline: EETimelineEntry[];
  count: number;
}

export interface EEGatesResponse {
  gates: Array<{
    name: string;
    status: "pass" | "fail" | "partial";
    checks: Array<{ label: string; ok: boolean; detail?: string }>;
  }>;
}

export interface EEEvolveResponse {
  success: boolean;
  promoted?: number;
  demoted?: number;
  abstracted?: number;
  archived?: number;
}

export interface EEShareResponse {
  shared: unknown;
  success: boolean;
}

export interface EEImportResponse {
  imported: unknown;
  success: boolean;
}

// ─── Task routing ────────────────────────────────────────────────────────────
export interface RouteTaskRequest {
  task: string;
  context?: Record<string, unknown>;
  runtime?: "claude" | "gemini" | "codex" | "opencode";
}

export interface RouteTaskOption {
  id: string;
  label: string;
  route: string;
  description: string;
}

export interface RouteTaskResponse {
  route: "qc-flow" | "qc-lock" | "direct" | null;
  confidence: number;
  source: string;
  reason: string;
  needs_disambiguation: boolean;
  options: RouteTaskOption[];
  taskHash: string | null;
}

// ─── Semantic search ─────────────────────────────────────────────────────────
export interface EESearchResult {
  id: string;
  score: number;
  text: string;
  collection: string;
}

export interface EESearchResponse {
  points: EESearchResult[];
}

// ─── User identity ───────────────────────────────────────────────────────────
export interface EEUserResponse {
  user: string;
}

// ─── Client interface ────────────────────────────────────────────────────────
export interface EEClient {
  health(): Promise<{ ok: boolean; status: number }>;
  intercept(req: InterceptRequest): Promise<InterceptResponse>;
  posttool(payload: PostToolPayload): Promise<void>;
  routeModel(req: RouteModelRequest, signal?: AbortSignal): Promise<RouteModelResponse | null>;
  coldRoute(req: ColdRouteRequest, signal?: AbortSignal): Promise<ColdRouteResponse | null>;
  feedback(payload: FeedbackPayload): void;
  touch(principle_uuid: string, tenantId: string): void;
  // P0: Route feedback
  routeFeedback(payload: RouteFeedbackPayload): void;
  // P1: Prompt-stale + extract
  promptStale(req: PromptStaleRequest): Promise<PromptStaleResponse | null>;
  extract(req: ExtractRequest): Promise<ExtractResponse | null>;
  // P2: Knowledge visibility
  stats(since?: string): Promise<EEStatsResponse | null>;
  graph(id: string): Promise<EEGraphResponse | null>;
  timeline(topic: string): Promise<EETimelineResponse | null>;
  gates(): Promise<EEGatesResponse | null>;
  evolve(trigger?: string): Promise<EEEvolveResponse | null>;
  sharePrinciple(principleId: string): Promise<EEShareResponse | null>;
  importPrinciple(data: unknown): Promise<EEImportResponse | null>;
  // Task routing + search + user
  routeTask(req: RouteTaskRequest): Promise<RouteTaskResponse | null>;
  search(query: string, limit?: number): Promise<EESearchResponse | null>;
  user(): Promise<EEUserResponse | null>;
}
