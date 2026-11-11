# Prepared-request overflow recovery: 985b3540cc14

## Incident and evidence boundary

The reported local guard rejected estimated input112413 plus reserved output16000 against window128000:413 tokens over. This is a pre-send estimate failure, not an HTTP429, exhausted credit, or evidence that the provider received an oversized request.

Read-only SQLite inspection confirms session985b3540cc14 belongs to the ai-dock workspace and records model deepseek-v4-pro. Its last persisted prepared measurement63036 at2026-10-18T14:42:42.903Z contains estimatedInputTokens50917, reservedOutputTokens16000, contextWindowTokens128000, workingContextChars1423, contextPrunedChars0. The specific failing112413 preflight was not persisted as a prepared step, so its component breakdown and the loaded process revision cannot be reconstructed from this record. Private numeric snapshot: `.scratch/context-overflow-985b/incident.json`. No session contents/settings were edited.

## Reproduced cause and change

`compactForContext` returned early whenever the working-set projection fit a history-only compaction threshold. It did so even when the existing overflow handler explicitly passed force=true. Tool schemas and output reserve are checked later by the final prepared-request guard. An active ledger that archived nothing could therefore defeat its own compact-and-retry recovery.

The private-HOME/SQLite regression `honors forced overflow recovery when an active working set archives nothing` failed before the fix (summary calls0, expected1). The fast return now requires !force. Ordinary task-selected pruning still avoids summarization when sufficient. A forced retry reaches the existing emergency summary fallback. No model switch, output-budget reduction, permission change, autonomous relevance classification or raw transcript deletion is introduced.

Initial blocked requests now persist numeric prepared-request evidence with requestPhase=preflight and contextBudgetBlocked=1 before raising the guard. Normal SDK requests carry requestPhase=step. Diagnostic records retain component lengths/counts and schema measurements; prompt/user/tool payload text is not added.

## Verification

The actual Agent/AI SDK tests use a local scripted model and isolated HOME/USERPROFILE/SQLite:

- History plus system fits the heuristic threshold while schemas plus the unchanged output reserve exceed the final window. The request is blocked before main-model invocation, one forced recovery runs, and the recovered prompt contains the current task and unresolved failure. Exactly one actual main SDK model invocation returns the final answer; its output budget matches the rejected request's configured reserve. Raw SQLite retains the seeded old history.
- With the large history explicitly pinned, exactly one forced recovery is allowed. Both preflight attempts remain too large, no main provider invocation occurs, and a visible error is returned. The guard remains fail-closed.
- Nonforced selective pruning still avoids summary calls; owned state survives DB reopen; receipt write failure remains atomic.

Focused suite: 8 tests / 2 files passed. Related regression: **233 tests / 27 files passed**, exit 0. Build/typecheck passed. Built native selfverify with actual Bun TUI: boot 1/1 passed. Evidence manifest: `docs/investigations/evidence/context-overflow-985b-2026-10-18.json`; logs under `.scratch/context-overflow-985b/`.

These are local fixture/protocol/recovery checks, not a live-provider quality/billing measurement or a replay of the user's exact missing request. No full suite, push, deployment or changes to the incident session. Existing processes must restart with Bun to load the built fix; this does not prove an already running process has loaded it.
