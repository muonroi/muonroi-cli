# Plan amendment handoff for session 8a5bd89c2be0

D1/D2 were subsequently amended in the consumer PLAN.md at the user's explicit request. The gate and saved review artifacts remain untouched; the following distinguishes applied changes from proposed clarifications.

## Exact live target and observed results

- Plan: `D:/sources/CompanyLibs/tcis-libraries/.muonroi-flow/planning/PLAN.md`.
- Original SHA-256: `3634064dbeb60861c85be44dab7333b0eff6da9c4e60c8dc1507f18a139ac6c9`.
- D1/D2 amended SHA-256: `51a1ab4452838d799b5fff4126d65311893e6493c713252a8ca96e532bffc384`. Section4.3 starts at line139, item5.b at line351, explicit total/per-tier report semantics at lines357-359. Only two text hunks changed.
- Independent verification `clever-teal-sparrow`: complete, structured `fail`, result version `7c5b1f8c0554bcdcd18e3d8540f50bf25f071444e995156f2984079957f301bb`.
- Original council used by that verification: `steady-copper-badger`, version `f9d305648ddeefbbe43fd0b2c97b175f355e3806e377bb9afcdc9718b5401aae`.
- Path-verification worker `lively-emerald-lynx`: complete at 2026-11-02T08:41:37.910Z, version `9afcd53c86fc24975805ee9f81d04c34c93ee779b3a4ede9a60477e8ce0d52ee`. Read this completed result rather than continuing to wait for it.

## Minimal content corrections for main to assess

1. APPLIED D1 — Scope/count: independent filesystem enumeration returns src104 + docs48 + md21 + HandBook8 =181. Top-level AGENTS.md, CLAUDE.md and GEMINI.md add3. Section4.3 and item5.b now explicitly include those three top-level files in addition to recursive enumeration of the four named directories. They do not recursively add the entire repository root.184 is the observed baseline; actual manifest/count is checked against independent enumeration of the declared scope.
2. APPLIED D2 — Report assertion: Count now explicitly means total actual redaction entries across BOTH enabled tiers under section4.4 rules, with expected total0/Tier1=0/Tier2=0. Keyword occurrence counts alone do not establish Tier2 detections: assignment context, value shape/entropy and placeholder exclusions still apply. Seeded positives remain separate evidence of detection effectiveness.
3. D3 already classified closed by owning main: section4.4 explicitly says Tier1 scans inline/comments and item5.a includes inline fixtures. An optional implementation clarification is to use original content for Tier1 and an offset-preserving masked Tier2 view. This D1/D2 amendment does not change D3 or introduce a new blocker for that clarification.
4. Advisory: authority row md/13-22 names a nonexistent md/13. Derive the supported range from actual files; keep this separate from blocking admission decisions.

## CLI continuation after rebuilding/reopening

The initial revalidation implementation reserved one attempt for an entire source council, including all future amendments. The correction reserves exact planning inputs plus the host source fingerprint. Unchanged completed work reuses its result; unchanged failed/cancelled work cannot buy another attempt. A changed reason is not new evidence. A genuine amendment/source correction may receive a fresh read-only verification under the SAME original council without resetting/spending the council allowance.

D1/D2 are already saved: main should use `flow_plan_review(action=revalidate, jobId=<original council>, resultVersion=<original version>, reason=<specific corrections>)` without rewriting the file again. A running verifier prevents overlapping amendments/dispatches. Read the new job's exact result and dossier, assess all findings, then complete that verification job. Old fail/pass results cannot approve changed inputs. No new user request or force gate is needed for this recovery path.

Post-edit runtime check confirmed the consumer planning root, PLAN-VERIFY verdict=revise and canExecute(standard).allowed=false. STATE, PLAN-VERIFY, PLAN-REVIEW, finding ledger and top-level AGENTS/CLAUDE/GEMINI hashes were unchanged. The documentation amendment does not admit execution or establish scanner implementation correctness.
