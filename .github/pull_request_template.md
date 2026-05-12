<!-- Keep the title in Conventional Commits format: <type>(scope)?: subject -->

## Summary
<!-- 1-3 bullets: what changed and why. Skip the "what" if the title already says it. -->
-
-

## Files touched
<!-- Group by area. Mark NEW / MODIFIED / DELETED. Skip generated/dist. -->
- `src/...` —
- `src/...` —

## Risk level
<!-- One of: trivial | low | medium | high | breaking -->
- [ ] trivial — typos, docs, comments
- [ ] low — single-file refactor, no behavior change
- [ ] medium — touches multiple files / public API
- [ ] high — routing, storage, security, or council logic
- [ ] breaking — requires user migration / version bump

## Test coverage
- [ ] Added/updated unit tests
- [ ] Added/updated integration tests
- [ ] Manually verified (describe how below)
- [ ] N/A — rationale:

**Manual verification:**
<!-- Commands run, scenarios checked, screenshots if UI. -->

## Hidden coupling / call sites
<!-- Anything a future reader would miss? Sentinels, env-vars, env-dependent behavior, -->
<!-- cross-file invariants, ordering requirements. -->
-

## Migration / rollback
<!-- For medium+: how to roll back. For breaking: migration steps for users. -->
- Rollback:
- Migration (if breaking):

## Checklist
- [ ] Title follows Conventional Commits
- [ ] `bunx tsc --noEmit` clean
- [ ] `bunx vitest run` green
- [ ] `biome check src/` clean (or `bun run lint:fix` applied)
- [ ] CHANGELOG.md updated (for user-facing changes)
- [ ] No leaked secrets / dev config (pre-commit hook enforces)
