# PIL Unified Brain Endpoint — Phase G Rollout Runbook

> Operational runbook for rolling out the unified `/api/pil-context` path after Phase A–F code merge.
> All actions in this doc are env-var flips, scripted queries, and surgical deletions. No new feature code.

**Parent spec:** `docs/superpowers/specs/2026-05-13-pil-unified-brain-endpoint-design.md`
**Parent plan:** `docs/superpowers/plans/2026-05-13-pil-unified-brain-endpoint.md`

---

## Goal

Move `MUONROI_PIL_UNIFIED` from default-off to default-on, then remove legacy multi-call brain paths from L1/L3/L5/L6. Keep local-classifier fallback (regex + keyword scan) permanently as a brain-unreachable safety net.

## Success criteria (gate before each transition)

| Gate | Metric | Target | Window |
|---|---|---|---|
| Phase 4 → 5 | `unified_status = ok` | ≥ 95% | 7 consecutive days |
| Phase 4 → 5 | Pipeline timeout rate | < 5% | 7 consecutive days |
| Phase 4 → 5 | p95 latency | < 2500 ms | 7 consecutive days |
| Phase 5 → 6 | classification match (dual-run) | ≥ 90% | rolling 24h |
| Phase 6 → 7 | `unified_status = ok` | ≥ 95% | 14 consecutive days |
| Phase 6 → 7 | Circuit-open events | 0 | 14 consecutive days under healthy brain |

If any gate misses, **pause** the phase. Investigate via `monitor-pil.ts` output. Do not roll forward on assumption.

---

## Phase 4 — Dual-run dogfood (7 days)

### Action

Enable the flag in your shell so personal CLI use exercises the unified path. Legacy users (no env var) continue on the old multi-call path — this is the dogfood comparison group.

**PowerShell:**
```powershell
[Environment]::SetEnvironmentVariable("MUONROI_PIL_UNIFIED", "1", "User")
```

**Bash/zsh** (add to `~/.bashrc` / `~/.zshrc`):
```bash
export MUONROI_PIL_UNIFIED=1
```

Restart shells. Verify in a new session:
```
echo $env:MUONROI_PIL_UNIFIED    # PowerShell → "1"
echo $MUONROI_PIL_UNIFIED        # bash → "1"
```

### Daily monitoring

Run `scripts/monitor-pil.ts` (added in this rollout — see below). It reads the last 24h from `~/.muonroi-cli/muonroi.db` and prints:
- `unified_status` distribution (ok / fail / skip)
- Latency p50 / p95 / p99
- Pipeline timeout rate
- Cache hit rate
- Top fallback reasons
- Circuit-open event count

Sample command:
```
bun scripts/monitor-pil.ts --hours 24
```

### Decision

- After 7 full days of `unified_status=ok ≥ 95%`, proceed to Phase 5.
- If `ok` drops below 90% for any single day, investigate before continuing. Look at `retrieval_skipped_reason`, brain health (`scripts/ee-health-probe.ts`), and `inference_ms` distribution.

### Rollback

`Remove-Item Env:\MUONROI_PIL_UNIFIED` (PowerShell) or `unset MUONROI_PIL_UNIFIED`. No code change; falls back to legacy path immediately.

---

## Phase 5 — Flip default ON

### Action

In `src/pil/config.ts`, change:

```typescript
export function isUnifiedPilEnabled(): boolean {
  if (process.env.MUONROI_PIL_UNIFIED === "0") return false;
  if (process.env.MUONROI_PIL_UNIFIED === "1") return true;
  return false;   // ← change to: return true;
}
```

Commit:
```
feat(pil): flip muonroi_pil_unified default to on after phase 4 dogfood
```

Release per normal cadence. Existing users with `MUONROI_PIL_UNIFIED=0` set explicitly still opt out — this is the documented rollback path for Phase 6.

### Verify post-release

Same monitor script, but watch the broader user pool (not just personal sessions). Look for:
- Cache hit rate going UP (more users → more shared prompt prefixes)
- Latency p95 staying flat or improving
- Any spike in `fail` status that's not present in Phase 4

---

## Phase 6 — Observation (14 days)

### Action

No code change. Run `monitor-pil.ts` daily. Track the 14-day rolling metrics. **Do not start Phase 7 until 14 consecutive days hit the gate.**

### What to watch for

- **Cache poisoning:** if a brain bug returns wrong `taskType` once, it sticks for 5 min × 200 entries. Monitor `cache_hit=true` responses against actual ground truth (if you have labeled data).
- **Circuit thrash:** if circuit opens & closes repeatedly, the threshold (5 failures / 30s) may be tuned wrong for production brain noise. Adjust constants in `src/ee/bridge.ts` only after Phase 6 metric is healthy — don't tweak mid-rollout.
- **Silent fallback:** `unified_status=skip` is fine (chitchat short-circuit), but `fail` should trend toward 0. If `fail > 5%` persistently, brain endpoint has a real problem.

### Schema version drift watch

If brain server is updated independently (e.g., adds `whoami_directives` to response), CLI logs a warning via `.passthrough()` schema. Document any schema_version bump in `experience-engine/CHANGELOG.md` before deploying to ensure CLI can handle it gracefully.

---

## Phase 7 — Legacy brain-call removal

### Action

After 14 days of green metrics, remove the legacy multi-call code paths. **Keep local-classifier fallback intact** — it's the permanent safety net for brain-unreachable scenarios.

Files to edit:

1. **`src/pil/layer1-intent.ts`** — remove the `Pass 3 LEGACY FALLBACK` block (the `if (!isUnifiedPilEnabled() || unifiedFailed)` body). Keep Pass 1 (local classify), Pass 2 (keyword), Pass 2.5 (chitchat short-circuit), Pass 3 (unified call). When unified fails, set `_brainData = null` and let downstream layers degrade gracefully (no taskType from brain → use local classifier output).
2. **`src/pil/layer3-ee-injection.ts`** — remove `queryEeBridge` and the entire legacy `searchByText` body. Keep only the formatter-mode branch from Task 11. If `ctx._brainData` is null, L3 emits `no-experience` and skips silently.
3. **`src/pil/layer5-context.ts`** — remove `fetchPrinciples` function and its call site. Principles always come from `ctx._brainData` going forward.
4. **`src/pil/layer6-output.ts`** — remove the inner `classifyViaBrain` rescue block. Style always comes from `ctx._brainData` or local heuristic.
5. **`src/ee/bridge.ts`** — `classifyViaBrain`, `routeTask`, `searchByText` may still be exported for other consumers (probe scripts). Verify with `git grep -l "classifyViaBrain\|routeTask\|searchByText" src/`. If only probe scripts use them, leave them. If nothing uses them, mark deprecated with a JSDoc note for one release, then delete.

Also flip the config default back to "no env-var needed":

```typescript
export function isUnifiedPilEnabled(): boolean {
  return process.env.MUONROI_PIL_UNIFIED !== "0";
}
```

Now `MUONROI_PIL_UNIFIED=0` is the only way to opt out (debug only); default is unified always.

### Tests

Drop or update tests that exercised the legacy fallback paths. Keep:
- `dual-run.test.ts` — verify match rate stays ≥ 90% even after legacy removal (now compares unified against local-classifier-only fallback)
- All formatter-mode tests in L3/L5/L6
- All `_brainData` schema tests

### Commit

One commit per layer file (clean diffs), final commit flipping the config default:
```
refactor(pil): remove legacy classifyviabrain rescue from l1
refactor(pil): remove legacy searchbytext path from l3
refactor(pil): remove duplicate principles fetch from l5
refactor(pil): remove brain style-rescue from l6
feat(pil): muonroi_pil_unified default-on (opt-out only)
```

---

## Rollback procedure (any phase)

If a phase fails its gate and the cause isn't immediately fixable:

| Phase | Rollback |
|---|---|
| 4 | Unset env var on dogfood sessions. No release impact. |
| 5 | Revert the config commit. Release patch. Users with `MUONROI_PIL_UNIFIED=1` set explicitly still opt in. |
| 6 | Same as Phase 5 — revert the default flip. |
| 7 | Hard revert the legacy-removal commits. This is the riskiest rollback because tests will also have changed. Keep a `legacy-fallback-backup` branch from before Phase 7 commits as escape hatch. |

---

## Monitor script (deliverable)

Implement `scripts/monitor-pil.ts` that reads `~/.muonroi-cli/muonroi.db` and outputs the daily snapshot described above. Schema fields it needs from `interaction_logs.metadata_json`:

- `event_type = "pil_layer"` rows for each layer's `delta` string
- `event_type = "pipeline"` summary row per turn with `pipelineMs`, `taskType`, `outputStyle`, `unifiedStatus` (parse from L1's `unified=ok|fail|skip` token in delta), `cacheHit` (parse from L1 delta where exposed via brain response)

If those fields aren't yet logged, the script will warn — extend `src/storage/interaction-log.ts` to capture them before relying on the monitor.

---

## Notes

- This runbook assumes Phase A–F merged and `master` (muonroi-cli) + `develop` (experience-engine) are at the post-plan state.
- Brain endpoint `/api/pil-context` must be deployed and healthy at `cp.truyentm.xyz` (or wherever production brain runs) before Phase 4. Verify with `scripts/ee-health-probe.ts` extended to ping `/api/pil-context` with a test prompt.
- WhoAmI v4.0 integration is **out of scope** for Phase G. When the WhoAmI profile is ready, it lands as a new `user_profile` field in the schema (already reserved via `.passthrough()`) — no Phase G changes needed.
