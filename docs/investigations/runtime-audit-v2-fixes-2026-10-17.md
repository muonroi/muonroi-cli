# Runtime audit v2: bounded fixes and EE retry

Date: 2026-10-17. Workspace: `D:/sources/Core/muonroi-cli`. Base HEAD: `2d33b8d9a557a8fec30ea4713d98b8469f8f5603`, with extensive existing uncommitted work. This report describes the rebuilt working tree, not an upstream release or a clean-commit deployment. Hashes of relevant executed modules are in the adjacent evidence manifest.

## Result

Implemented history-query preflight, validated compaction-proposal parsing, explicit main routing modes, cache safety checks, and clearer EE/LSP contracts. Reproduced and fixed two cache defects during verification. The configured EE endpoint currently responds to both health and strict recall; the reported health/localhost contradiction did not reproduce against the same server.

## Evidence and changes

| Surface | Evidence | Change and practical limit |
| --- | --- | --- |
| History search | Session `81e606ae4fda` audit v2 reports FTS `*` returning `unknown special query: *`; native RED test confirms SQL was reached before the preflight. | `src/tools/registry.ts:1534` rejects bare wildcard before database access, explains `term*` and `query_mode=literal`, and never turns invalid input into a broad search. Other FTS expressions retain the existing SQLite error path. |
| Compaction proposer | Current debug history contains separate empty outputs and a truncated JSON object. These are not evidence of a format-retry loop within one call. RED tests reproduce greedy-envelope extraction and invalid-index acceptance. | `compaction-proposal.ts` selects exactly one complete, valid proposal; validates action type, unique/in-range integer indices and reasons; rejects truncated/ambiguous results. `compaction.ts:164` retains the existing heuristic fallback and writes finish/length/fallback diagnostics to file. No new paid format retry. Prompt requests an empty action list for a no-compaction decision. This does not establish why the provider emitted empty output. |
| Main model routing | Historical routing records `59871` and `60024` say `project-model-pin`; existing local tier routing still runs for unpinned calls. RED tests demonstrate that mode alone previously had no effect. | Optional `routingMode` supports Fixed, Auto and Suggest. Project pins remain Fixed by default, including when user-global policy is Auto. Explicit project mode can use the project model as its baseline. `retainModel` remains authoritative. Auxiliary/council calls do not inherit the main policy implicitly. |
| Cached routing authorization | RED tests for both Auto and Suggest return a cached non-HALT model after `midstreamPolicy.forceRefuseNext()`. A further RED test returns a cached fast model after changing the demotion floor to `off`. | Cache hits re-run budget safety. Keys include mode, promotion/demotion bounds and multi-provider preference; cached decisions from disabled providers are not reused. Suggest checks budget against its served baseline, and records the candidate separately. Existing budget downgrade/HALT behavior remains. |
| Routing UI | Actual offline TUI input `/route mode suggest` changes its semantic status to `routing=suggest`; unit tests render each mode label. | `/route status` reports effective policy/source/baseline/bounds without routing or writing. `/route mode fixed\|auto\|suggest` persists only to the addressed project cwd; mode is visible in the status bar. `/route <prompt>` uses the same project policy as main. Existing budget/vision constraints remain independent. |
| LSP preview | Tool is explicitly a stub; prior native control returns no edits and preserves the fixture. | Description directs concrete textual previews to `edit_file(dry_run=true)` when exposed. No LSP mutation implementation or apply path is claimed. |
| EE health | Rebuilt native trace below shows health and strict recall both succeed at the configured remote origin, while localhost refuses. | `healthEE()` reports `check=reachability`, the sanitized endpoint and `recallReady=not_checked`. Invalid endpoint configuration returns unavailable. This does not replace recall/scope verification or weaken fail-closed strict scope. |

## EE retry on rebuilt native tools

Trace window: **2026-10-17T02:35:18.274Z to 02:35:27.311Z**. Authentication was resolved by the CLI's configured resolver. No token, authorization header, or raw recalled lesson is included in the saved trace.

| Operation | Endpoint relationship | Result | HTTP elapsed |
| --- | --- | --- | ---: |
| Native `ee_health` | Configured remote origin, `/health` | HTTP 200; reachability only; `recallReady=not_checked` | 89 ms |
| Native `ee_query` | Same configured origin, `/api/recall` | HTTP 200; 2 entries; matching `strict=true`, `project=muonroi-cli`, `policy=project-only`, cwd proof | 8,176 ms |
| Official helper localhost comparison | Different origin, `localhost:8082/health` | Connection refused/unreachable | 6 ms |

The native tool wall times were 91 ms and 8,182 ms respectively. This snapshot does not show the remote brain down or health falsely claiming recall readiness. Recall latency is measured; no server-side attribution is established. A localhost process listing cannot establish the state of a configured remote server.

Earlier retry evidence was preserved separately: a Bun run succeeded; the first Node probe received successful responses then hit a Windows libuv assertion during process teardown. That Node run is not an accepted clean-process check. The current rebuilt retry uses Bun and exits 0.

The offline queue buffers writes (feedback/extraction/stale-prompt notifications), not failed recall reads. An empty queue during a read failure is not by itself a queue defect. `rehydratedEe=0` identifies a rehydration counter, not proof that all compaction used only cache/disk. Historical `pending_calls` counts do not establish executed recall count, success, or session attribution.

## Verification

| Check | Current result | Evidence |
| --- | --- | --- |
| Focused regressions | **174 passed, 0 failed, 16 files**, 26.33 s | `.scratch/runtime-audit-v2-fixes/accepted-tests.log` |
| Build, including TypeScript and packaged harness core | **Exit 0** | `.scratch/runtime-audit-v2-fixes/build.log` |
| Rebuilt native/local-MCP controls | **16/16 checks**, exit 0 | `compiled-controls.json`; covers actual FTS tool, proposer parser, policy/pin, slash status/config, Auto/Suggest and cached cap refusal |
| Actual TUI mode command | **1/1**, offline mock model; semantic status verified | `tuiRuns` and `tuiResults` in compiled controls |
| Native selfverify via freshly started local tools-MCP | **2/2**, 0 failed/inconclusive | Run `5880c6c0-9775-477a-9a85-fdc6d3cf1484`; boot + passive status, scoped to the changed status/route files |
| Configured live EE native health/recall | Both HTTP 200, strict project proof accepted | `.scratch/runtime-audit-v2-fixes/ee-retry.json` |

The focused command lists all 16 test files in `reproduce.ps1`. The tests cover caller policy ownership, `retainModel`, mode cache isolation, cap preservation, changed demotion bound, project cwd writes, FTS/literal contracts, parser escapes/invalid actions, proposer timeout/cancellation and strict recall failure cases. The test harness emits an existing `vi.mock(bun:sqlite)` hoisting warning; the accepted command exits 0.

Initial control failures remain saved: one script omitted catalog initialization; a second TUI fixture lacked a placeholder key for its dynamically chosen provider and opened the model picker. The corrected fixture initializes the bundled catalog and supplies a fake key only inside its isolated mock process. No product guard was disabled to make these controls pass. The final build was followed by another complete compiled-control run.

## Boundaries

- Supplied `D:/sources/Core/extension/ai-dock/runtime-audit-report-v2.md` was read. Its separately named `runtime-audit-evidence-v2.json` was absent at that path; it was not silently substituted or marked verified.
- V2 prepared-request values (52,533 estimated input tokens, 42,147 schema characters, 70 tools, 24,302 system characters) are a supplied request-layer snapshot. They are not HTTP capture, billing, independently additive prompt components, or proof that council was expensive.
- Old StepFun cooldown/429 log counts do not establish current-session throttling. No new StepFun 429 reproduction or paid model comparison was performed here.
- The actual main turn and child execution were covered by bounded source-level integration tests; the TUI control uses a mock model. No live provider quality/cost improvement percentage is claimed for Auto/Suggest.
- No full unit-suite run, Git push, package publication, catalog API deployment or EE server redeployment was performed for this follow-up. Existing dirty work, DBs, exports, settings, active sessions and registered cached MCP processes were preserved. The verified MCP is a newly started workspace build, not proof that a pre-existing `_npx` process refreshed.

## Use the rebuilt CLI

Start `node D:/sources/Core/muonroi-cli/dist/src/index.js` and inspect `/route status`. Select `/route mode fixed`, `/route mode auto`, or `/route mode suggest` explicitly for that project. Current user/project settings were not migrated by this task.

Routing policy is per turn. Auto reuses the local router and existing tier ceilings/floors; Suggest reports a candidate while serving the baseline. It does not automatically accept a suggestion, bypass budgets, or change helper/council ownership. Full request payload, cache and provider timing telemetry is still required for cost/performance comparisons.
