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
  | { kind: "ecosystem"; name: string }
  | { kind: "repo"; remote: string }
  | { kind: "branch"; remote: string; branch: string };

/**
 * Optional intent context attached to InterceptRequest by muonroi-cli.
 * Hooks in foreign CLIs (Claude Code, Gemini, Codex) can't see these — only the
 * native orchestrator can populate them. The EE server may use them to improve
 * the L3 brain relevance filter without breaking on absence.
 */
export interface InterceptIntentContext {
  /** Last ~200 chars of the assistant's reasoning before the tool call. */
  assistantReasoningExcerpt?: string;
  /** Principle UUIDs already surfaced earlier in the same session. */
  priorWarningIdsInSession?: string[];
  /** Active GSD phase identifier when running under GSD workflow. */
  gsdPhase?: string;
  /** First ~200 chars of the user prompt that started this turn. */
  userGoalExcerpt?: string;
}

export interface InterceptRequest {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  tenantId: string; // EE-04: required
  scope: Scope; // EE-05: required
  /** P0 native observation: optional intent context (server ignores if unknown). */
  context?: InterceptIntentContext;
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
  /**
   * Qdrant collection this principle lives in. Optional — older response
   * shapes do not carry it. Used by the phase-outcome wiring to credit-
   * assign principles back to the brain.
   */
  collection?: string;
}

export interface InterceptResponse {
  decision: "allow" | "block";
  matches?: InterceptMatch[];
  // back-compat aliases for Phase 0 internals — keep optional
  suggestions?: string[];
  surfacedIds?: string[];
  reason?: string;
}

/** Mistake kinds inferred by the local mistake-detector (P0 native observation). */
export type MistakeKind = "user-veto" | "retry-pattern";

/**
 * Rich outcome — extends `outcome.success` with verifier/build/test/typecheck
 * results that hooks alone cannot surface, plus mistake-detector signal.
 *
 * All extra fields are optional. The current EE server ignores unknown fields
 * (extra-tolerant JSON), so wire-format upgrades are non-breaking.
 */
export interface PostToolOutcome {
  success: boolean;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  // P0 rich outcome — populated when the CLI knows the deeper result.
  verifyResult?: "pass" | "fail" | "skip";
  buildResult?: { exitCode: number; durationMs: number };
  typeCheckResult?: "pass" | "fail";
  testResult?: { passed: number; failed: number };
  // P0 mistake signal — only ever set by client-side detector, never by agent self-report.
  mistakeKind?: MistakeKind;
  evidence?: Record<string, unknown>;
}

export interface PostToolPayload {
  toolName: string;
  toolInput: unknown;
  outcome: PostToolOutcome;
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
    recentTurns?: string;
    projectSize?: "small" | "medium" | "large";
    filesTouched?: number;
    mode?: string;
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
    source?: "cli-exit" | "cli-clear" | "hook-stop" | "cli-compact" | "cli-compact-checkpoint" | "tool-artifact";
    scope?: string;
    iteration?: number;
    tokensBefore?: number;
    // Idea 4: tool-artifact on-demand re-hydrate fields (non-breaking extra)
    toolCallId?: string;
    toolName?: string;
    reason?: string;
    elidedAtStep?: number;
    [k: string]: unknown;
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

export interface EESearchOptions {
  limit?: number;
  /**
   * Optional list of Qdrant collections to search. Server defaults to
   * ['experience-behavioral'] when omitted. Allowed values currently:
   *   - 'experience-behavioral'
   *   - 'experience-principles'
   */
  collections?: string[];
  /** Override per-call timeout. Defaults to 3000ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ─── Active recall (recallMode /api/recall) ──────────────────────────────────
// Distinct from EESearch* above: /api/search is a raw single-collection vector
// lookup; /api/recall runs the full recallMode pipeline (3 collections merged
// by raw cosine, integrity gates kept, records a surface) and returns the
// formatted [id col] index — the same path exp-recall.js uses.
export interface EERecallEntry {
  id: string;
  collection: string | null;
}

export interface EERecallResponse {
  /** Formatted recall index carrying `[id col]` handles (null when nothing matched). */
  text: string | null;
  entries: EERecallEntry[];
  count: number;
  query?: string;
}

export interface EERecallOptions {
  /** Scope hint → body.project_slug (advisory under recallMode). */
  project?: string;
  /** Working dir → body.cwd (server derives project_slug + attribution). */
  cwd?: string;
  /** Stable session id → body.sourceSession (slice-2 stitch detection). */
  sourceSession?: string;
  /** Override per-call timeout. Defaults to 15000ms — server bounds recall at ~8s internally; allow margin for embed + 3-leg search + network. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ─── User identity ───────────────────────────────────────────────────────────
export interface EEUserResponse {
  user: string;
}

// ─── Brain proxy options — forwarded to server for SAMR/custom classifiers ────
export interface BrainProxyOptions {
  /** Override the default system prompt sent to the LLM. */
  systemPrompt?: string;
  /** Request JSON-mode response_format (e.g. { type: "json_object" }). */
  responseFormat?: { type: string };
  /** Override the LLM model id used for classification. */
  model?: string;
  /** Override max_tokens for the LLM response. */
  maxTokens?: number;
  /** Override the brain provider (siliconflow | ollama | openai | ...). */
  provider?: string;
}

// ─── Client interface ────────────────────────────────────────────────────────
export interface EEClient {
  health(): Promise<{ ok: boolean; status: number }>;
  intercept(req: InterceptRequest): Promise<InterceptResponse>;
  posttool(payload: PostToolPayload): Promise<void>;
  routeModel(req: RouteModelRequest, signal?: AbortSignal): Promise<RouteModelResponse | null>;
  coldRoute(req: ColdRouteRequest, signal?: AbortSignal): Promise<ColdRouteResponse | null>;
  feedback(payload: FeedbackPayload): void;
  noiseFeedback(payload: {
    pointId: string;
    collection: string;
    reason: "wrong_repo" | "wrong_language" | "wrong_task" | "stale_rule";
  }): void;
  touch(principle_uuid: string, tenantId: string): void;
  // P0: Route feedback
  routeFeedback(payload: RouteFeedbackPayload): void;
  // P1: Prompt-stale + extract
  promptStale(req: PromptStaleRequest): Promise<PromptStaleResponse | null>;
  extract(req: ExtractRequest, signal?: AbortSignal): Promise<ExtractResponse | null>;
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
  search(query: string, opts?: EESearchOptions | number): Promise<EESearchResponse | null>;
  /** Active recall via /api/recall (recallMode). Returns [id col] index + records a surface. */
  recall(query: string, opts?: EERecallOptions): Promise<EERecallResponse | null>;
  user(): Promise<EEUserResponse | null>;
  // PIL brain proxy — used by thin clients to reach the VPS LLM router.
  brainProxy(prompt: string, timeoutMs?: number, options?: BrainProxyOptions): Promise<string | null>;
  pilContext(
    prompt: string,
    options?: { localeHint?: string; projectCtx?: Record<string, unknown>; budgetMs?: number; signal?: AbortSignal },
  ): Promise<unknown | null>;
}
