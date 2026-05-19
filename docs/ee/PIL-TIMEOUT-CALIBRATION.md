# PIL Timeout Calibration — Methodology Stub

> Status: **STUB** — Phase 21 / Plan 02 / T5. Replace placeholder numbers with
> measured values when a real calibration run is executed against a target
> SiliconFlow thin-client deployment.

## Why this exists

`src/pil/layer3-ee-injection.ts` and `src/ee/bb-retrieval.ts` cap each
Experience-Engine round-trip with an `AbortSignal.timeout`. The original
budgets (PIL 60ms → bumped to 1500ms; BB 800ms) were heuristics from local
Ollama traces. On VPS thin-client setups where embedding flows through
SiliconFlow, p95 latency drifts. Calibrating the cap against real p50/p95
data prevents both:

- **False positives** — the budget is too tight, BB context never lands,
  council prompts run without retrieved guidance.
- **False negatives** — the budget is too loose, slow EE round-trips visibly
  delay every `/ideal` invocation without producing a usable signal.

## Methodology

Run a representative prompt 20 times against a target EE deployment, with
the logger from Plan 21-01 active so each call site emits a structured warn
line:

```bash
DEBUG_EE=1 MUONROI_BB_RETRIEVAL_TIMEOUT_MS=5000 \
  for i in $(seq 1 20); do
    bun run src/index.ts -p "scaffold a fraud detection rule" --smoke-boot-only
  done 2>&1 | tee /tmp/bb-latency.log
```

Then extract `latency=` values from the `[ee.bb]` lines and compute p50/p95
with `awk` or any quantile tool.

The same pattern applies to `MUONROI_PIL_SEARCH_TIMEOUT_MS` using a prompt
that exercises Layer 3 injection (e.g. an architectural question).

## Recommended thresholds (placeholders — pending real measurement)

| Knob | Default | Suggested floor | Suggested ceiling | Notes |
|---|---|---|---|---|
| `MUONROI_BB_RETRIEVAL_TIMEOUT_MS` | 800 | ~p50 + 50ms | ~p95 + 100ms | Three parallel `/api/search` calls + retry-once |
| `MUONROI_PIL_SEARCH_TIMEOUT_MS` | 1500 | ~p50 + 100ms | ~p95 + 200ms | Two parallel `/api/search` calls (principles + behavioral) |

Until a real run is recorded, treat the defaults as the conservative ceiling
and only tighten when you have evidence the actual p95 is lower.

## Applying overrides

Both knobs are clamped:

- `MUONROI_BB_RETRIEVAL_TIMEOUT_MS` ∈ `[300, 3000]`
- `MUONROI_PIL_SEARCH_TIMEOUT_MS` ∈ `[500, 5000]`

Set as a process env var before launching the CLI. Out-of-range values fall
back to the default silently. The shared helper `readTimeoutEnv` in
`src/utils/ee-logger.ts` performs the validation in one place.

## Operator runbook

If `[ee.bb-retrieval.fetchBBContext.timeout]` warn lines appear in steady
state (more than 10% of prompts), either:

1. Tighten the budget so the toast `running without BB context` surfaces
   sooner and the operator notices.
2. Disable BB retrieval via `/ee-context off` until the EE is healthy.
3. Investigate the EE — typically a SiliconFlow rate-limit or a Qdrant
   cold-load issue.

A follow-up phase will record measured values from a production VPS run and
replace this stub with concrete thresholds.
