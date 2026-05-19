# Phase 22: Small Hardening Bundle

**Milestone:** v1.8 Hardening & Resilience
**Status:** Not planned yet
**Created:** 2026-05-19

## Origin

Two small but compounding tech-debt items from the 2026-05-19 code review:

- **Rec #2:** `src/orchestrator/cross-turn-dedup.ts` uses a 12-hex-char (48-bit) sha1 prefix for content hashing. On long sessions the collision space is unacceptably small.
- **Rec #5:** `src/agent-harness/index.ts` is a backwards-compat shim that re-exports from `@muonroi/agent-harness-core` and `@muonroi/agent-harness-opentui`. It is silently consumed by internal callers; when packages are published to npm, external users will hit broken imports without warning.

Both are small enough to ship together.

## Goal

### Rec #2 — Hash upgrade
1. Replace sha1-12 with sha256-16 (16 hex chars = 64 bits) in `cross-turn-dedup.ts`.
2. Update inline comment to record collision-property reasoning.
3. Re-run `tests/harness/cost-leak-c3.spec.ts` — must still pass (dedup still triggers on identical content).
4. Add a regression test that two distinct large tool_results don't collide.

### Rec #5 — Shim deprecation
1. Emit a one-shot `console.warn(...)` from `src/agent-harness/index.ts` advising consumers to switch to `@muonroi/agent-harness-core` / `-opentui`.
2. Suppress the warning inside this repo (`if (process.env.MUONROI_INTERNAL_SHIM_OK !== '1')`).
3. Add a CHANGELOG migration section documenting the new import paths.
4. Update package README files in `packages/agent-harness-{core,opentui,react,angular}` to link the migration section.

## Success Criteria

1. `bun run test` — full suite green, including cost-leak-c3 and the new collision regression test.
2. Grep for `sha1` in `src/orchestrator/cross-turn-dedup.ts` returns 0 hits; sha256 hit count = 1.
3. Running any harness spec without `MUONROI_INTERNAL_SHIM_OK=1` produces the deprecation warning on stderr (verify with one harness spec).
4. CHANGELOG.md migration block exists and is linked from all 4 package READMEs.

## Out of Scope

- Removing the shim entirely (still needed for in-repo callers — keep it, just warn externally).
- Migrating internal callers off the shim (separate clean-up, not a hardening blocker).
- Renaming or restructuring `packages/`.

## Open Questions

- Should the deprecation warning include the call-site stack trace (helpful) or just a static message (cleaner)?
- Is sha256-16 enough or should we go sha256-24? 64 bits gives birthday-collision at ~4B entries; LRU cap is 200 so this is overkill-safe.
