/**
 * src/lsp/__tests__/shared-fixtures.ts
 *
 * Shared test fixtures for the Slice 1 LSP impact contract (SLICE1-BUILD-NOTE.md).
 * Used by manager.test.ts (direct manager calls) and lsp-tools.test.ts
 * (MCP pass-through projections) so both surfaces assert against the same
 * canonical data — the pass-through projections MUST be byte-identical.
 *
 * Scenarios: ok (LSP available, clean/dirty), partial (diagnostics timeout),
 * unavailable (no server), and the fixed mutation-preview stub.
 */

import type {
  ImpactOfChangeResult,
  LspDiagnostic,
  LspQueryResult,
  MutationPreviewResult,
  PolicyAction,
} from "../types.js";

/** A warning-level diagnostic (severity 2) — NOT error-level, so it keeps `clean` true. */
export const FIXTURE_DIAGNOSTIC: LspDiagnostic = {
  message: "unused variable 'x'",
  severity: 2,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
};

/** An error-level diagnostic (severity 1) — flips `clean` to false. */
export const FIXTURE_ERROR: LspDiagnostic = {
  message: "Cannot find name 'foo'",
  severity: 1,
  source: "ts",
  code: "2304",
  range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } },
};

/** ── LspQueryResult fixtures (waitForDiagnostics) ─────────────────────────── */

export const QUERY_OK: LspQueryResult = {
  diagnostics: [FIXTURE_DIAGNOSTIC],
  lspStatus: "ok",
  clean: true, // only a warning present
  metadata: { tokenBudgetUsed: 0 },
};

export const QUERY_PARTIAL: LspQueryResult = {
  diagnostics: [],
  lspStatus: "partial",
  clean: true,
  metadata: { tokenBudgetUsed: 0 },
};

export const QUERY_UNAVAILABLE: LspQueryResult = {
  diagnostics: [],
  lspStatus: "unavailable",
  clean: false,
  metadata: { tokenBudgetUsed: 0 },
};

export const QUERY_DIRTY: LspQueryResult = {
  diagnostics: [FIXTURE_ERROR],
  lspStatus: "ok",
  clean: false, // error-level diagnostic present
  metadata: { tokenBudgetUsed: 0 },
};

/** ── ImpactOfChangeResult fixtures ────────────────────────────────────────── */

export const IOC_OK: ImpactOfChangeResult = {
  references: [],
  diagnostics: [FIXTURE_DIAGNOSTIC],
  referencesComplete: true,
  safeToRename: true,
  clean: true,
  suggestedGuard: "none",
  degraded: "none",
  lspStatus: "ok",
  metadata: { tokenBudgetUsed: 0 },
};

export const IOC_PARTIAL: ImpactOfChangeResult = {
  references: [],
  diagnostics: [],
  referencesComplete: true,
  safeToRename: false,
  clean: true,
  suggestedGuard: "none",
  degraded: "diagnostics_timeout",
  lspStatus: "partial",
  metadata: { tokenBudgetUsed: 0 },
};

export const IOC_UNAVAILABLE: ImpactOfChangeResult = {
  references: [],
  diagnostics: [],
  referencesComplete: false,
  safeToRename: false,
  clean: false,
  suggestedGuard: "none",
  degraded: "lsp_unavailable",
  lspStatus: "unavailable",
  metadata: { tokenBudgetUsed: 0 },
};

export const IOC_ERROR: ImpactOfChangeResult = {
  references: [{ uri: "file:///a.ts", range: { start: { line: 1, character: 1 }, end: { line: 1, character: 4 } } }],
  diagnostics: [FIXTURE_ERROR],
  referencesComplete: true,
  safeToRename: false, // union has an error-level diagnostic
  clean: false,
  suggestedGuard: "Cannot find name 'foo'",
  degraded: "none",
  lspStatus: "ok",
  metadata: { tokenBudgetUsed: 30 },
};

/** ── MutationPreviewResult stub (fixed schema, no apply path) ──────────────── */

export const MUTATION_STUB: MutationPreviewResult = {
  op: "allowlist",
  dryRunResult: { proposedEdits: [], tokenEstimate: 0 },
  schemaVersion: "1.0",
};

/** ── PolicyAction fixtures ────────────────────────────────────────────────── */

export const POLICY_ALLOW: PolicyAction = {
  kind: "allow",
  reason: "LSP ok and rename is safe",
};

export const POLICY_BLOCK: PolicyAction = {
  kind: "block",
  reason: "LSP timed out — grep would miss structural refs; ask user to retry",
};

export const POLICY_ENRICH: PolicyAction = {
  kind: "enrich",
  enrichWith: IOC_ERROR,
};
