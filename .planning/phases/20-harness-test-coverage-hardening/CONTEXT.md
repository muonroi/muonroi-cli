# Phase 20: Harness Test Coverage Hardening

**Milestone:** v1.8 Hardening & Resilience
**Status:** Not planned yet
**Created:** 2026-05-19

## Origin

Code review of 2026-05-19 (see conversation transcript / `.planning/notes/code-review-2026-05-19.md`) identified that the harness test suite has 16 `.skip` / `.todo` specs whose skip reasons are either undocumented or buried in CLAUDE.md. The codebase looks better-covered than it is.

## Goal

Make harness coverage honest, traceable, and self-policing:

1. Every `.skip` and `.todo` in `tests/harness/**` has an inline comment of the form `// SKIP: <reason> — see issue #<n>` (or `# blocker: <link>` pointing to an internal note when no issue exists yet).
2. A new npm script `lint:harness-skips` parses all `tests/harness/**/*.spec.ts` and exits non-zero (or warns, per --strict) when skipped/todo ratio exceeds 10% of total specs.
3. Specs whose blockers have already been resolved are un-skipped (concrete candidates per CLAUDE.md:338-346: api-key valid-key submission, council-flow, determinism — verify each before un-skipping).
4. CLAUDE.md "Known caveats" section is updated to match reality (currently lists 4 caveats that are partially stale).

## Success Criteria

1. `bunx vitest -c vitest.harness.config.ts run tests/harness/` reports the same pass count or higher than before this phase.
2. `bun run lint:harness-skips` succeeds when ratio ≤ 10% and fails with a clear message when exceeded.
3. Every skipped spec has a one-line comment explaining the blocker.
4. README / CLAUDE.md "Known caveats" entries match the actual skip set.

## Out of Scope

- Writing new feature tests for un-tested code paths (different concern — would expand scope).
- Building any of the features the skipped specs are blocked on (api-key keychain seeding, council picker dialog, etc.).

## Open Questions

- Should `lint:harness-skips` warn or fail on > 10%? Recommendation: warn by default, `--strict` flag for CI.
- Is 10% the right threshold? May need calibration after first run.
