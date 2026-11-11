# Baseline: "build TCIS.MCP.Docs MCP server" (tcis-libraries)

The measured starting point for orchestrator-efficiency work. Every later fix
(root-goal pin, dispatch guards, delegation ledger, run_gate, plan-review loop
cap, ...) is judged by re-running the same request and comparing against the
numbers below with the same command.

- Sessions: `8a5bd89c2be0` (2026-11-02 03:00 to 09:26 UTC, planning only) and
  `4edc02516a92` (2026-11-02 14:48 to 2026-11-04 09:35 UTC, planning plus build).
- Workspace: `D:\sources\CompanyLibs\tcis-libraries`, HEAD `cd596d4` on master
  at the start of both sessions (worker `git log` output at 2026-11-02T03:04:20Z
  and 2026-11-02T14:56:48Z).
- Orchestrator model `step-5-preview`; most workers `step-3.7-flash`.
- First human prompt, verbatim (4edc02516a92; 8a5bd89c2be0 is the same
  sentence without the last clause):
  `tôi muốn phát triển 1 mcp docs lib dành cho AI dùng thì bạn xem resource hiện tại đủ chưa? hay cần gì? nếu đủ thì tiến hành dựng`

## Command

```bash
# The CLI opens the DB read-only. These numbers came from a snapshot made with
# SQLite's backup API (python: sqlite3.connect('file:...muonroi.db?mode=ro', uri=True).backup(dst)).
bun run src/index.ts usage flow-metrics 8a5bd89c2be0 4edc02516a92 --db <snapshot>/copy.db
bun run src/index.ts usage flow-metrics 4edc02516a92 --json --db <snapshot>/copy.db   # machine-readable
bun run src/index.ts usage flow-metrics 4edc02516a92 --impl-ext .cs --db <snapshot>/copy.db  # first C# file
```

Without `--db` the command reads `~/.muonroi-cli/muonroi.db`, also read-only.
Delegation records and the cost log come from `--home` (default `~/.muonroi-cli`).

## Baseline

| metric | 8a5bd89c2be0 | 4edc02516a92 | both |
|---|---:|---:|---:|
| human prompts (+ background wake-ups) | 9 (+36) | 37 (+121) | 46 (+157) |
| hours: request to plan verified | never | 15.74 | |
| hours: request to first implementation write | none | 35.43 (`TCIS.MCP.Docs.csproj`; first `.cs` 35.43, `DocSource.cs`) | |
| hours: request to final answer | 6.43 | 42.78 | |
| orchestrator turn hours: plan-gate / preflight / implementation | 1.87 / 0 / 0 | 10.53 / 16.53 / 3.72 | |
| delegations (worker jobs) | 41 | 143 | 184 |
| implementation | 0 | 36 (25.2%) | 36 (19.6%) |
| impl-support (after first impl write, no impl write) | 0 | 28 (19.6%) | 28 (15.2%) |
| preflight (before first impl write, no impl/plan write) | 25 (61.0%) | 48 (33.6%) | 73 (39.7%) |
| plan-edit | 7 (17.1%) | 10 (7.0%) | 17 (9.2%) |
| council | 7 (17.1%) | 1 (0.7%) | 8 (4.3%) |
| plan-review (revalidation) | 1 (2.4%) | 3 (2.1%) | 4 (2.2%) |
| review (verify role / reviewOf) | 1 (2.4%) | 17 (11.9%) | 18 (9.8%) |
| worker hours: implementation / preflight / council | 0 / 1.25 / 1.09 | 3.30 / 2.46 / 0.14 | |
| flow_plan_review calls | 18 | 19 | 37 |
| plan-review outcomes | dispatched 8, refused 6, completed 4 | refused 11, dispatched 5, unparsed 2, completed 1 | |
| recorded round verdicts | revise 4 | pass 1 | |
| council verdicts (structured `council-verdict` block) | revise 7 | revise 1 | revise 8/8 |
| bookkeeping tool calls / all orchestrator tool calls | 171 / 244 (70.1%) | 706 / 1510 (46.8%) | 877 / 1754 |
| delegation_read / delegation_ack / context_load | 92 / 41 / 7 | 301 / 147 / 78 | |
| worker jobs not completed | 2 / 41 (4.9%) | 19 / 143 (13.3%) | 21 / 184 (11.4%) |
| failure categories | output-limit 1, rate-limited 1 | missing-final-answer 6, model-message-schema 5, output-limit 3, unclassified 3, provider-http-503 1, cancelled 1 | |
| compactions (tokens before: total / max) | 19 (2.48M / 185k) | 74 (10.77M / 304k) | 93 |
| orchestrator cost (all sources) | $7.43 | $32.85 | $40.28 |
| orchestrator `message` cost / input / cache-read | $7.25 / 12.23M / 50.8% | $31.87 / 51.25M / 48.1% | $39.12 / 63.48M / 48.6% |
| worker cost / input / cache-read | $3.91 / 14.94M / 71.4% | $18.77 / 59.61M / 69.4% | $22.68 |
| total cost | $11.34 | $51.62 | $62.96 |
| call_accounting `main`: peak est / sys / hist / tool | 129k / 20.1% / 45.1% / 34.8% | 149k / 23.4% / 34.9% / 41.7% | |
| flow_verify calls | 0 | 0 | 0 |
| final answer after implementation with no recorded verify pass | n/a | YES | |

## How each number is defined

- **Request**: the first user message whose `providerOptions.muonroi.internalActivity`
  is not true. Background wake-ups ("[background jobs finished]") are counted
  separately.
- **Implementation write**: a `write_file`/`edit_file` whose recorded result is
  `success: true`, in the main chain (`tool_calls`/`tool_results`) or in a
  worker's captured tool artifacts, to a path inside the session cwd with a
  code or build-project extension (`IMPLEMENTATION_EXTENSIONS`), not under a
  planning, metadata, build-output or scratch directory (`NON_IMPLEMENTATION_DIRS`:
  `.planning`, `.muonroi-flow`, `.muonroi-cli`, `notes`, `bin`, `obj`, ...).
  Rules: `src/cli/flow-metrics-classify.ts`.
- **Plan verified**: the first `flow_plan_review` result the host marked
  `planVerified: true`.
- **Orchestrator turn hours**: the sum of `agent_response.duration_ms`. A turn
  belongs to the phase it started in: plan-gate until plan verified, preflight
  until the first implementation write, implementation after. Time spent
  waiting for a human is not a turn, so it is not counted.
- **Delegation purpose**: decided only from fields the host recorded on the job
  and from the job's recorded writes. The first rule that matches wins:
  council (`kind=council` or a council brief), then plan-review (`planReview` /
  `planRevalidation` binding), then review (`reviewOf`/`hostReview` or agent
  `verify`), then implementation (a successful implementation write), then
  plan-edit (a successful planning-artifact write), then preflight or
  impl-support depending on whether the job started before the session's first
  implementation write. Prompt and description text are never read.
- **Bookkeeping tools**: `BOOKKEEPING_TOOLS` (delegation_read/ack/list/send/
  accept/cancel, context_load, worker_models, worker_capabilities, flow_status,
  todo_write, retrieve_tool_result, compact).
- **Failure category**: cancelled and rate-limited come from the job record.
  Otherwise the host's own terminal-marker classifier (`workerFailureRecovery`)
  decides, and if it cannot, the `Task failed: HTTP <code>` marker gives
  `provider-http-<code>`. Anything left is `unclassified`.
- **Orchestrator cost**: `usage_events` of the session chain.
- **Worker cost**: workers run with `persistSession: false`, so their calls are
  recorded only in `usage/cost-log-<date>.jsonl`. Rows written by worker
  processes are now tagged `parentSessionId`/`delegationId`
  (`setCostLogAttribution`). Rows written before this change are untagged, so
  they are attributed by job window: a row is counted when it falls inside one
  of this session's job lifetimes (±5 s) and inside no other session's job. Rows
  that match a `usage_events` row (same model and input tokens, within 15 min)
  are main-process calls and are excluded. Every baseline worker row was
  attributed by window: 116 for 8a5bd89c2be0, 148 for 4edc02516a92, 0 ambiguous.

## Cross-check against the 2026-11-05 audit

| audit figure | measured | verdict |
|---|---|---|
| 184 delegations | 41 + 143 = 184 | matches |
| 113 (61%) on plan/council/scanner-preflight | 102 (55.4%) plan-edit+council+plan-review+preflight; 120 (65.2%) including review | **Different.** The audit used a regex over prompt text (it matched e.g. "do not run dotnet"), and the regex was not saved, so its 113 cannot be reproduced. The structural count is reproducible from `--json` (`delegations.jobs[]` lists every job with its purpose). |
| council 8/8 verdict=revise | council verdicts revise 7 + revise 1 | matches (parsed with `extractStructuredVerdict`, the host's own parser) |
| flow_plan_review called 37x | 18 + 19 | matches |
| 4edc: 10.5h plan-gate + 16.5h preflight vs 3.8h implementation | 10.53 / 16.53 / 3.72 | Plan-gate and preflight match. Implementation differs by 0.09h because of where the boundary sits. The audit started implementation at the first implementation dispatch (`steady-ivory-panda`, 02:07:17Z), which gives 3.806h. Measured from the first successful implementation write (02:14:11Z), it is 3.717h. Both numbers are correct for their boundary. The tool uses the write, so "time to implementation" means code on disk, not a job that might fail. |
| first .cs ~35h after the request | 35.43h (from the 4edc request) | matches. Measured from the 8a5b request (2026-11-02T03:00Z) it would be about 47h. |
| false "task done" while no C# existed | not derived by the tool | The claim was prose: assistant message seq 680 at 2026-11-04T01:16:53Z ("## Xong rồi ... Task MCP docs đã hoàn tất"), 57 min before the first implementation write at 02:14:11Z. The tool does not classify prose. What it does derive is structured: 0 `flow_verify` calls, 0 `root_status=complete` claims (that field did not exist yet), and "final answer after implementation with no recorded verify pass = YES". |
| delegation_read 301, delegation_ack 147, context_load 78 | 4edc: 301 / 147 / 78 | matches (4edc only) |
| orchestrator $39, 63.5M input, 48.6% cache read | `message` source, both sessions: $39.12, 63.48M, 48.65% | Matches, for the `message` source summed over both sessions. With compaction included, orchestrator cost is $40.28. |
| 21/143 worker jobs failed | 4edc 19/143 (18 error + 1 cancelled); 8a5b 2/41; both 21/184 | **The audit mixed scopes.** 21 is the failure count for both sessions, but 143 is the job count for 4edc alone. Evidence: job records in `~/.muonroi-cli/delegations/tcis-libraries-d475232540/*.json` with `status != complete`. |
| 74 compactions | 4edc 74; 8a5b 19 | matches for 4edc |
| (not in audit) worker cost | $22.68 ($3.91 + $18.77) | first measurement; total spend for the request was $62.96 |

## Measurement findings

1. **The cost log double-logs every compaction.** `orchestrator.ts` writes one
   `orchestrator.compaction` row from `recordUsage("compaction")` and another from
   the compaction path itself. In the cost logs for 2026-11-02..04 there are 186
   compaction rows and 93 compaction `usage_events` (19 + 74), exactly 2×. The
   tool pairs these rows (same model, input and output tokens, within 15 min) and
   reports them (`19 / 74 double-logged compaction rows collapsed`). Before this
   rule, about $0.75 of main-session compaction was counted as worker spend.
   `usage report --by callsite` still counts compaction twice; that is not fixed here.
2. **Main-session cost-log rows match usage_events one-to-one.** All 1,167 main
   `message`/`compaction` usage_events of both sessions matched a cost-log row
   with the same model and input tokens, so the cost log and the DB are the same
   meter, and the 15-minute matching rule is sound on this data.
3. **Worker spend was invisible until now.** Workers record no `usage_events`, so
   `usage forensics` never showed them. They were 36% of this request's spend
   ($22.68 of $62.96).

## Replay

`scripts/bench/replay-tcis.ts` clones the repo at `cd596d4` into a temp dir (the
real working tree is only read), sends the prompt above to the real CLI through
the agent-harness transport, stops when the run settles or a guard trips, then
prints baseline vs replay from this same command.

```bash
# free: mock model, isolated temp HOME
bun scripts/bench/replay-tcis.ts --mock-llm scripts/bench/fixtures/replay-mock
# paid: real providers, your settings (refuses to start without --live)
bun scripts/bench/replay-tcis.ts --live --budget-usd 65 --max-wall-min 2880 --out replay.json
```

Expected cost of a live run, if behaviour were unchanged: about $52 (4edc:
$32.85 orchestrator + $18.77 workers) up to about $63 (both sessions). The upper
figure applies because the clean clone does not contain the planning artifacts
8a5b left behind. `.muonroi-flow/planning/PLAN.md` was untracked: worker
`brisk-teal-fox` ran `git ls-files .muonroi-flow/` at 2026-11-02T07:15Z and it
printed nothing. Session 4edc used 30.8h of orchestrator turn time over 42.8h
of wall time, so `--max-wall-min` has to allow for a run that lasts days.

Caveats when comparing:

- The replay has no human. Askcards are answered with their default; the
  baseline had 37 human prompts.
- At 03:04Z on 2026-11-02 the source tree also had 8 modified tracked files
  that no commit captures. None of them are under `TCIS.MCP.Docs`.
- The model is whatever your settings choose unless you pass `--model`.
