# Council caller output and executed-tool evidence

## Measured problem

The real gentle-teal-falcon result requested one compact JSON object but returned 9432 characters: a default outcome JSON, a READABLE Markdown section and another caller JSON. Its input already contained the cited digest, and the job had no saved host tool artifacts. That historical result does not prove an independent reread.

Fresh local reproducers executed the synthesis and stream code: output-before.log recorded 5 failed/1 passed; evidence-before.log recorded 3 failed/1 passed. The former reproduced competing prompt formats and unnecessary retries for valid custom JSON/FLOW verdicts. The latter reproduced the missing awaited result sink, including loss of completed evidence when the provider subsequently failed.

## Repairs

- `src/council/prompts.ts`: a nonblank caller contract replaces the standard dual-output contract. Language rules no longer introduce mandatory Part 1/Part 2 fields for custom outputs. The synthesis distinguishes brief-supplied digests, actual tool checks and ACK/correctness.
- `src/council/planner.ts`: custom results need not implement the interactive summary/type/menu schema. First attempt and one bounded empty/truncated retry retain the caller format. Plain-text caller output is not forced into JSON. Ordinary interactive synthesis keeps its format and recovery.
- `src/council/index.ts`: decision-quality diagnostics do not mutate caller-owned output. Exhausted custom synthesis recovery emits an error and returns no successful advice.
- `src/council/llm.ts` and `types.ts`: the actual SDK stream matches tool results/errors to observed call IDs and awaits a host sink immediately. It forwards selected model and research/debate phase. Model prose, an unexecuted tool call or an unmatched result cannot create evidence. Completed results survive a subsequent stream error.
- `src/orchestrator/orchestrator.ts`, `delegations.ts`, `src/index.ts`: detached council forwards the sink into its LLM and stores results in the existing owner/version/SHA-256-bound artifact store, including model/phase provenance. A persistence failure prevents successful completion. Main reads the exact manifest toolCallId with `delegation_read`; a digest/resultVersion is not a call ID.

Captured payloads are the SDK-visible results; existing tool-output caps still apply. This change does not widen workspace/MCP/permission boundaries or certify independent participant reasoning. A caller contract is natural language, not an arbitrary machine-validated JSON schema.

## Fresh verification

| Check | Result | Evidence |
|---|---|---|
| Focused regressions, council, FLOW verdicts, artifact ownership/delivery | 190 tests / 17 files passed | `.scratch/council-output-evidence-20261018/accepted-tests.log` |
| Compiled council + real SDK + native read_file + mock model | 8/8 checks passed | `compiled-controls.json` in the same scratch directory |
| Typecheck / build / semantic instrumentation | All exit 0 | `typecheck.log`, `build.log`, `semantic.log` |
| Built tools-MCP native selfverify, actual Bun TUI | Boot 1/1 passed | `native-selfverify.json` |

The compiled control actually executes read_file on a private fixture, captures `compiled-native-read`, persists the result and retrieves it as main after completion. Foreign owner and digest-as-call-ID controls fail as required. Other controls check caller output and retry format.

No paid-provider council was rerun; no live docs_search or quality/cost advantage was measured. The old result and original user report remain unchanged. Existing CLI processes need a Bun restart to load the built modules. The full unit suite, publication and deployment were not run.

## Bounded live follow-up

After restart, use one new council only if a live-provider check is needed. Request one compact JSON object; supply observations as observations, without calling them independently verified. Read the saved synthesis and host artifact manifest before ACK. If council claims a tool check, retrieve the matching toolCallId/resultVersion and compare the payload. If no supporting artifact exists, report that claim as unverified. Pros/cons, dissent, elapsed time and ACK alone cannot establish independent verification or superiority to a single worker.
