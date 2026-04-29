---
phase: "00-fork-skeleton"
plan: "06"
subsystem: "ee,storage,hooks"
tags: ["ee-client", "atomic-io", "usage-guard", "hooks-dispatcher", "tdd"]
dependency_graph:
  requires: ["00-04"]
  provides: ["ee-http-client", "storage-atomic-io", "cap-state-schema", "hooks-dispatcher-rewrite"]
  affects: ["00-07", "Phase 1 EE-02..EE-10", "Phase 1 USAGE-02..07"]
tech_stack:
  added: ["src/ee/", "src/storage/atomic-io.ts", "src/storage/config.ts", "src/storage/usage-cap.ts"]
  patterns: ["TDD RED→GREEN", "fire-and-forget", "AbortSignal.timeout", "atomic-rename (.tmp + rename)", "injectable fetchImpl"]
key_files:
  created:
    - src/ee/types.ts
    - src/ee/client.ts
    - src/ee/intercept.ts
    - src/ee/posttool.ts
    - src/ee/health.ts
    - src/ee/index.ts
    - src/ee/client.test.ts
    - src/storage/atomic-io.ts
    - src/storage/atomic-io.test.ts
    - src/storage/config.ts
    - src/storage/config.test.ts
    - src/storage/usage-cap.ts
    - src/storage/usage-cap.test.ts
  modified:
    - src/storage/index.ts
    - src/hooks/index.ts
  deleted:
    - src/hooks/executor.ts
decisions:
  - "Storage files named usage-cap.ts (not usage.ts) to avoid clash with the existing SQLite-backed usage.ts (recordUsageEvent). The plan said usage.ts but that name conflicts. Tracked as minor deviation."
  - "posttool declared as a non-async synchronous method returning void — B-4 compliance enforced. Test 7 verifies constructor.name === 'Function'."
  - "Rate-limit for 'EE unreachable' console.warn set to 60s via module-level timestamp — prevents log flooding when EE is down but TUI is active."
metrics:
  duration: "5 minutes"
  completed_date: "2026-04-29"
  tasks_completed: 2
  tests_added: 19
  files_created: 13
  files_modified: 2
  files_deleted: 1
---

# Phase 00 Plan 06: EE HTTP Client + Storage Skeletons Summary

One-liner: EE HTTP client to localhost:8082 replacing grok-cli shell-spawn hooks, plus atomic-rename JSON IO and cap-state schema under TUI ownership.

## What Was Built

### Task 1: Storage Skeletons (USAGE-01, USAGE-06, Pitfall 9)

**Atomic IO primitive** (`src/storage/atomic-io.ts`):
```typescript
export async function atomicWriteJSON(filePath: string, value: unknown): Promise<void>
export async function atomicReadJSON<T>(filePath: string): Promise<T | null>
```
Uses `.tmp + rename` pattern. Serialize failures never touch the destination file. Rename failures clean up the tmp file. Returns `null` for absent files (not throws). Throws on corrupted JSON.

**Config** (`src/storage/config.ts`):
```typescript
export async function loadConfig(homeOverride?: string): Promise<MuonroiConfig>
export interface MuonroiConfig {
  cap: { monthly_usd: number };  // default 15
  ee?: { baseUrl?: string; authToken?: string };
}
```
Accepts `homeOverride` or `MUONROI_CLI_HOME` env var for test isolation. Default `~/.muonroi-cli/config.json`. Bootstraps with `cap.monthly_usd = 15` on first run.

**Usage** (`src/storage/usage-cap.ts`):
```typescript
export async function loadUsage(homeOverride?: string): Promise<UsageState>
export async function saveUsage(state: UsageState, homeOverride?: string): Promise<void>
export interface UsageState {
  current_month_utc: string;  // "YYYY-MM"
  current_usd: number;
  reservations: Array<{ id: string; usd: number; createdAtMs: number }>;
}
```
Auto-resets `current_usd` to 0 on month rollover. Phase 0 scope: schema + atomic IO + boot read only — no enforcement, no thresholds, no auto-downgrade (Phase 1 USAGE-02..05/07).

**Storage ownership**: Both files are owned exclusively by the TUI process per Architecture Anti-Pattern 4. EE receives only per-call context over HTTP — never cap state.

Storage home resolution priority: `homeOverride` → `MUONROI_CLI_HOME` → `os.homedir()/.muonroi-cli`.

### Task 2: EE HTTP Client + Hooks Dispatcher Rewrite (EE-01)

**EE Client** (`src/ee/client.ts`):
```typescript
export function createEEClient(opts?: CreateEEClientOpts): EEClient
export interface CreateEEClientOpts {
  baseUrl?: string;       // default: "http://localhost:8082"
  authToken?: string;     // Optional Bearer token (Phase 1 EE-07 wires this)
  timeoutMs?: number;     // Intercept timeout, default 100ms (B-4)
  fetchImpl?: typeof fetch; // Injectable for tests
}
```

**Graceful degradation** (T-00.06-03):
- `intercept()`: 5xx / network error / timeout → `{ decision: "allow", reason: "ee-unreachable" }` + rate-limited `console.warn` (1/minute max).
- `posttool()`: fires-and-forgets, errors swallowed silently. Synchronous return (non-async function per B-4).
- `health()`: never throws, returns `{ ok: false, status: 0 }` on error.

**Intercept timeout budget**: 100ms for Phase 0. Phase 1 EE-08 will tighten to 25ms p95 with CI guard. Health check uses a separate 1s budget.

**Shell-spawn elimination** (T-00.06-06): `src/hooks/executor.ts` deleted. No `child_process.spawn` remains in `src/hooks/`. The Windows-incompatible `spawn("sh", ["-c", ...])` path is fully removed.

**Hooks dispatcher** (`src/hooks/index.ts`): Rewritten to route:
- `PreToolUse` → `intercept({ toolName, toolInput, cwd })` → maps `decision:block` to `blocked:true` in `AggregatedHookResult`
- `PostToolUse` / `PostToolUseFailure` → `posttool({ toolName, toolInput, outcome, cwd })` fire-and-forget
- All other events → `emptyResult()` (allow by default; Phase 1 extends this)

Public function signatures preserved: `executeEventHooks`, `executePreToolHooks`, `executePostToolHooks`, `executePostToolFailureHooks`.

## Storage Path Layout

```
~/.muonroi-cli/
  config.json    # { cap: { monthly_usd: 15 }, ee: { baseUrl: "http://localhost:8082" } }
  usage.json     # { current_month_utc: "YYYY-MM", current_usd: 0, reservations: [] }
```

## Test Coverage

| File | Tests | What is Proven |
|------|-------|----------------|
| `src/storage/atomic-io.test.ts` | 4 | write success, circular rollback, absent read, corrupt read |
| `src/storage/config.test.ts` | 2 | bootstrap default, user-provided value |
| `src/storage/usage-cap.test.ts` | 3 | bootstrap, round-trip save, month rollover |
| `src/ee/client.test.ts` | 10 | health 200/5xx, intercept allow/block/5xx/timeout, posttool fire-and-forget/swallow, auth header, no BYOK key leak |
| **Total** | **19** | — |

Full suite: 184 tests pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] usage-cap.ts named differently from plan**
- **Found during:** Task 1 implementation
- **Issue:** Plan specified `usage.ts` but `src/storage/usage.ts` already exists (SQLite-backed `recordUsageEvent` / `listSessionUsage`). Naming clash would break the barrel export.
- **Fix:** Named the new file `usage-cap.ts` and tests `usage-cap.test.ts`. Export names (`loadUsage`, `saveUsage`, `UsageState`) are identical to the plan.
- **Files modified:** `src/storage/usage-cap.ts`, `src/storage/usage-cap.test.ts`, `src/storage/index.ts`
- **Commit:** 8347583

## Open Follow-ups for Phase 1

| Item | Plan | Description |
|------|------|-------------|
| EE auth token bootstrap | EE-07 | Load `authToken` from `~/.muonroi-cli/config.json` and inject into `createEEClient` at boot |
| tenantId parameter | EE-04 | Populate `tenantId` in `InterceptRequest` and `PostToolPayload` |
| Warning UI rendering | EE-02 | Render `suggestions[]` from intercept response in the TUI status bar |
| Intercept timeout tightening | EE-08 | Reduce from 100ms to 25ms p95 with CI guard |
| Usage enforcement | USAGE-02..05, USAGE-07 | 50%/80%/100% thresholds, auto-downgrade chain, runaway scenario tests |
| pending_calls log | 00-07 | Atomic-rename IO available for plan 00.07's pending_calls durability |

## Phase 0 Success Criterion 5

"PreToolUse / PostToolUse hooks reach localhost:8082 over HTTP (not via spawn('sh', …)), proving the EE client replaces grok-cli's shell-spawn executor."

**Status: DELIVERED.** `src/hooks/executor.ts` deleted; `src/hooks/index.ts` routes through `src/ee/client.ts`; `localhost:8082` is the default base URL hard-wired in `client.ts`.

## Self-Check: PASSED

- [x] `src/ee/client.ts` exists and exports `createEEClient`
- [x] `src/storage/atomic-io.ts` exists and exports `atomicWriteJSON`, `atomicReadJSON`
- [x] `src/storage/config.ts` exists and exports `loadConfig`, `MuonroiConfig`
- [x] `src/storage/usage-cap.ts` exists and exports `loadUsage`, `saveUsage`, `UsageState`
- [x] `src/hooks/executor.ts` does NOT exist
- [x] `src/hooks/index.ts` imports from `../ee/index.js`
- [x] 19 new tests pass; 184 total tests pass
- [x] Commits: `test(storage):` → `feat(storage):` → `test(ee):` → `feat(ee):`
