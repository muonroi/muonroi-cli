# Graduation scenarios — the fixed corpus (P1-2)

> The scenario list referenced by `SELF-IMPROVEMENT-PLAN.md` §1.2. It is the **denominator**
> for axes A1 and A4 and the **assertion set** A6 is diffed against, so it is a measurement
> instrument: §2.2 protects it, and a sprint may not edit it in the same sprint as a claim.
>
> Written 2026-09-05. Every step below was executed against a live TUI over the MCP driver
> before it was written down; the two steps marked `knownFailing` are verbatim observations,
> not predictions.

---

## 0. How this file is read

Each scenario carries prose for a human and **one fenced JSON block** (a `json`-tagged code
fence) for `scripts/agent-drivability-score.ts`. **The JSON block is authoritative.** If the prose and the
block disagree, the prose is a doc bug and the block is the corpus.

Per step:

| field | meaning |
|---|---|
| `id` | stable across corpus growth — ids are never reused or renumbered |
| `action` | what the driver does |
| `via` | the MCP tool the driver calls |
| `discriminatingField` | **the field a driver must read to know THIS STEP SUCCEEDED.** Scores A1 |
| `decisionField` | **the field a driver reads to choose its NEXT action.** Scores A4 |
| `knownFailing` | the step does not work today; counts as NOT observed on both axes |
| `knownFailingEvidence` | verbatim observation. Required whenever `knownFailing` is set |

A field reference is one of:

- `{"kind":"node","selector":"…","field":"id|role|name|value|state|focus|selected|disabled|props.X","via":"…"}`
- `{"kind":"event","eventKind":"…","field":"…","via":"tui.last_event"}`
- `{"kind":"tool-result","tool":"…","field":"…","via":"…"}`
- `{"kind":"capability","field":"…","via":"tui.capabilities"}`

The referee resolves every reference against the **live** `tui.capabilities` payload — the role
vocabulary, the event-kind list and the selector grammar all come from the running server, never
from a copy in this file. A step that names something the protocol cannot carry is a **blind
state** and drags A1 down whether or not anyone ever replays it.

---

## 1. Rules that make this corpus a measurement and not a formality

1. **Scenarios and steps may only ever be ADDED, never removed or weakened, between graduation
   attempts.** Deleting a step that fails is green-by-deletion (§2.5) and fails the attempt it
   appears in. Rewording a step so it asserts something easier is the same act with better
   manners. If a step turns out to be wrong, add the corrected step *next to it* and record why
   the old one stays.
2. **A corpus of only-passing steps measures nothing.** At least one step must be marked
   `knownFailing` at all times. When the last known-failing step is fixed, the corpus has stopped
   being a test and a new hard case must be added before the next attempt.
3. **The information budget is `tools/list` + `tui.capabilities` and nothing else.** No repo
   files, no `CLAUDE.md`, no `docs/`, not this file. Every MCP client receives `tools/list` free
   at handshake (21 tool names with descriptions and input schemas), so pretending the budget is
   "capabilities only" is false at t=0.
4. **Stuffing information into tool description strings does not count.** It moves what A6
   measures out of the payload A6 measures and into a channel it does not. A graduation run whose
   transcript shows the agent recovering the selector grammar from a description string rather
   than from `tui.capabilities.selector` is recorded as a **partial result**, and the gap is
   filed against A6.
5. **The graduating agent may not be given this file, the step list, or any hint derived from
   it.** It is given the goal in one sentence per scenario ("boot the TUI and get to a state where
   you can type") and must discover the mechanics from the budget in rule 3.

---

## 2. The pinned model class — read this before claiming graduation

The self-improvement loop is StepFun-only, and the original north star left the *graduating*
agent's model unconstrained. Passing with a frontier model and then saying "a CLI that agents
drive" is the single most likely false victory in this plan.

| Requirement | Value |
|---|---|
| **Pinned model class** | StepFun `step-3.7-flash` (catalog `leader` tier, 256K window) |
| **Graduation requires** | **at least one clean end-to-end run driven by `step-3.7-flash`**, 0 human interventions, 0 unnameable states |
| A run by any frontier model | recorded as a **partial result**, never as graduation |
| A run by `step-3.5-flash` | optional extra evidence; does not substitute for the `step-3.7-flash` run |
| Model of record | written into the run notes below, per attempt, with the transcript path |

**Run-note requirement from §3.4.** The GSD mutation gate fails open on `depth: null`, so it is
structurally inert for a fresh worktree. Each graduation attempt must record which option was
taken — **(a)** `STATE.md` reset to a known depth and the gate relied on, or **(b)**
`MUONROI_GSD_HARD_GATE=0` with the gate plainly declared off. An attempt that records neither is
not a valid attempt.

---

## 3. The scenarios

All observations below were captured on 2026-09-05 against `bun run src/index.ts mcp-driver`
driving a TUI spawned with `--agent-mode --mock-llm tests/harness/fixtures/llm` in a fresh temp
cwd, on Windows (named-pipe transport).

### S1 — Boot to a composer you can type into

Goal given to the agent: *"Start the TUI and get to a state where you can type a prompt."*

The trap in this scenario is **S1.3**, and it is the obvious path: `tui.start` → `tui.wait_for
{idle:true}` → `tui.query "id=composer"`. `idle` fires on an empty frame, so the query returns
`null` and the driver cannot tell "not rendered yet" from "there is no composer". The step that
works is S1.2 — wait on the *selector*, not on idle.

```json
{
  "id": "S1",
  "title": "Boot to a composer you can type into",
  "steps": [
    {
      "id": "S1.1",
      "action": "tui.start with args ['--agent-mode'], a temp cwd and the mock-llm fixtures dir",
      "via": "tui.start",
      "discriminatingField": { "kind": "tool-result", "tool": "tui.start", "field": "pid", "via": "tui.start" },
      "decisionField": { "kind": "tool-result", "tool": "tui.start", "field": "ok", "via": "tui.start" }
    },
    {
      "id": "S1.2",
      "action": "tui.wait_for { selector: 'id=composer', timeoutMs: 60000 } — wait on the SELECTOR, not on idle",
      "via": "tui.wait_for",
      "discriminatingField": { "kind": "node", "selector": "id=composer role=textbox", "field": "role", "via": "tui.query" },
      "decisionField": { "kind": "node", "selector": "id=composer", "field": "focus", "via": "tui.query" }
    },
    {
      "id": "S1.3",
      "action": "tui.wait_for { idle: true } straight after tui.start, then tui.query 'id=composer'",
      "via": "tui.wait_for",
      "discriminatingField": { "kind": "node", "selector": "id=composer", "field": "role", "via": "tui.query" },
      "decisionField": { "kind": "node", "selector": "id=composer", "field": "focus", "via": "tui.query" },
      "knownFailing": true,
      "knownFailingEvidence": "2026-09-05, reproduced 4/4 (three consecutive start/idle/snapshot cycles in one dedicated probe, plus an earlier independent run): tui.wait_for {idle:true} returned 'ok' while tui.snapshot was {\"mode\":\"live\",\"seq\":0,\"nodes\":[]} and tui.capabilities reported semantics.nodeCount 0, source 'live-frame'. tui.query 'id=composer' returned null, tui.query_all 'focus' returned [], tui.render_text returned an empty string. The same session then returned {\"id\":\"composer\",\"role\":\"textbox\",\"value\":\"\",\"focus\":true} once the driver waited on the selector instead. idle therefore does not mean 'laid out', and a driver that trusts it sees a state it cannot name."
    },
    {
      "id": "S1.4",
      "action": "read the status bar to learn which provider/model the session will use",
      "via": "tui.query",
      "discriminatingField": { "kind": "node", "selector": "id=status role=statusbar", "field": "value", "via": "tui.query" },
      "decisionField": { "kind": "node", "selector": "id=status", "field": "value", "via": "tui.query" }
    }
  ]
}
```

Observed at S1.4: `{"id":"status","role":"statusbar","value":"stepfun/step-3.7-flash OK"}`.

### S2 — Send a prompt and confirm the CLI took it

Goal: *"Send the prompt 'hello harness' and confirm the CLI accepted it."*

Two discriminators matter here and they are different: **that the text landed in the composer**
(`id=composer` `value`) and **that the turn is working rather than hung**
(`id=council-rail-now` `props.liveness` / `props.waiting`). The second is the field that tells
*waiting* from *working* from *hung* without reading the screen.

```json
{
  "id": "S2",
  "title": "Send a prompt and confirm the CLI took it",
  "steps": [
    {
      "id": "S2.1",
      "action": "tui.type 'hello harness', then re-read the composer",
      "via": "tui.type",
      "discriminatingField": { "kind": "node", "selector": "id=composer", "field": "value", "via": "tui.query" },
      "decisionField": { "kind": "node", "selector": "id=composer", "field": "value", "via": "tui.query" }
    },
    {
      "id": "S2.2",
      "action": "tui.press 'Enter' and wait for the prompt to appear in the transcript",
      "via": "tui.wait_for",
      "discriminatingField": { "kind": "node", "selector": "role=listitem", "field": "name", "via": "tui.query_all" },
      "decisionField": { "kind": "node", "selector": "id=log", "field": "props.locked", "via": "tui.query" }
    },
    {
      "id": "S2.3",
      "action": "decide whether the turn is working, waiting on a human, or hung",
      "via": "tui.query",
      "discriminatingField": { "kind": "node", "selector": "id=council-rail-now", "field": "props.liveness", "via": "tui.query" },
      "decisionField": { "kind": "node", "selector": "id=council-rail-now", "field": "props.waiting", "via": "tui.query" }
    }
  ]
}
```

Observed at S2.1 after a 600 ms settle: `{"id":"composer","role":"textbox","value":"hello harness","focus":true}`.
Read with no settle, the same query returned `value: ""` while the text had in fact landed — the
frame had not been re-emitted yet. Observed at S2.2:
`[{"id":"msg-0","role":"listitem","name":"user:hello harness"}]`. Observed at S2.3 while the turn
was blocked on a human: `props` = `{"liveness":"waiting","streamedChars":0,"lastDeltaAgeMs":-1,"alive":false,"waiting":true}`.

### S3 — Answer an askcard without reading the screen

Goal: *"The run has stopped. Find out why, and answer whatever it is asking."*

This is the scenario the plan cares most about: a modal pause writes no DB row, so "waiting for a
human" and "hung" are the same observation to anything but the event stream. Both channels carry
it — `tui.last_event {kind:'askcard-open'}` returns the full question, and the semantic tree
carries `id=askcard` (`role=dialog`, focused, modal) with one `role=button` child per option and
`selected` on the default.

```json
{
  "id": "S3",
  "title": "Answer an askcard without reading the screen",
  "steps": [
    {
      "id": "S3.1",
      "action": "tui.wait_for { event: 'askcard-open' } and read the question text",
      "via": "tui.wait_for",
      "discriminatingField": { "kind": "event", "eventKind": "askcard-open", "field": "question", "via": "tui.last_event" },
      "decisionField": { "kind": "event", "eventKind": "askcard-open", "field": "optionCount", "via": "tui.last_event" }
    },
    {
      "id": "S3.2",
      "action": "locate the card in the semantic tree and confirm it owns the keyboard",
      "via": "tui.query",
      "discriminatingField": { "kind": "node", "selector": "id=askcard role=dialog", "field": "name", "via": "tui.query" },
      "decisionField": { "kind": "node", "selector": "id=askcard", "field": "focus", "via": "tui.query" }
    },
    {
      "id": "S3.3",
      "action": "list the options and find which one is currently selected",
      "via": "tui.query_all",
      "discriminatingField": { "kind": "node", "selector": "role=button", "field": "name", "via": "tui.query_all" },
      "decisionField": { "kind": "node", "selector": "role=button", "field": "selected", "via": "tui.query_all" }
    },
    {
      "id": "S3.4",
      "action": "press_sequence to move the selection, press Enter, and confirm which answer was recorded",
      "via": "tui.press_sequence",
      "discriminatingField": { "kind": "event", "eventKind": "askcard-answered", "field": "answerText", "via": "tui.last_event" },
      "decisionField": { "kind": "event", "eventKind": "askcard-answered", "field": "answerKind", "via": "tui.last_event" }
    }
  ]
}
```

Observed at S3.1: `{"kind":"askcard-open","questionId":"8caa…","question":"What do you want to build?","phase":"pil-interview","optionCount":5,"defaultIndex":0}`.
Observed at S3.4 after `Down Down Down Enter`:
`{"kind":"askcard-answered","questionId":"7f55…","answerKind":"choice","answerText":"Cancel my request"}`.

**Note for a driver, and a genuinely good piece of legibility:** `tui.focus` on an askcard option
is *refused with an explanation* rather than silently doing nothing —
`{"error":"not_focusable","focusHolder":"askcard","message":"…This surface does not accept
programmatic focus — drive it with press()/press_sequence() instead."}`. The error payload names
both the real focus holder and the remedy, which is why S3.4 uses `press_sequence`.

### S4 — See the turn end, and know whether it succeeded

Goal: *"Wait for the turn to finish and report what the assistant said."*

```json
{
  "id": "S4",
  "title": "See the turn end, and know whether it succeeded",
  "steps": [
    {
      "id": "S4.1",
      "action": "tui.wait_for { event: 'llm-done' } and read how the turn ended",
      "via": "tui.wait_for",
      "discriminatingField": { "kind": "event", "eventKind": "llm-done", "field": "finishReason", "via": "tui.last_event" },
      "decisionField": { "kind": "event", "eventKind": "llm-done", "field": "totalChars", "via": "tui.last_event" }
    },
    {
      "id": "S4.2",
      "action": "read the assistant's reply out of the transcript",
      "via": "tui.query_all",
      "discriminatingField": { "kind": "node", "selector": "role=listitem", "field": "name", "via": "tui.query_all" },
      "decisionField": { "kind": "node", "selector": "id=council-rail-now", "field": "props.alive", "via": "tui.query" }
    },
    {
      "id": "S4.3",
      "action": "check whether the turn reported an error the driver must act on",
      "via": "tui.last_event",
      "discriminatingField": { "kind": "event", "eventKind": "toast", "field": "level", "via": "tui.last_event" },
      "decisionField": { "kind": "event", "eventKind": "toast", "field": "level", "via": "tui.last_event" }
    }
  ]
}
```

Observed at S4.1: `{"kind":"llm-done","correlationId":"759877fb…","totalChars":882,"finishReason":"stop"}`.
Observed at S4.2: `[{"id":"msg-0","role":"listitem","name":"user:hello harness"},{"id":"msg-1","role":"listitem","name":"assistant:[…"}]`.

### S5 — Stop cleanly, and be able to tell that you did

Goal: *"Shut the TUI down and confirm nothing is left running."*

**S5.1 is the second known-failing step.** `tui.stop` returns the bare sentinel `"ok"` — a string,
not a named field — and it returns it whether or not anything was running. The driver's only real
discriminator, the pid from `tui.start` checked with `process.kill(pid, 0)`, lives outside the MCP
surface entirely, so a capabilities-only agent cannot reach it.

```json
{
  "id": "S5",
  "title": "Stop cleanly, and be able to tell that you did",
  "steps": [
    {
      "id": "S5.1",
      "action": "tui.stop, then determine from the response alone whether a TUI was stopped",
      "via": "tui.stop",
      "discriminatingField": { "kind": "tool-result", "tool": "tui.stop", "field": "ok", "via": "tui.stop" },
      "decisionField": { "kind": "tool-result", "tool": "tui.stop", "field": "ok", "via": "tui.stop" },
      "knownFailing": true,
      "knownFailingEvidence": "2026-09-05: tui.stop returned the bare string 'ok' in a session where the child had ALREADY exited and every other tool was answering {\"error\":\"no_driver\",\"message\":\"Call tui.start first\"}. The success payload is a sentinel with no named field, so 'I stopped a TUI', 'there was nothing to stop' and 'the child died on its own earlier' are one indistinguishable response. (The kill itself works — 0 orphans across every cycle measured this session — so this is a legibility defect, not the pre-Phase-0 orphan defect.)"
    },
    {
      "id": "S5.2",
      "action": "confirm the driver is really gone by asking for a snapshot",
      "via": "tui.snapshot",
      "discriminatingField": { "kind": "tool-result", "tool": "tui.snapshot", "field": "error", "via": "tui.snapshot" },
      "decisionField": { "kind": "tool-result", "tool": "tui.snapshot", "field": "error", "via": "tui.snapshot" }
    }
  ]
}
```

Observed at S5.2 after a stop: `{"error":"no_driver","message":"Call tui.start first"}` — which is
the field that actually discharges "it stopped", and it is on a different tool than the one the
driver just called.

### S6 — Describe yourself well enough to be driven

Goal: *"Using only what the server tells you about itself, list every tool you can call and every
event kind you can wait on."*

This scenario is what makes A6 independently checkable: it is a static diff, computable without
running any of the other scenarios, so A6 and the graduation test do not resolve to each other.

```json
{
  "id": "S6",
  "title": "Describe yourself well enough to be driven",
  "steps": [
    {
      "id": "S6.1",
      "action": "call tui.capabilities and compare its tool list against the tools/list handshake",
      "via": "tui.capabilities",
      "discriminatingField": { "kind": "capability", "field": "tools", "via": "tui.capabilities" },
      "decisionField": { "kind": "capability", "field": "toolsSource", "via": "tui.capabilities" }
    },
    {
      "id": "S6.2",
      "action": "recover the event vocabulary a wait_for/last_event call may name",
      "via": "tui.capabilities",
      "discriminatingField": { "kind": "capability", "field": "eventKinds", "via": "tui.capabilities" },
      "decisionField": { "kind": "capability", "field": "roles", "via": "tui.capabilities" }
    },
    {
      "id": "S6.3",
      "action": "construct one valid selector from the advertised grammar alone",
      "via": "tui.capabilities",
      "discriminatingField": { "kind": "capability", "field": "selector", "via": "tui.capabilities" },
      "decisionField": { "kind": "capability", "field": "eventLogPath", "via": "tui.capabilities" }
    }
  ]
}
```

Measured 2026-09-05: `tools/list` returned 21 tools; `tui.capabilities.tools` returned the same 21
with `toolsSource: "registrar"`; `eventKinds` 22; `roles` 33; `selector.fields`
`["id","role","name","value","state"]`; `selector.flags` `["focus","selected","disabled"]`.
So A6's mechanical proxy passes today, and S6.3 is constructible from the payload alone.

---

## 4. What this corpus does NOT measure

Stated so nobody mistakes a 100% for the north star:

- **It cannot show that no blind state exists.** It shows that these steps are nameable and
  observed. A1's target of `0` blind states was unreachable in principle and was restated for
  exactly this reason (§1.1). Growing the corpus is the only way to strengthen the claim.
- **It cannot tell "the driver needed the scrape" from "the driver used it."** A4 is scored as
  the positive assertion — the decision field exists in structured output — never as "the scrape
  did not happen."
- **It does not cover `/ideal`, council debate, or any multi-sprint flow.** Those depend on
  P0-1/P0-5b and on a live provider. Add them as `S7…` once they run unattended, and mark them
  `knownFailing` until they do rather than leaving them out.
- **It says nothing about visual quality.** `tui.visual_quality` returned `null` with no driver
  attached in this session; it is not part of any step here.

---

## 5. Run notes (append one block per attempt — never edit a previous block)

| # | date | agent model | interventions | unnameable states | GSD gate (§3.4) | verdict | transcript |
|---|------|-------------|---------------|-------------------|-----------------|---------|------------|
| — | — | — | — | — | — | *no attempt yet* | — |

A row with a frontier model in the `agent model` column is a **partial result**. Graduation needs a
row whose model is `step-3.7-flash`, whose `interventions` and `unnameable states` are both `0`,
and whose `GSD gate` cell names (a) or (b).

### GSD gate — decision of record: **(a) rely on the gate, from a reset `STATE.md`**

Every row's `GSD gate` cell should read `(a)` unless that attempt deliberately sets
`MUONROI_GSD_HARD_GATE=0`, in which case it reads `(b)`.

`SELF-IMPROVEMENT-PLAN.md` §3.4 assumed "a fresh worktree lacking plan artifacts yields
`depth: null`", making the gate structurally inert for sprints. **Measured, that premise is wrong
in a way that matters, and wrong in a way that does not:**

- `depth` is **not** null when the gate runs. `evaluateMutationGate` is called from the tool wrapper
  in `tool-engine.ts:1363`, reached via `executeToolEngine` (`message-processor.ts:1414`), which is
  strictly after `syncWorkflowContext` (`message-processor.ts:800`) in the same turn. That call
  cannot pass null: `message-processor.ts:737` is
  `pilCtx.modelDepthTier ?? pilCtx.complexityTier ?? "standard"`. Measured on a fresh worktree —
  `readState().depth` is `null` at checkout, `"standard"` immediately after
  `ensurePlanningWorkspace`, and exactly the value passed for each of `quick`/`standard`/`heavy`.
- What *was* inert is different and worse: a worktree used to **inherit a stale run's phase**.
  `.planning/STATE.md` was tracked, so every worktree started at
  `{depth:"standard", phase:"plan", planVerified:false}` — carrying `| Ideal Run | mrq8mesr0389 |`,
  another run's state. At `heavy` that makes `canExecute` refuse with
  `STATE.md phase is "plan"` before the sprint has done anything.

`.planning/STATE.md` is now untracked (see `docs/planning/README.md`), so a sprint worktree has no
`STATE.md` and `ensurePlanningWorkspace` writes `DEFAULT_STATE_MD` — `Depth: standard`,
`Phase: discuss`, `Plan Verified: no`. That is option (a)'s "reset `STATE.md` to a known value at
worktree creation", obtained structurally rather than as a bootstrap step someone can forget.

**The gate is therefore live, and still advisory below `heavy` by design.** That is deliberate
(`mutation-gate.ts:33-42`), not a defect: a sprint only gets the hard plan-review requirement when
layer-1 classify or the leader-tier assessor rates it `heavy`. A sprint that must be plan-gated has
to be *classified* `heavy` — do not read a `standard` sprint's unblocked edits as the gate failing.
