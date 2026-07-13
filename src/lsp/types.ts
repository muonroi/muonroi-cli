export const LSP_TOOL_OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "waitForDiagnostics",
] as const;

export type LspToolOperation = (typeof LSP_TOOL_OPERATIONS)[number];

export type LspBuiltInServerId =
  | "typescript"
  | "pyright"
  | "gopls"
  | "rust-analyzer"
  | "bash-language-server"
  | "yaml-language-server"
  | "clangd"
  | "jdtls"
  | "sourcekit-lsp"
  | "csharp-ls";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  message: string;
  severity?: number;
  source?: string;
  code?: string;
  range: LspRange;
}

export interface LspDiagnosticFile {
  filePath: string;
  serverId: string;
  diagnostics: LspDiagnostic[];
}

export interface LspLaunchSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
}

export interface LspBuiltInServerSettings {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  rootMarkers?: string[];
  extensions?: string[];
}

export interface LspCustomServerConfig {
  id: string;
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  rootMarkers?: string[];
  extensions: string[];
  languageIds?: Record<string, string>;
}

export interface LspSettings {
  enabled?: boolean;
  tool?: boolean;
  autoInstall?: boolean;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  diagnosticsDebounceMs?: number;
  builtins?: Partial<Record<LspBuiltInServerId, LspBuiltInServerSettings>>;
  servers?: LspCustomServerConfig[];
}

export interface NormalizedLspSettings {
  enabled: boolean;
  tool: boolean;
  autoInstall: boolean;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  diagnosticsDebounceMs: number;
  builtins: Partial<Record<LspBuiltInServerId, LspBuiltInServerSettings>>;
  servers: LspCustomServerConfig[];
}

export interface LspQueryInput {
  operation: LspToolOperation;
  filePath: string;
  line?: number;
  character?: number;
  query?: string;
}

/**
 * LSP readiness status (SLICE1-BUILD-NOTE.md §79-86, §73-77).
 * - `ok`          — diagnostics resolved within the ≤5s budget
 * - `partial`     — one or more waits timed out; stale diagnostics were used
 * - `unavailable` — no server could be reached or the query threw
 * The lsp-before-grep policy keys on this: grep fallback is allowed when
 * `lspStatus !== 'ok'`.
 */
export type LspStatus = "ok" | "partial" | "unavailable";

/**
 * Reason a composite result is degraded (SLICE1-BUILD-NOTE.md §33-40).
 * Precedence when several apply: lsp_unavailable > diagnostics_timeout >
 * refs_truncated > none.
 */
export type DegradedReason = "none" | "refs_truncated" | "diagnostics_timeout" | "lsp_unavailable";

/** Per-call token-budget accounting; `tokenBudgetUsed` is hard-capped ≤500. */
export interface LspResultMetadata {
  /** Elapsed + reference estimate, clamped to ≤500 (SLICE1-BUILD-NOTE.md §49-54). */
  tokenBudgetUsed: number;
}

/** `waitForDiagnostics` result (SLICE1-BUILD-NOTE.md §79-86). */
export interface LspQueryResult {
  diagnostics: LspDiagnostic[];
  lspStatus: LspStatus;
  /** True only when zero error-level (severity ≤ 1) diagnostics exist for the file. */
  clean: boolean;
  metadata: LspResultMetadata;
}

/** `impact_of_change` composite result (SLICE1-BUILD-NOTE.md §10, §19-54). */
export interface ImpactOfChangeResult {
  references: LspLocation[];
  diagnostics: LspDiagnostic[];
  /** False when the reference list was truncated to stay within token budget. */
  referencesComplete: boolean;
  /**
   * True only when `referencesComplete === true` AND the frozen union (symbol
   * file + every referenced file) has zero error-level diagnostics AND the LSP
   * was fully available. `false` is the safe default → agents grep-fallback.
   */
  safeToRename: boolean;
  /** Zero error-level diagnostics on the union of the symbol file + reference files. */
  clean: boolean;
  /** Top-2 error category messages joined with "; ", ≤120 chars; "none" when clean. */
  suggestedGuard: string;
  degraded: DegradedReason;
  lspStatus: LspStatus;
  metadata: LspResultMetadata;
}

/**
 * `lsp_mutation_preview` stub (SLICE1-BUILD-NOTE.md §55-71). Fixed schema, no
 * `workspaceEdit`, no apply path — real diff computation is Slice 2.
 */
export interface MutationPreviewResult {
  readonly op: "allowlist";
  readonly dryRunResult: {
    readonly proposedEdits: [];
    readonly tokenEstimate: number;
  };
  readonly schemaVersion: "1.0";
}

/**
 * Tagged error kind for LSP operation failures.
 * Throw-only canonical failure for slice 1 ── every failure flows
 * through a single syntactic choke point (the projection's try/catch).
 */
export type LspErrorKind = "no_server" | "request_timeout" | "request_failed" | "lsp_disabled" | "unknown";

/** Tagged‑union Error used by manager methods. */
export class LspError extends Error {
  readonly kind: LspErrorKind;
  constructor(kind: LspErrorKind, message: string) {
    super(message);
    this.name = "LspError";
    this.kind = kind;
  }
}

/** Policy decision the lsp‑before‑grep gate returns. */
export type PolicyAction =
  | { kind: "allow"; reason: string }
  | { kind: "block"; reason: string }
  | { kind: "enrich"; enrichWith: ImpactOfChangeResult };

export interface LspToolResponse {
  success: boolean;
  output: string;
  lspDiagnostics?: LspDiagnosticFile[];
}
