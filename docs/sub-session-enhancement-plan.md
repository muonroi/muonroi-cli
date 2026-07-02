# Sub-Session Enhancement Plan

**Goal:** Upgrade sub-session feature to address identified risks and improve reliability.

## Priority Order

### P1 - Critical Fixes (High Impact, Medium Effort)

#### Task 1: Adaptive Sub-Session Timeout
**Problem:** Hard-coded 15-minute timeout may be too short for complex tasks (debug, refactor).

**Solution:**
- Make timeout configurable via settings (`getSubSessionTimeoutMinutes`)
- Add default timeouts per agent type:
  - `verify`: 30 minutes
  - `general`: 15 minutes
  - `explore`: 20 minutes
  - `computer`: 25 minutes
- Add environment variable override `MUONROI_SUB_SESSION_TIMEOUT_MINUTES`

**Files to modify:**
- `src/utils/settings.ts` - add `getSubSessionTimeoutMinutes()` function
- `src/orchestrator/orchestrator.ts` - use adaptive timeout (line 2767)

**Verification:**
- Unit test: verify timeout selection per agent type
- E2E test: verify long-running tasks don't get marked as abandoned

**Estimated effort:** 2-3 hours

---

#### Task 2: Move Retry Logic Outside Sub-Session Check
**Problem:** Transient error retry only applies when `isSubSessionForked` is true - parent sessions don't get retries.

**Solution:**
- Move retry logic to apply to both parent and sub-sessions
- Keep `maxAttempts = 3` for both
- Log retry attempts clearly for debugging

**Files to modify:**
- `src/orchestrator/orchestrator.ts` - refactor retry logic (lines 2867-2882)

**Verification:**
- Unit test: verify retry works for parent session transient errors
- Integration test: simulate network errors and verify retry behavior

**Estimated effort:** 1-2 hours

---

### P2 - Important Improvements (Medium Impact, Medium Effort)

#### Task 3: Add EE Checkpoints Before Sub-Session Resume
**Problem:** Resuming a sub-session may lose context from compaction - no warning to user.

**Solution:**
- Before resuming, query EE for task checkpoints
- If checkpoint found, emit warning with checkpoint info
- Log telemetry for resume events

**Files to modify:**
- `src/orchestrator/orchestrator.ts` - add EE checkpoint query (line 2790)
- `src/pil/layer3-ee-injection.ts` - ensure checkpoint markers are searchable

**Verification:**
- Unit test: verify warning emitted when checkpoint exists
- Manual test: resume sub-session after compaction, observe warning

**Estimated effort:** 2-3 hours

---

#### Task 4: Document Sub-Session Absorption Rules
**Problem:** `salvageSubSessionOutput` logic is undocumented, unclear what gets absorbed.

**Solution:**
- Create `docs/sub-session-absorption.md` with clear rules
- Add JSDoc to `salvageSubSessionOutput` function
- Add unit tests for edge cases (no assistant message, no tool messages, etc.)

**Files to modify:**
- `docs/sub-session-absorption.md` - new file
- `src/orchestrator/orchestrator.ts` - add JSDoc (line 3360)
- `src/orchestrator/__tests__/sub-session-absorption.test.ts` - new test file

**Verification:**
- Review docs for clarity
- Run unit tests

**Estimated effort:** 1-2 hours

---

### P3 - Testing & Documentation (Lower Impact, Higher Effort)

#### Task 5: Expand E2E Test Coverage
**Problem:** Limited E2E harness tests for edge cases.

**Solution:**
Add tests for:
- Concurrent sub-sessions from parent
- Sub-session MCP server teardown
- Cross-turn dedup in sub-session
- Sub-agent budget exhaustion behavior
- Sub-session resume with compaction

**Files to modify:**
- `tests/harness/sub-session-e2e.spec.ts` - new comprehensive test file

**Verification:**
- Run all E2E tests
- Ensure no flaky behavior

**Estimated effort:** 4-6 hours

---

#### Task 6: Add Session Turn Count Check on Resume
**Problem:** Active sub-session with many turns gets resumed, bloating context without check.

**Solution:**
- Add `turn_count` column to sessions table (migration)
- Query turn count when considering resume
- If `turn_count > 10`, mark as stale and fork new session instead

**Files to modify:**
- `src/storage/migrations.ts` - add migration v10 for `turn_count` column
- `src/storage/transcript.ts` - add `getSessionTurnCount()` function
- `src/orchestrator/orchestrator.ts` - check turn count on resume (line 2766)

**Verification:**
- Unit test: verify stale marking when turn_count exceeded
- Integration test: verify new session forked when turn_count high

**Estimated effort:** 2-3 hours

---

## Implementation Strategy

### Phase 1 (Immediate - P1 only)
- Task 1: Adaptive timeout
- Task 2: Retry logic refactor
- Run all existing tests
- Commit: `feat(orchestrator): adaptive sub-session timeout + retry for all sessions`

### Phase 2 (Next - P2)
- Task 3: EE checkpoint integration
- Task 4: Absorption documentation
- Run all tests
- Commit: `feat(orchestrator): EE checkpoint warnings + absorption docs`

### Phase 3 (Later - P3)
- Task 5: E2E test expansion
- Task 6: Turn count check
- Run full test suite including harness tests
- Commit: `test(orchestrator): expanded sub-session e2e coverage + turn count limit`

---

## Success Criteria

- All existing unit tests pass
- All new unit tests pass
- Sub-session timeout configurable per agent type
- Retry works for both parent and sub-sessions
- Users warned about context loss on resume
- Absorption rules clearly documented
- E2E tests cover edge cases
- Turn count prevents context bloat on resume

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing behavior | Add feature flags, default to current behavior |
| Performance regression | Benchmark before/after, monitor in production |
| Test flakiness | Use deterministic mocks, avoid time-based tests |
| DB migration issues | Test migration on real DB, provide rollback path |

---

## Notes

- All changes should follow existing code style (TypeScript, JSDoc, logging)
- Use `logger.info`/`logger.warn`/`logger.error` with structured metadata
- Follow the Evidence-First rule - verify with actual tests, not assumptions
- Commit messages should follow conventional commits format