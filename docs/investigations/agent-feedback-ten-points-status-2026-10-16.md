# Status of the ten runtime feedback points

Two specific CLI guidance causes have been repaired (#4 and #6), five items have bounded partial improvements (#1, #2, #3, #8, #10), and three remain unresolved or inherent limitations (#5, #7, #9). This is not a claim that a model's subjective friction has been eliminated. Points 1/8 and 2/10 overlap.

| # | Feedback | Status and boundary |
| --- | --- | --- |
| 1 | Elided tool results interrupt reasoning | Partial. Existing durable receipts, artifact references and retrieval paths retain evidence, but retrieval remains explicit. User has no concrete failing elision example; automatic rehydration design is unchanged. |
| 2 | Large system prompt | Partial. Unsupported fixed-cost claims and some forced round rules were corrected; prepared-request measurement is available. No comprehensive instruction deduplication or lazy loading was implemented. Per-instruction-layer representative data remains missing. |
| 3 | Provider rate limits | Partial mitigation. Shared concurrency/pacing/backoff/cancellation and diagnostic attribution have previous bounded evidence. CLI cannot remove provider-enforced limits; injected account-limit guidance alone is not a measured HTTP 429 or proof of exhausted credits. |
| 4 | LSP prerequisite for simple grep | Specific guidance cause repaired. Text/config/log search may use grep directly; LSP is preferred for symbols/references/diagnostics/semantic impact. lspStatus completeness interpretation is retained. |
| 5 | Delegation adds requests and context | Inherent tradeoff; not eliminated. Each child has its own work/context. More delegation is not automatically cheaper. No measured per-task main-versus-worker cost benefit was established here. |
| 6 | Bash cache requires extra reads for small output | Specific guidance cause repaired. Sufficient returned output is usable directly, cache slicing is for missing details, and intentionally focused read-only pipes are allowed. Full build/test/failure evidence and failure exit codes remain required. Cache execution behavior is unchanged. |
| 7 | Unclear effective permission mode | Unresolved UX evidence. No specific incorrect/missing mode display or prompt case was provided or reproduced. Safety approval modes were not removed. |
| 8 | Continuity after compaction | Partial. Earlier handoff/ACK/receipt persistence improves continuity, but automatic restoration of every context detail is not implemented. Requires a concrete missing-information case and a bounded context selection contract. |
| 9 | Selfverify does not replace logic review | Inherent coverage limit. Boot/modal/scenario proofs are bounded; source review, relevant unit tests and integration tests remain necessary. The passive-log planner defect was separately repaired, not treated as proof of universal harness coverage. |
| 10 | Instructions are too long | Same unresolved optimization area as #2, not an independent repaired bug. No overall system-token reduction is claimed. |

## Current guidance change

Source family updated consistently: native-capabilities-workbook, fast-tier cheap-model-playbook, bash registry description and usage-report hint. The obsolete existing playbook assertion for a blanket pipe ban was updated. No new text-mirroring unit tests were added.

The actual compiled pre-change section reported mandatoryLspGate=true, fixed500Claim=true and fastTierBlanketPipeBan=true. It measured 13,048 native-section characters and 2,444 fast-prelude characters. Current compiled sections measure **13,151** and **2,431** characters respectively: the native section grew by 103 characters to explain the task distinction; the fast prelude decreased by 13. This repair reduces mandatory workflow steps and contradictory guidance; it is **not** evidence of an overall prompt-size, latency or provider-cost improvement.

Fresh evidence:

- Existing focused prompt/bash/cache tests: **43 passed / 6 files**. Initial length failure (2,514 against the existing 2,500 cap) was corrected by shortening prose, not relaxing the cap.
- Build: exit 0.
- Compiled controls: **7/7**. Actual standard/fast injected sections and bash tool description permit focused operations; literal config search executes without LSP setup; small bash output is directly available and remains cached; exit code 7 is retained for a failing command.
- Fresh compiled native/MCP fixture: **15/15**, with **smoke-boot + passive-log 2/2**, run **666a0bd3-cb40-4d2a-8e09-fbfd4a8cfaf4**. Mock model/fake test credential only; no live-provider behavior claim.
- Private artifacts: `.scratch/tool-guidance-policy/` contains tests/build logs, compiled controls and native runner/results. Previous frozen evidence artifacts were not overwritten.

No provider routing, permissions, cache storage/slicing, LSP implementation, compaction or automatic rehydration behavior changed. Existing CLI/MCP processes need restart to load rebuilt modules.

## Subsequent evidence and repairs

The table above is the original guidance-wave snapshot. Later user evidence supplied concrete elision failures: [durable elision/FTS follow-up](elision-durable-evidence-fts-2026-10-16.md) repairs archived argument/result retention and adds bounded read-only argument recovery. Items 1/8 remain partial because automatic context restoration is not implemented and previously overwritten history cannot be recreated. Historical HTTP 429 worker failures are confirmed separately from injected limit guidance; missing headers/counters still prevent attribution to a specific account limit.

The later [read-only feedback GSD repair](readonly-feedback-gsd-gate-2026-10-16.md) addresses actual blocked history/inventory calls during an informational request and reconciles the two remaining native LSP descriptions. This does not establish a reduction in total prompt tokens or remove the inherent delegation/verification tradeoffs in items 5/9. Permission-display evidence in item 7 remains unresolved.

The next [runtime permission/verification follow-up](runtime-permission-verification-guidance-2026-10-16.md) reproduces absent permission metadata and adds caller-derived main/native-sub-session snapshots outside the static cache. Item 7 now has a bounded partial repair: the StreamRunner child path still reports unavailable, and mode visibility does not prove approval coverage. Verification defaults are clarified without creating a new runner or removing required checks. The native guidance grows by 734 characters, so items 2/10 are not marked resolved.

The [progressive context implementation](progressive-task-context-implementation-2026-10-16.md) now replaces eager host reference/catalog injection with compact invariant guidance and task-selected modules projected before every SDK step. Items 2/10 have measured first-request improvements in a fixed fixture (system text -49.30%, CLI-estimated input -35.65%), with unchanged repo policies. Old reduced outer-retry requests can grow, and real provider cost/latency/model-choice efficacy remains unmeasured. Bounded handoff receipts strengthen items 1/8; they do not recover every historical detail or promise arbitrary cross-session restoration. See the saved next-session question brief for live verification.
