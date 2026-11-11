# Forensic visibility and prompt-contract corrections

## Problem and resulting behavior

Session 5a74a2451830 demonstrated that successful usage events alone miss rejected requests. The agent repeatedly searched consumer-repository build/application logs for a CLI provider failure already stored in the CLI SQLite database. The injected guidance also supplied fixed token/cost claims, a two-round forced-delegation rule, and an unsupported conclusion that a 429 after retries proves exhausted account budget.

`usage_forensics` now returns recorded usage and separately labeled failures, record/session/database provenance, available request component estimates, and a snapshot cutoff. Native and MCP calls use the same collector and tool description. The tool defaults to bounded pages: twenty usage events, five failures and five measurement rows. Totals cover the full selected snapshot; the event arrays can be partial. Reuse `snapshot.until` with `usage_offset`, `error_offset` and `measurement_offset` for subsequent pages.

The collector uses a SQLite read transaction and one cutoff for usage, interaction counts, diagnostic rows, dedup data and experience counters. Session scope remains the existing root-plus-descendant family; returned session IDs make that scope explicit. Error messages and optional provider-option descriptions are redacted and bounded. Errors do not add consumed tokens to usage totals; stored costs are CLI estimates rather than invoices.

## Request measurements

Main and child preparation paths persist `prompt_breakdown` records containing numeric component sizes, call ID, step number, model, context window and the configured output reservation when available. No system prompt, user prompt or tool-result text is copied into these diagnostic records.

Available components distinguish system, message history, tool-result text and tool schemas. New prepared-request estimates and legacy `call_accounting` estimates carry different kind/estimator labels. Missing legacy schema or reservation measurements are null. These are prepared-text measurements/proxy-tokenizer estimates, not exact HTTP captures or provider token counts. Measurement layers must not be counted as independent requests.

Legacy JSON names `peakSingleCallInput` and `peakSingleCallFresh` remain for compatibility. The display now calls them peak usage events and does not infer context safety from cache hits or aggregated fresh-input totals. Cached input still occupies context. A dedicated regression reproduced the old incorrect “NOT a cap breach” conclusion for an event with 400,000 input tokens and 350,000 cached tokens.

## Guidance corrections

- Removed fixed 17K-token and dollar-per-round assertions, forced delegation after two research rounds, arbitrary file-count stopping, and fixed shell-overhead claims. Independent calls can be batched; dependent calls stay sequential. Delegation remains main-owned and evidence/scope-driven.
- A 429 after backoff now means the request remained rate-limited during the local retry window. It does not establish exhausted credit or identify concurrency/RPM/TPM/plan counters. Backoff, reduce-parallelism and no immediate respawn/probe guidance remain intact.
- Child descriptions now match retained repository custom instructions, omitted skills catalog, role-filtered tools and main-owned integration acceptance. No repository instructions or actual child permissions were removed.
- Discovery/meta guidance distinguishes a consumer repository from CLI source and directs provider-error investigation to CLI telemetry. Capability descriptions and longer meta output guidance are not treated as runtime payload/cost measurements.

## Verification evidence

Initial regressions reproduced five omitted-diagnostic/snapshot failures, one missing numeric-telemetry contract, three incorrect prompt contracts and the cached-context display error. The clarification-proposer scope test uses a prompt explicitly verified to enter the meta branch.

Final test/build/native evidence is recorded in `.scratch/cli-feedback-contracts/` and the qc-flow run `cli-feedback-forensics-contracts.md`. The compiled private SQLite fixture exercises root plus two sibling children, exclusion of unrelated/future records, a representative rejected HTTP 400, independent page offsets, fixed-cutoff behavior after new usage, bounded/redacted JSON, prepared numeric telemetry and native/MCP parity. No paid-provider requests or live-session DB edits are needed for those controls.

The final run passed **293 tests in 22 files**, the build and whitespace check, and **12 compiled native/MCP controls**. The stress-fixture response was **24,363 characters**. Native offline TUI selfverify `345cf98d-2862-40a0-8df3-260490408d29` passed **1/1**. This boot is not a paid-model behavior benchmark.

This repair does not establish an exact per-layer token bill, whether removing a particular instruction improves agent quality, or which internal counter StepFun reached. [Follow-up questions](cli-feedback-followup-questions-2026-10-15.md) request the missing evidence without another broad audit.

Restart existing CLI/MCP processes to load the rebuilt modules. No commit, push, provider migration or server deployment is part of this change.
