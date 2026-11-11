# Progressive task context: research and implementation proposal

Status: proposal, not a production-loader implementation. The user requested research and a recommendation after authorizing context-cost improvements. No application code, tool grants, provider settings or existing evidence was changed in this research wave.

## Recommendation

Use **task-stage context, assembled before every model request**, with PIL supplying bounded relevance hints. Do not equate a pass through the PIL preprocessing layers with progress through a coding task. Maintain a small host-owned invariant block, full applicable user/repository instructions, a durable task handoff and the modules needed now. Replace the active stage guidance rather than appending every previous stage's instructions to conversation history.

This is an application-specific design recommendation based on the inspected source and experiments below. Anthropic's [context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) supports keeping useful references and retrieving relevant context when needed, while noting the latency cost of extra exploration. It does not establish a measured saving for this CLI.

## What was measured

Installed SDK: **ai 6.0.169**, read from node_modules/ai/package.json. No dependency upgrade is proposed.

Actual compiled prompt assembly and createPromptMeasurer were run against a fixed temporary workspace, a synthetic user prompt, a repository-instruction sentinel and the same **42 registered native tools**. The existing directory-walk discovery also finds **74 ancestor project skills**; this is disclosed fixture behavior, not a claim that all user repositories expose the same catalog. Its skill metadata catalog is **19,948 characters**, including descriptions/locations, not complete skill bodies.

| Existing assembly variant | System chars | Native schema/description chars | CLI-estimated input tokens |
| --- | ---: | ---: | ---: |
| First-call prompt | 48,412 | 23,416 | 16,966 |
| Existing reduced tool-turn prompt | 14,576 | 23,416 | 8,471 |

The **33,836-character difference already exists between these two assembly modes**. It is not a newly implemented reduction or a measured provider bill/latency improvement. The fixture holds tool availability fixed; it excludes real long history, MCP schemas, media, response tools and fast-tier caller preludes. The chitchat row in the private fixture likewise holds the 42-tool set fixed for component comparison; it is not a real chitchat transport capture.

The native manifest is **13,883 characters**. Its internal steering/meta-description tail is **7,610 characters**. This tail contains some safety/evidence guidance as well as subsystem explanations, so it cannot be deleted blindly: invariant requirements must remain in the always-loaded host contract. The separate repository instructions are not an optimization budget to silently discard.

These measurements identify initial instruction/catalog loading as one repair surface. Historical session 5a74a2451830 row 58605 separately showed large tool results; these independent scopes must not be merged into one synthetic request or generalized to every session.

## Source findings

| Boundary | Evidence | Design implication |
| --- | --- | --- |
| Eager capabilities/catalog | prompts.ts:555,564,581 loads custom instructions, then the complete capability manifest and formatted skills metadata unless omitted by existing options | Separate invariant instructions from optional module/catalog descriptions; preserve custom instructions |
| Outer-loop reduction | tool-engine.ts:1512 selects the reduced prompt only after an outer streamText call; prepareStep begins at 2144 | Choose context at the SDK request boundary, not only once per user turn or outer retry |
| SDK 6 per-step settings | node_modules/ai/src/generate-text/stream-text.ts:1529-1573 reconstructs step input from initial messages plus responses and defaults unspecified system/tools/messages to outer settings | Reapply the current projection each step; a one-time override is insufficient |
| Main measurement closure | tool-engine.ts:1596 captures system/tools before prepareStep; 2230 measures step messages | Recompute/cache the measurer by the actual assembled system/schema fingerprint; otherwise dynamic context accounting can be stale |
| Child measurement/loop | stream-runner.ts:681,834,957 uses a fixed child-system measurer and per-step message compaction | Apply the same assembly/measurement contract to children, with independent task ownership |
| Cache/context relocation | cache-prefix.ts:46,83 splits stable prefix and folds the dynamic tail into a user message | Retain a stable mandatory prefix; replace only host-owned context slots, preserving original user text and structured parts |
| PIL preprocessing | pipeline.ts:115,256-302 runs intent, enrichment, workflow and output processing during preparation | Useful for relevance/advisory hints; it does not independently know each later execution stage |
| Workspace GSD state | workflow-engine.ts reads cwd-owned STATE/PLAN-VERIFY | Do not use an old workspace phase as sole authority for the current session/task context or edit authorization |

The [official SDK source at the installed version](https://github.com/vercel/ai/blob/ai%406.0.169/packages/ai/src/generate-text/prepare-step.ts) exposes per-step system, messages and activeTools overrides. Current SDK v7 documentation has different message-state behavior; do not implement v6 persistence assumptions from the latest documentation.

## SDK experiment

The private probe uses the real installed streamText loop and the existing MockLanguageModelV3 fixture. Three configurations each produce three SDK requests, with no paid provider calls:

1. Outer-only context: all three requests retain the original context and both synthetic tool schemas.
2. Override only step zero: request zero uses the research projection; requests one and two return to the outer system and old host-context message.
3. Reapply on every step: research, implementation and verification guidance replace one another. User scope remains, the original input hash does not change, and only the selected synthetic schema is exposed.

**9/9 checks passed, 9 synthetic model requests.** This proves feasibility and the per-step lifecycle requirement in SDK 6. It does not implement the CLI loader, prove real-model stage choice, preserve every production message shape, or measure actual token charges/latency.

## Options considered

| Option | Benefit | Limit / decision |
| --- | --- | --- |
| Shorten every paragraph but keep eager loading | Small implementation surface | Useful cleanup, but does not solve when unrelated context is loaded |
| Unlock by PIL layer only | Bounds preprocessing enrichment | Layers execute during preparation; later research/edit/test steps remain unaddressed |
| Task-stage projection with bounded PIL inputs | Matches current work and can change before every SDK request | **Recommended**; requires task-owned state and correct per-step measurement |
| Hide tools and summarize policies aggressively immediately | Can reduce additional schema/instruction payload | Defer until discovery/permission tests pass; missing tools or altered repo policies can harm correctness |

## Proposed assembly

Request = **invariant host rules + applicable user/repo instructions + task handoff + selected stage modules + selected evidence + granted tool schemas**.

The first two components remain present regardless of stage. Preserve Evidence-First, read-before-edit, permission/GSD boundaries, failure handling, instruction priority, user scope, Git safety and required checks. Loading a context module grants no capability and does not unlock mutations. If required context exceeds the physical model window, report the conflict; do not silently trim mandatory policies.

| Stage | Optional context loaded | Not mandatory in this stage |
| --- | --- | --- |
| Orient / answer | Goal, current state, compact capability/skill index, references to relevant modules | Full GSD playbook, complete CLI architecture narrative, TUI harness procedure |
| Research | Source/symbol/search guidance, task-relevant docs/EE recall, bounded evidence | Detailed editing and release procedures |
| Plan | Decisions, scope, affected areas, acceptance and required workflow instructions | All future execution logs or every skill's description |
| Implement | Approved scope where required, file/edit rules, chosen skill instructions, current changes | Full research transcript and unrelated verify/release playbooks |
| Verify | Required commands, changed surfaces, expected evidence, applicable selfverify recipe | Unrelated TUI scenarios and repeated full planning discussion |

These are context choices, not compulsory workflow gates. A small known fix can skip stages; verification failure can return to implementation/research. Discussion can finish from orient. Release instructions load only for a release task; user authorization remains separate.

### Transition ownership

- Main owns the task stage. Use task/run-bound structured state and actual existing workflow events when applicable. PIL may suggest a stage; it does not grant edit permission or override the user's request.
- Unknown stage starts with the invariant base and short orientation/index, not every module. An optional native context-loading action can resolve explicit module needs where existing workflow events are insufficient; do not require an extra classifier or context-loader round for every ordinary tool call.
- Do not infer implementation from any bash call: bash may be reading logs or running tests. Do not advance on failed/cancelled transitions. Track transitions idempotently by task/session and revision; retrying a request does not advance the stage.
- A stage request only selects guidance from modules the host knows. It cannot enlarge the role's granted tool set, acknowledge a worker result, pass plan-review or turn off approval.
- Each child has its own task/stage. A child completion notice does not reset the main's stage. Continue using the existing durable delivery/ACK records as the authority for result handling.

### Handoff and compaction

Keep a bounded task record with owner session/run/task, cwd, goal/scope, current stage/revision, decisions, completed work, next action, blockers and evidence references. Reference authoritative worker result versions rather than copying or reimplementing delivery/ACK state.

Prefer updates from existing structured tool results and the main's normal handoff; do not add a separate summarizer model call at every stage. Preserve command/exit status and unresolved failures. Full results stay in durable artifacts/SQLite and remain retrievable by session/toolCallId. Do not delete canonical transcript evidence merely to make a request view smaller.

Request views are disposable. Tag host-owned blocks in host metadata, not by trusting arbitrary user/tool text that resembles a marker. Replace the active host stage block, retain original user/repo instructions and attachments, and rehydrate bounded evidence when needed. Compaction/resume must preserve the task record or explicitly recover it; stale/missing owner metadata falls back to a bounded orient stage, not another task's plan.

### Skills, recall and tool schemas

- Replace the complete skills metadata catalog in every first request with a compact discoverable index and task-relevant metadata. Load the selected SKILL.md instructions when needed. A user-named or repo-required skill must always be resolvable; a fixed top-K relevance cutoff must not silently hide it. Retain an explicit full-catalog discovery path for uncertain matches.
- Keep EE retrieval project/task scoped and bounded. Historical lessons are context, not replacement user instructions; an unavailable brain cannot block main. Stage relevance filtering is useful inside PIL, after the task-stage owner is established.
- First delivery keeps existing tool grants/schemas while proving instruction selection. The fixture's 23,416 schema/description characters therefore remain a visible cost floor.
- A later delivery may use per-step activeTools and on-demand original MCP schemas. Keep inventory/description/retrieval and the means to load an allowed capability available. Narrowing exposed schemas is not a security boundary; existing role/approval/GSD enforcement remains authoritative.

## Implementation order

1. **Request-boundary telemetry and shadow assembly.** Record task stage/module IDs, revision/fingerprint, invariant/stage/skills/evidence/schema character counts and CLI token estimates per callId/stepNumber. Numeric metadata only, file-only diagnostics. Shadow computation must not alter requests or make model calls. Cover main, native children and batch requests; batch has no identical SDK loop, so project at each actual submit boundary.
2. **Instruction/module projection.** Centralize one assembler used by those paths. Keep the host contract and full applicable repo policies, split the native manifest, retain discoverable skills, move subsystem self-description to on-demand modules. Apply the selected view on every prepareStep, including step zero and retry paths. Refresh measurement/context guards using the exact system/messages/schemas sent.
3. **Durable handoff and targeted evidence.** Reuse transcript/artifact infrastructure and current delivery ownership. Preserve active failure/control evidence; bound history excerpts with explicit retrieval rather than reading huge output back into the prompt.
4. **Schema/PIL optimization after quality checks.** Measure extra discovery calls and incomplete matches before enabling tool filtering or narrower skill/EE selection by default. Roll out behind an implementation flag, with the existing path available for comparison; no proposed flag exists yet.

## Acceptance and experiment design

Compare baseline and candidate on the same snapshot, model/provider pin, initial context, tools, cache condition and task. Do not silently switch models. Use a known one-file fix, a read-only feedback request, multi-file research, a regression failure/recovery, a UI fix, child result callback, long-session compaction and resume. Offline/mock controls establish mechanics; live-provider experiments, if later authorized, establish model behavior and actual usage separately.

Mandatory checks: invariant/user/repo bytes retained; no cross-session/cwd stage leak; zero accumulated inactive stage modules; active modules reapplied on every SDK 6 step; exactly matched per-step measurement and context guard; unchanged grants/approval/GSD; named skills and original MCP schema discoverable; evidence retrieval survives compaction/restart; worker ACK not replayed; cache prefix stable within unchanged state; user interruption and parallel tools do not corrupt transitions.

Report system/module/skill/schema/history/tool-result sizes separately, request counts, retrieval misses, provider usage/cache statistics where available, time to first response, total elapsed and task correctness. Compare warm and cold cache separately. Smaller text with extra discovery/retry calls can cost more overall, so no percentage saving is promised before this comparison.

## Research artifacts and limits

- `.scratch/progressive-task-context/measure.mjs`, `before.json`, `before.log`, `fixture.json`: actual compiled baseline; temporary home path is private fixture metadata.
- `section-breakdown.json`: skills/meta-tail counts and discovery caveat.
- `probe-sdk.mjs`, `sdk-probe.json`, `sdk-probe.log`: nine-check installed-SDK mock probe.
- [Bounded evidence manifest](evidence/progressive-task-context-research-2026-10-16.json): source/artifact hashes and numeric results.

Only research scripts/artifacts and this proposal were written. No production-loader change, build/test-suite acceptance of an implementation, original DB/settings write, root workflow mutation, provider credit purchase, paid model request, user-process termination, commit, push or deployment occurred.
