# Run: main context quality

## Requirement Baseline
User authorized repairing the four confirmed context issues. R1: account for tool outputs, tool inputs, reasoning and schemas in the actual per-step prompt. R2: bound and sanitize SessionStart model context using the same notice displayed by the TUI. R3: prioritize final helper deliverables and traceable tool evidence over raw transcript concatenation. R4: replace outdated EE guidance snapshots, preserving unrelated conversation and sequence ownership.

## Research Pack
Current baseline: 9a4aae38, clean develop. Controlled source probes: 80,000 tool-result characters reported as zero messagesChars; 100,000 hook characters injected as 100,089 model-message characters; final helper middle evidence omitted by head/tail transcript cut; three revisions of one EE warning yielded three historical blocks. These reproduce context behavior, not a real-session watchdog cause.
Existing cumulativeMessageChars already counts text/reasoning/tool-call/tool-result; reuse it. SessionStart formatter already sanitizes and bounds at 16,384 chars; reuse it. Child overlay already asks for structured Key Changes/Verification/Result; use final deliverable and tool IDs, without another LLM call. Guidance sequence arrays must remain aligned; never remove user or assistant messages.

## Clarify / Context Gate / Gray Areas
Requirements confirmed by user. Repository contracts and verification paths inspected. No active gray areas. Only context accounting, injection and receipt rendering change; no provider/model IDs, routing/council ownership, permissions, storage schema, user DB, settings, deployment or watchdog changes.

## Delivery Roadmap and Verified Plan
P1/W1: implement the four repairs and runtime regressions sequentially, with focused tests after each step. Then build/typecheck, full configured unit suite plus Bun-only SQLite coverage, and native selfverify for workflow behavior. Plan check passed: every requirement maps to a reproduction and protected contract; no parallel delegation.
1. Small prompt-breakdown helper using existing character counter; capture final system/messages/tools at prepareStep boundaries; include schemas in estimate fallback, keep actual usage authoritative.
2. Inject the bounded SessionStart notice into model messages; test large/escaped/unicode output and resume replacement.
3. Render bounded final deliverable plus tool-call/result evidence references; test late tool noise cannot evict final findings, structured response and missing/failure output.
4. Replace all tagged EE guidance snapshots with current snapshot using aligned messages/seqs, even after resume/compaction; test revision, dedup, empty state, unrelated history and ownership.

## Execution / Resume Digest / Compact-Safe Summary
- Mode: auto under user authorization and developer persistence requirements; single agent.
- Gate: done; phase P1, wave W1 verified and released; context risk low, session risk low, burn risk low.
- Delegation: none. All source changes owned by main.
- Approval strategy: authorized reversible edits and verification; do not ask again for routine implementation choices.
- Experience snapshot: recall returned unrelated EE-connect surface; no recalled rule acted on.
- Next verify: none; all four required outcomes and local release checks complete.
- Carry forward: main owns acceptance; background PIL remains optional; preserve transcript sequence alignment and reasoning metadata; measurements are character estimates, not provider billing.
- Next Wave Pack / Wave Handoff: W1 done. Restart the junction-linked CLI to load the rebuilt modules.
- Recommended next command: none; requested fixes are complete.

## Verification Ledger
- Metrics + existing compactor: 37 passed; full SDK slow-council continuation now checks that post-tool input includes the 8,000-character synthesis and exceeds initial input.
- SessionStart rendering/model parity + resume/compaction: 50 passed. The bounded and sanitized notice body reaches both surfaces.
- Receipt + real main handoff/isolated storage: initially 1 failure exposed legacy string tool results; added compatibility and regression. Then 55 passed, zero failed.
- Guidance + existing processor/main handoff: 34 passed. Resume keeps latest persisted snapshot; updated maps replace stale snapshots; compaction restores current guidance without stale SHA suppression.
- Combined touched scope: 152 passed / 10 files before native-schema normalization; subsequent schema/SDK/guidance verification 14 passed / 3 files.
- SDK source confirms public asSchema resolves FlexibleSchema.jsonSchema, including promises. Resolve once per assembled toolset; do not count Zod/wrapper implementation objects as provider schemas.
- Biome: safe formatting/import organization applied to touched files, zero errors (existing warnings remain).
- Final focused scope: 152 passed / 10 files, zero failed. Typecheck passed. Build passed without errors/warnings. Strict semantic check passed. Native SQLite coverage: 10 passed, zero failed.
- Mounted TUI coverage: 5 passed, 1 platform-skipped test / 5 files (4 passed, 1 skipped). Bun's existing native shutdown crash still appears in child stderr; do not claim it repaired.
- External native selfverify server failed before execution: run 3ee40562-b731-4816-98b7-63cdcecc8fa2, cached npx package cannot resolve @muonroi/agent-harness-core/selector. No dependency/cache edits made. Actual selfverify_start/status/result invoked over MCP from the tested workspace dist/src/index.js tools-mcp: run 2e15dfda-8f67-48d4-aedf-3e3f8b3ce8c5, smoke-boot 1 passed, zero failed/inconclusive. context-quality-native-qa.mjs and selfverify.json preserve method/report. This is boot evidence, not live provider/full UI evidence.
- Tested source manifest: 1953 SHA256 hashes; no source drift after build and QA.
- FULL configured unit suite completed: bun run test --reporter=verbose, 8853 passed, zero failed / 945 passed files, 6 skipped files; 14 skipped tests, 2 todo. Duration 914.25s. context-quality-full-unit.log records final receipt; code stayed unchanged across verification.
- The complete 1953-entry manifest is retained locally as ignored context-quality-tested-source.log; the tracked JSON stores its digest/count and the 11 touched source hashes. No full source-hash dump added to the repository.

## Phase Close
P1/W1 verified. Build/typecheck passed without errors/warnings; relevant focused tests 152 passed; full configured units 8853 passed with zero failed; Bun-only storage 10 passed; mounted TUI 5 passed/1 skipped; workspace native selfverify smoke-boot 1 passed/0 failed/0 inconclusive. Secrets and staged lint passed, tested source unchanged. No live paid-provider or remote CI claim. Existing Bun child shutdown crash and external npx native-server packaging failure remain outside scope.

## Release / Goal Audit
All R1-R4 outcomes have measured tests. Main owns decisions and acceptance; no extra LLM calls, schema/policy/settings/user DB migrations, or watchdog changes. Implementation f42283a2ff8ccf9ff8d00a5a556170510bd36776 committed and pushed to origin/develop with normal hooks after the green full-suite receipt. All 1953 source hashes remained unchanged after commit hooks. CLI global package is a junction to this workspace; restart loads the rebuilt dist. Remote CI is not verified; native QA limitations above remain explicit. This final release-receipt update is docs only.
