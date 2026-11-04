# Progressive task context: implementation and bounded acceptance

The user authorized the [research proposal](progressive-task-context-proposal-2026-10-16.md), requesting a question brief for unresolved behavior. This delivery implements instruction projection, skill discovery, bounded handoff and request telemetry. It does not implement schema filtering, paid-provider benchmarking or a working batch API.

## Behavior now available

- Agent prompts use a compact native capability core and complete-name skill index instead of the full native architecture narrative and full skill metadata catalog. Applicable repository/user instructions and the operating contract are retained. Full original skill metadata/paths and paged CLI reference remain accessible through **context_load**.
- Main starts at orient and can select research/plan/implement/verify. Stages can be skipped or revisited; selecting guidance does not approve a plan, authorize edits, change provider/model, or grant another tool. No stage classifier model call was added. The existing fast-tier rule forcing delegation after three files was changed to optional independent research.
- `context_load` accepts a bounded handoff and optional expected_revision. Invalid, stale or aborted requests do not advance the stage. A repeated unchanged selection is idempotent. The controller is owned by a task/turn, with independent child controllers; a cwd change resets guidance/handoff to orient.
- Before **every SDK step**, including step zero, main and child construct a disposable user-message context view. The active module is replaced; original user text, attachments and canonical transcript messages remain unchanged. Only host-produced projections are replaceable by identity; user text resembling a marker is not removed.
- The same controller survives outer retries; stable prompt parts are selected consistently for cache splitting, including the legacy reduced-prompt path. Native-skill/core sections remain stable across progressive first/tool-turn assembly.
- Bounded context_load receipts are retained through compaction. On explicit continuation, matching session/cwd receipts can restore stage/handoff through the existing recognized continuation chain. A different intervening task stops restoration. New work starts at orient. Native session receipts are durable in the ordinary transcript; traditional StreamRunner job state is scoped to its prepared invocation, not a promise of universal child restart recovery.
- Prepared-request telemetry measures the actual projected messages. Main records numeric contract/native/mode/custom/skill/subagent section lengths; main and child record stage/revision/context/handoff measurements. `usage_forensics` exposes these fields and explains their nesting. No raw prompt or handoff content is copied into telemetry.

Default: progressive context enabled. **MUONROI_PROGRESSIVE_CONTEXT=0** retains the legacy prompt/catalog path and omits context_load. Existing CLI/MCP processes must restart after this build. No user settings were migrated.

## Fresh acceptance

| Check | Result and boundary |
| --- | --- |
| Initial feature RED | New controller/projection test failed before the module existed; prior installed-SDK research separately reproduced the step-boundary requirement |
| Final focused tests | **173 passed / 19 files**, exit 0 |
| Build | Exit **0** |
| Actual child loop | Unit integration drives StreamRunner and the mock SDK provider: research → verify on two requests, retained proof and unchanged prepared history |
| Actual compiled main loop | **10/10 controls**; Agent → MessageProcessor → executeToolEngine → SDK, isolated real SQLite, three mock main requests orient → research → verify |
| Canonical/durable evidence | Main transcript restores the owned receipt, new work resets, user text has no injected module; compaction/JSON roundtrip and session/cwd/new-task barriers have functional tests |
| Existing controls | Permission, GSD heavy/revise negative mutations, hydration, MCP discovery, delegation compaction, structured evidence retention, cache and preservation guards included in focused suite |
| Native/MCP controls | **15/15**, bounded isolated fixture |
| Native mock TUI | smoke-boot + passive-log **2/2**, run **69f35f6c-0eca-4314-9d02-5ba32267df89** |

The actual main fixture recorded context blocks of **345, 548 and 618 characters**, with handoff lengths **0, 37 and 51**. All three requests retained the repository sentinel. The fixture's unresolved exit=1 proof remained in the verify request; a stage label was not treated as a passing test result.

The TUI check uses a mock model and fake fixture credential. These controls do not establish that a real model chooses stage changes at the right time, eliminates all extra discovery calls, or improves paid-provider cost/latency. Private main logs also record unavailable EE/proposer fixture warnings; the proof does not establish a live healthy EE service.

## Measured request comparison

Same fixed workspace, canonical input and catalog-selected fixture model; no provider request or model migration. The legacy reference file and compact core coexist; the former is no longer injected by default. Existing ancestor skill discovery finds 74 metadata entries in this fixture. This is not a universal session profile.

| Component | Legacy first request | Progressive orient request |
| --- | ---: | ---: |
| System characters | 48,412 | **24,547** |
| Native section characters, including separators | 13,885 | **3,437** |
| Skill index/catalog section characters | 19,951 | **6,534** |
| Contract section characters | 1,990 | **1,990** |
| Custom instruction section characters | 168 | **168** |
| Message text characters, including stage view | 74 | **499** |
| Schema/description characters | 23,416 / 42 tools | **24,229 / 43 tools** |
| CLI-estimated input tokens | 16,966 | **10,917** |

This is **49.30% less system text** and **35.65% less estimated prepared input** for the controlled first-request comparison, including the new loader schema and projected orient text. These estimates are not provider token counts or money saved. Contract/custom instruction bytes are preserved in the fixture; no raw user policy was deduplicated or shortened.

Important counterexample: the old **outer-retry reduced** assembly is **14,576 system characters / 8,471 estimated input tokens**. Progressive keeps the capability core and discoverable index available, so its corresponding orient assembly is **24,547 / 10,917**. That path grows. The old code did not apply its reduction to each SDK-internal step; the new implementation does not justify saying every request or whole session becomes cheaper. Warm-cache, routing/retry frequency and extra lookup calls require a real matched comparison. The stable invariant mode persona itself remains 12,094 characters in this fixture.

## Evidence and next-session questions

- [Bounded implementation manifest](evidence/progressive-task-context-implementation-2026-10-16.json) records results and source/runner hashes. Historical research/baseline artifacts were preserved.
- Private `.scratch/progressive-task-context/implementation/` contains RED, tests, build, main/native logs and the same-fixture request comparison. Root scratch runners and JSON results are referenced by the manifest.
- [Copy-ready Vietnamese question brief](progressive-context-questions-2026-10-16.md) asks the next CLI session to check spontaneous stage choice, skill lookup overhead, continuity, authorization understanding and measured usage, with record/toolCallId provenance.

Deferred work is explicit: no activeTools filtering, no automatic rewriting/trimming of repo instructions, no paid-model quality/cost claim, and no batch acceptance. Current batch runner has explicit Phase-0 throwing stubs; implementing a real transport is a separate feature, not a context-loader patch. Broader continuation/rotation policy and index-path tradeoffs are covered in the question brief.

No original user DB/settings write, root GSD state edit, user-process termination, TCIS policy edit, dependency addition, commit, push or deployment was performed by this implementation run. Application tests and probes used isolated homes/workspaces; normal future CLI sessions persist their own new receipts as designed.
