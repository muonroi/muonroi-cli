# Slice 1 — Review Notes (human-in-the-loop)

> Held for the formal review pass once Sprint 1 lands a commit.
> Reviewer: main-loop agent observing /ideal sprint `mrgjddrx218a`.

## Flags spotted during in-progress implementation (must verify at review)

1. **`tokenBudgetUsed` uses wall-clock ms, not response size.**
   In `src/lsp/manager.ts` both `impactOfChange` and `waitForDiagnosticsImpl` set
   `tokenBudgetUsed: Math.min(elapsed, 500)` (elapsed = `Date.now() - startTime`).
   This is exactly the "meter theater" the CB-1 council flagged: LSP has no
   per-token billing. Refinement was to cap **serialized response SIZE**
   (truncate refs/diagnostics, keep counts), NOT wall-clock time. Raise: replace
   ms with a real serialized-byte/char estimate, or rename the field so it stops
   claiming to be a token budget.

2. **Missing import / undefined type → likely `tsc` break.**
   `manager.ts` uses `fileURLToPath(uri)` but only `pathToFileURL` is imported
   from `"url"`. Also casts `JSON.parse(...) as LspReferenceEntry[]` but
   `LspReferenceEntry` is not imported/defined anywhere yet. The sprint verify
   stage (tsc) should catch these; if it doesn't, block the PR.

3. **`suggestedGuard` type vs impl mismatch.**
   types.ts declares `suggestedGuard: string | null` (null when clean), but the
   manager impl returns the literal string `"none"` (and `"lsp_unavailable"`),
   never null. Acceptance criteria says structured/null when clean. Align impl
   with the contract (return null when clean) or tighten the type.

## BLOCKERS found in native-tools.ts (Sprint 1, +114) — HIGH severity

4. **`impact_of_change` native tool does NOT call `manager.impactOfChange`.**
   It does `import { impactOfChange } from "../lsp/manager.js"` — but that name is
   a closure method on the object returned by `createWorkspaceLspManager`, NOT an
   exported function. The import resolves to `undefined` (tsc should error:
   "no exported member 'impactOfChange'"). Worse, it doesn't even use it — the
   body calls `queryLsp(cwd, { operation: "findReferences", ...input })` and
   returns raw references. So NO diagnostics, NO safeToRename, NO degraded — the
   whole composite the manager implemented is bypassed. Comment admits it:
   "pass-through projection placeholder". VIOLATES the plan's byte-identical
   manager-projection contract.

5. **`wait_for_diagnostics` native tool calls `goToDefinition`, not diagnostics.**
   Body: `queryLsp(cwd, { operation: "goToDefinition", ...input, line:1, character:1 })`.
   Completely wrong operation — never calls `manager.waitForDiagnostics`. Returns
   goToDefinition results labelled as diagnostics. Semantically broken; tsc will
   NOT catch this (type-valid).

6. **Root cause: `src/lsp/runtime.ts` never got a wrapper for the new methods.**
   `queryLsp` wraps `manager.query`; there is no `impactOfChange`/`waitForDiagnostics`/
   `mutationPreview` runtime export. The agent noticed ("Runtime doesn't expose
   impactOfChange directly yet") but stubbed instead of adding the wrapper. The
   real fix: add runtime wrappers, then have native-tools delegate to them.

7. **`LSP_BEFORE_GREP_POLICY_TEXT` is dead code.** Defined as a local const in
   native-tools.ts and never referenced. Plan wanted the text seeded into
   `src/pil/native-capabilities-workbook.ts`, not a dangling const.

## Also watch at review (from the plan, not yet verified)
- native-tools.ts + mcp/lsp-tools.ts must be **pure pass-through** of manager
  output — harness asserts byte-identical JSON. Confirm no recomputation.
- `LSP_MUTATION` category must NOT inherit `lsp_query`'s READ_ONLY path.
- Self-verify harness must run on BOTH C# and TS, skip-with-reason when a
  language server is missing (not hard-fail).
- Confirm the manager interface `waitForDiagnostics(input)` is actually wired to
  `waitForDiagnosticsImpl` in the returned object (name mismatch risk).
