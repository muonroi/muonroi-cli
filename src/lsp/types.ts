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

export interface LspQueryResult {
  diagnostics: LspDiagnostic[];
  readiness: "ready" | "partial" | "timed_out";
  fallbackRecommended: boolean;
}

export interface ImpactOfChangeResult {
  diagnostics: LspDiagnostic[];
  references: LspLocation[];
  safeToRename: boolean;
  readiness: "ready" | "partial" | "timed_out";
  fallbackRecommended: boolean;
  /** Suggested guard expression when fallbackRecommended & !safeToRename. */
  readonly suggestedGuard?: string;
  /** True when the result was computed with a degraded/stale server. */
  readonly degraded?: boolean;
}

export interface MutationPreviewResult {
  readonly preview: [];
  readonly id?: string;
  readonly label?: string;
  readonly kind?: string;
  readonly proposedEdits?: [];
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
