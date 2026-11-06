# Cost forensics & the metered gate

> Moved out of `CLAUDE.md` (2026-11-06). Design doc: `docs/cost/BUOC2-metered-gate-design.md`.

## Cost-leak forensics & acceptance checks

When investigating "why did this prompt cost so much" or verifying the
Phase A/B/C cost-optimization caps still hold:

```bash
# Per-event breakdown of a recent session by ID prefix.
bun run src/index.ts usage forensics <id-prefix>          # human-readable
bun run src/index.ts usage forensics <id-prefix> --json   # machine-parseable
```

Inline anomaly flags (each tied to a plan phase target):

| Anomaly | Meaning |
|---|---|
| `peak single-call input > 80,000` | Sub-agent cumulative cap did NOT engage (Phase B target breach). Check `getSubAgentBudgetChars()` + the `wrapToolSetWithCap` wiring around `childBaseTools` in `runTaskRequest` / `runTaskRequestBatch`. |
| `NULL message_seq on 'message' source` | Phase A5 message write-ahead bypassed. Verify `persistMessageWriteAhead` is called BEFORE streamText in `processMessage` (sees `messageSeqs.push(seq)` not `push(null)`). |
| `zero cache_creation_tokens across deepseek input tokens` | Scoped to deepseek events only; expected behaviour (DeepSeek never emits cache_creation — it has cache reads only via `prompt_cache_hit_tokens`). The C1 fix made the metric flow correctly; the warning is conservative and may fire on legitimate deepseek-dominant sessions — only treat as a regression if `cacheReadTokens` is ALSO 0 across the same events. |

Known baselines:
- **Pre-fix worst case**: session `b58603caceb9` (peak 504,737 input on a
  single prompt — all anomalies firing).
- **Post-fix DeepSeek**: session `5f349ef73ccb` (peak 31,702 input on the
  same "explore oauth" prompt — 16x reduction, 41.6% cache hit).
- **Post-fix OAuth gpt-5.4**: session `63974a79c0cd` (peak 31,827 input,
  97% cache hit on shorter prompts).

After A1-A5 + B1-B4 + C1-C3 + F1 + G1-G2 + M1 + O1 ship, peak should
stay ≤ 80K input tokens on any single call.

## The metered gate — per-call cost attribution (Bước 2)

> This is the primary tool for **"where is the cost actually going?"**. Read it
> before proposing any cost-reduction change — a cut that doesn't move a measured
> segment is "fix ngọn" (treating a symptom). Design: `docs/cost/BUOC2-metered-gate-design.md`.
> Module: `src/providers/model-gate.ts` (wraps every model at `resolveModelRuntime`).

### The problem it solves

Cost leak was "fixed" 10+ times and kept returning. Root is **dual**: (A) no
single choke-point bounding per-call input — ~15 point-caps compose leakily and
fail silently; (B) cost was **not falsifiable** — the `usage_events.message` blob
was un-attributable, so no fix could be proven to work. The gate closes both: it
is the ONE point every AI-SDK call's final `options.prompt` passes through, and it
records a per-call **composition** so cost is attributable per stage + per segment.

### What it records (always-on, every call)

One `call_accounting` row per `doStream`/`doGenerate`, in `interaction_logs`
(`~/.muonroi-cli/muonroi.db`). `event_subtype` = the pipeline stage; `input_tokens`
= the est; `metadata_json` carries the breakdown:

| field | meaning |
|---|---|
| `stage` | `main` \| `subagent` \| `council` \| `compaction` \| `pil` \| `title` \| `vision` \| `unattributed` |
| `estInputTokens` / `chars` | `chars/4` estimate + raw chars. **Calibration: est UNDER-counts real provider tokens ~2×** (muonroi's system prompts are token-dense ≈1.8 chars/tok). So real ≈ `2 × est`. |
| `bySegment.{system,history,toolResults}` | char counts per segment — **the attribution that was invisible before** |
| `fileParts` / `fileBytes` | image/base64 parts (billed per-image, NOT chars/4) |
| `ceiling` / `ceilingHit` | soft warn line (catalog `contextWindow` × ratio) and whether est exceeded it |
| `throwCeiling` / `throwHit` | hard throw line (absolute est cap) for throw-eligible stages |
| `ceilingMode` | `off` \| `warn` \| `throw` in effect for that stage |

### How to measure (no friendly CLI yet — use SQL on the DB)

There is **no `usage segments` command yet** (a known gap); query the DB directly.
DB is `~/.muonroi-cli/muonroi.db`. For a clean run, clear it first (back it up) so
old data doesn't dilute the distribution.

```bash
DB=~/.muonroi-cli/muonroi.db

# 1) Per-stage cost + segment split (the headline view).
sqlite3 -header -column "$DB" "
SELECT event_subtype stage, COUNT(*) calls, SUM(input_tokens) est_tok, MAX(input_tokens) peak,
  ROUND(100.0*SUM(json_extract(metadata_json,'\$.bySegment.system'))/SUM(json_extract(metadata_json,'\$.chars')),1)      sys_pct,
  ROUND(100.0*SUM(json_extract(metadata_json,'\$.bySegment.history'))/SUM(json_extract(metadata_json,'\$.chars')),1)     hist_pct,
  ROUND(100.0*SUM(json_extract(metadata_json,'\$.bySegment.toolResults'))/SUM(json_extract(metadata_json,'\$.chars')),1) tool_pct
FROM interaction_logs WHERE event_type='call_accounting'
GROUP BY event_subtype ORDER BY est_tok DESC;"

# 2) Ceiling / throw hits (runaway detector).
sqlite3 -header -column "$DB" "
SELECT event_subtype stage, COUNT(*) calls,
  SUM(json_extract(metadata_json,'\$.ceilingHit')) warn_hits,
  SUM(CASE WHEN json_extract(metadata_json,'\$.throwHit')=1 THEN 1 ELSE 0 END) throw_hits,
  MAX(input_tokens) peak_est
FROM interaction_logs WHERE event_type='call_accounting' GROUP BY event_subtype;"

# 3) The single biggest call's composition (what drove the peak).
sqlite3 "$DB" "SELECT metadata_json FROM interaction_logs
  WHERE event_type='call_accounting' ORDER BY input_tokens DESC LIMIT 1;" | python3 -m json.tool
```

**Always filter by the CURRENT `session_id`** (or a tight `created_at` window) —
rows from a prior process linger and a naive query mixes runs/modes.

### Measurement criteria (what "good" vs "leak" looks like)

- **Stage-inverted profile is normal, and tells you the lever** (measured live):
  a `main`/chat call is **~90% system prompt** (tool≈0%); a `council` call is
  **~75–89% tool_results** (system≈10%). If a stage's dominant segment matches
  this, the lever for THAT stage is that segment — nothing else.
- **`peak_est` per single call should stay well under the context window.** Real
  ≈ 2× est, so an `est` peak > ~40k on a small-window model already means ~80k+
  real (the Phase-B target line). A runaway shows `throwHit=1`.
- **`throw_hits > 0` on `subagent`/`vision`** = a call ESCAPED the cumulative cap
  (a real regression/new bypass — the cap should have bounded it to ≤60k est).
  Investigate the cap wiring, not the gate.
- **A cost "fix" is only real if a re-run shifts the measured segment %.** Cut,
  re-query view (1), prove the target segment's `est_tok`/`%` dropped for that
  stage. If the number doesn't move, you fixed the wrong thing.

### Fix directions (where the levers actually are)

| Dominant segment (from view 1) | Lever | Where |
|---|---|---|
| `system` (main/chat, ~90%) | trim/deduplicate the system prompt + front-loaded steering | `buildSystemPrompt` + the cheap-model playbook/workbook injections |
| `toolResults` (council/ideal, ~75–89%) | compress/dedup tool payloads; the segment C3-re-serve (H5) + `cap-tool-result` + `read-path-budget` target | `cross-turn-dedup.ts`, `sub-agent-cap.ts`, `read-path-budget` |
| `history` growth across steps | compaction / rotation cadence | `compaction.ts`, reactive sub-session |
| a `throwHit` runaway | the cumulative cap let a call escape | `wrapToolSetWithCap` + `getSubAgentBudgetChars()` |

### Env knobs (all default to safe values)

| Env | Default | Effect |
|---|---|---|
| `MUONROI_GATE` | on | `=0` disables the wrap entirely (no meter, no ceiling) |
| `MUONROI_GATE_CEILING` | `warn` (per-stage: `subagent`/`vision` = `throw`) | `off`\|`warn`\|`throw`, global override for all stages |
| `MUONROI_GATE_CEILING_RATIO` | `1.0` | soft warn ceiling = `contextWindow × ratio` (0<r≤1) |
| `MUONROI_GATE_THROW_MAX_TOKENS` | `100000` est (~200k real) | absolute hard throw cap for eligible stages |
| `MUONROI_INTERACTION_LOG_RETENTION_DAYS` | `14` | raise it before a long calibration window |

### Ready-to-use agent prompt (measure the meter)

> Measure where token cost goes in muonroi-cli using the metered gate. Query
> `~/.muonroi-cli/muonroi.db`, table `interaction_logs WHERE event_type='call_accounting'`
> (see the three SQL views in docs/cost/METERED-GATE.md → "How to measure"). Report, per stage
> (`event_subtype`): call count, summed `input_tokens` (est), peak, and the
> `bySegment` system/history/tool_results split as %. Flag any `throwHit=1` or a
> `peak_est` implying > ~80k real tokens (real ≈ 2× est). Then name the single
> dominant (stage, segment) pair driving cost and the corresponding lever from the
> fix-directions table. Do NOT propose a cut whose target segment you haven't shown
> is dominant. Filter to the current session_id so prior runs don't dilute the data.
