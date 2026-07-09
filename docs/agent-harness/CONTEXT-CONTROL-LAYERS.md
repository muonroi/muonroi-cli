# Context-control layers

muonroi-cli has **five** distinct mechanisms that keep a cheap/fast model from
being fed a runaway context. They overlap in *purpose* (bound context) but each
owns a **different axis** — a different unit of work and a different decision
maker. This doc pins that ownership so the set stays coherent as it grows.

> Read this before adding a sixth knob. If a new mechanism doesn't own a *new*
> axis, it probably belongs inside one of the five below.

## The three axes

| Axis | What it acts on | Effect |
|---|---|---|
| **1. Output truncation** | A single tool result | Shrinks the text a tool returns before it enters context |
| **2. History compaction** | Prior messages in a running loop | Rewrites/summarizes older messages to cut billed input across rounds |
| **3. Session isolation** | A whole turn or session | Moves heavy work into an isolated child so the parent never holds it |

## The five layers

### Axis 1 — output truncation (shared mechanism, two budgets)

Both use the same `wrapToolSetWithCap` (`sub-agent-cap.ts:217`); they differ only
in budget and tier ratios.

| Layer | Budget (default) | Tier ratios | Scope / owner | Wired at |
|---|---|---|---|---|
| **Top-level cap** | `getTopLevelToolBudgetChars()` = 400k | 0.5 / 0.8 (looser) | Cumulative tool output within **one top-level turn** | `tool-engine.ts:1067` |
| **Sub-agent cap** | `getSubAgentBudgetChars()` = 240k | 0.3 / 0.7 (aggressive) | Cumulative tool output within **one `task` sub-agent invocation** | `stream-runner.ts:330` |

`DEFAULT_MAX_CUMULATIVE_CHARS = 120_000` in `sub-agent-cap.ts:66` is **only the
no-arg fallback**, not either wired budget. (Historical drift lived here — the
header comment used to call 120k "the" budget.)

### Axis 2 — history compaction (three triggers)

| Layer | Trigger | Scope / owner | Where |
|---|---|---|---|
| **Post-turn compact** | End of every top-level turn | Summarizes the parent's own history between turns | `postTurnCompact` (deps → orchestrator) |
| **Overflow compact** | Context window about to overflow mid-turn | Emergency rescue of the top-level turn | `compactForContext` (deps → orchestrator) |
| **Sub-agent in-loop compactor** | Between steps inside a `task` sub-agent | Rewrites older tool-result *messages* into stubs; keeps last N turns + high-value results verbatim | `compactSubAgentMessages` (`subagent-compactor.ts:469`), called from `stream-runner.ts` `prepareStep` |

These rewrite *messages*; Axis 1 truncates *tool outputs*. A tool result can be
truncated by Axis 1 on the way in **and** later stubbed by Axis 2 as it ages.

### Axis 3 — session isolation (three decision makers)

| Layer | Decided by | Unit | Isolation | Returns to parent | Where |
|---|---|---|---|---|---|
| **Task / delegate sub-agent** | The **model** (calls the `task`/`delegate` tool) | One focused sub-task | In-process fresh `streamText` loop (or detached OS process for `delegate`); no DB session | Final assistant **text** as a `ToolResult` | `runTask` / `runDelegation` (`orchestrator.ts:1455/1532`), `stream-runner.ts` |
| **Reactive sub-session** | The **orchestrator**, from prior-turn observed tool load ≥ `MUONROI_REACTIVE_DELEGATE_CHARS` (120k) | The **next** whole turn | Forked DB session `kind="subagent"` | Salvaged transcript turn, absorbed | `reactive-delegation.ts`, `orchestrator.ts:2924` |
| **Session rotation** | The **orchestrator**, when `estimateConversationChars()` > `MUONROI_SILENT_ROTATION_THRESHOLD` (80k) at turn start | The current session | Compact + fork DB session `kind="rotation"` | Continues in the rotation child | `orchestrator.ts:2878`, `:2931` |

Router-driven `classifySubSessionAction` → `SPAWN_SUB_SESSION` is the *original*
trigger for the reactive-sub-session layer; reactive escalation and the rotation
size-gate are the two additional triggers that feed the same fork+absorb path.

## Known gap (not a layer — a hole)

**Cold first heavy turn.** Reactive escalation (Axis 3) needs a *prior* turn's
load signal, so the very first heavy turn of a session still lands in the parent
(bounded by the top-level cap, but not isolated). This is the one axis-3 case not
covered. Fixing it means an *in-turn* checkpoint at a tool-round boundary — build
only after instrumenting how often turn-1 actually crosses the threshold
(Evidence-First; currently one known instance: session `50aa048a6303`).

## Rule for adding a sixth mechanism

1. Which axis does it own? If it's an existing axis, extend that layer instead.
2. If truncation/compaction: reuse `wrapToolSetWithCap` / the compactor rather
   than a parallel implementation.
3. Budgets live in `settings.ts`, never as fresh literals — keep the single
   source of truth so the next reader doesn't inherit a stale comment.
