/**
 * src/lsp/__tests__/shared-fixtures.ts
 *
 * Shared test fixtures for LSP sprint 1 types and manager results.
 * Used by manager.test.ts (direct manager calls) and lsp-tools.test.ts
 * (MCP pass-through projections) so both surfaces assert against the
 * same canonical data.
 *
 * Scenarios covered:
 * - ready (full diagnostics, fallbackRecommended=false)
 * - partial (no server found, fallbackRecommended=true)
 * - timed_out (stale diagnostics, fallbackRecommended=true)
 * - cash (no diagnostics, empty results)
 */

import type {
  ImpactOfChangeResult,
  LspDiagnostic,
  LspQueryResult,
  MutationPreviewResult,
  PolicyAction,
} from "../types.js";

/** A single LSP diagnostic fixture — a plain "unused variable" warning. */
export const FIXTURE_DIAGNOSTIC: LspDiagnostic = {
  message: "unused variable 'x'",
  severity: 2,
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  },
};

/** ── LspQueryResult fixtures ──────────────────────────────────────────── */

export const QUERY_READY: LspQueryResult = {
  diagnostics: [FIXTURE_DIAGNOSTIC],
  readiness: "ready",
  fallbackRecommended: false,
};

export const QUERY_PARTIAL: LspQueryResult = {
  diagnostics: [],
  readiness: "partial",
  fallbackRecommended: true,
};

export const QUERY_TIMED_OUT: LspQueryResult = {
  diagnostics: [FIXTURE_DIAGNOSTIC],
  readiness: "timed_out",
  fallbackRecommended: true,
};

export const QUERY_CASH: LspQueryResult = {
  diagnostics: [],
  readiness: "ready",
  fallbackRecommended: false,
};

/** ── ImpactOfChangeResult fixtures ─────────────────────────────────────── */

export const IOC_READY: ImpactOfChangeResult = {
  diagnostics: [FIXTURE_DIAGNOSTIC],
  references: [],
  safeToRename: true,
  readiness: "ready",
  fallbackRecommended: false,
};

export const IOC_PARTIAL: ImpactOfChangeResult = {
  diagnostics: [],
  references: [],
  safeToRename: false,
  readiness: "partial",
  fallbackRecommended: true,
  suggestedGuard: "waitForDiagnostics(filePath).readiness === 'ready'",
  degraded: true,
};

export const IOC_TIMED_OUT: ImpactOfChangeResult = {
  diagnostics: [FIXTURE_DIAGNOSTIC],
  references: [],
  safeToRename: false,
  readiness: "timed_out",
  fallbackRecommended: true,
  suggestedGuard: "waitForDiagnostics(filePath).readiness !== 'timed_out'",
  degraded: true,
};

/** ── MutationPreviewResult stub ────────────────────────────────────────── */

export const MUTATION_STUB: MutationPreviewResult = {
  preview: [],
};

/** ── PolicyAction fixtures ─────────────────────────────────────────────── */

export const POLICY_ALLOW: PolicyAction = {
  kind: "allow",
  reason: "LSP is ready and diagnostics are current",
};

export const POLICY_BLOCK: PolicyAction = {
  kind: "block",
  reason: "LSP timed out — grep would miss structural refs; ask user to retry",
};

export const POLICY_ENRICH: PolicyAction = {
  kind: "enrich",
  enrichWith: IOC_PARTIAL,
};
