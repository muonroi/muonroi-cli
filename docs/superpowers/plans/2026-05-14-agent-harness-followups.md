# Agent Harness — Follow-up Plan (post-Phase-9)

**Date:** 2026-05-14
**Status:** Proposed
**Base:** master @ `622f9b0` (Phase 0–9 complete, harness drives composer + slash menu end-to-end on POSIX)

## Goal

Close the remaining gaps so the agent can drive **every** interactive TUI feature
(askcard prompts, council multi-round flow, `/ideal` workflow, modal forms) as a
real user — without humans-in-the-loop, deterministic across runs.

## Gap Summary

| # | Gap | Blocks | Effort |
|---|-----|--------|--------|
| G1 | `AskCard` not wrapped in `<Semantic>` | every modal prompt (council askcard, `/ideal` confirmations, exit-confirm, etc.) | S |
| G2 | Mock-LLM fixture matches once per spec | multi-round flows (council, ideal, any agentic loop) | M |
| G3 | `/ideal` modal + phase cards not wrapped + no E2E spec | verifying `/ideal` feature | S |
| G4 | Remaining modals unwrapped (`SubagentsBrowserModal`, `McpModal`, `SubagentEditorModal`, `ApiKeyModal`, project picker) | verifying subagent / MCP flows | M |
| G5 | No `<Semantic>` lint/guard | regressions when devs add new TUI without wrapping | S |
| G6 | Windows fd3/4 → named pipes | running harness from Windows (currently requires WSL hop) | L |
| G7 | `props.scrollTop` mirrored on listboxes | `scroll.spec.ts` todo | S |
| G8 | Toast emit on LLM error path | `error-states.spec.ts` todo | S |

Effort: S ≤ 1h, M = 2–4h, L = ½ day+

## Phases

### Phase A — AskCard + `/ideal` (unblocks fastest user value)

Tasks executable in sequence; each can be one PR.

**A.1 — Wrap `AskCard` with Semantic** *(S)*
- Files: `src/ui/components/AskCard.tsx` (and wherever it's rendered — likely from council orchestrator + ideal phase + exit flow)
- Outcome:
  ```tsx
  <Semantic id={`askcard-${promptKey}`} role="dialog" name={title} isModal>
    {options.map((opt, i) => (
      <Semantic
        key={opt.value}
        id={`askcard-option-${opt.value}`}
        role="button"
        name={opt.label}
        selected={i === activeIndex}
      >
        <Option ... />
      </Semantic>
    ))}
  </Semantic>
  ```
- Test: `tests/harness/askcard.spec.ts` — spawn TUI with mock-llm fixture that triggers an askcard via a slash command (or synthetic dispatch), assert `driver.query("id=askcard-...")`, press Down/Enter, verify selected flips.

**A.2 — Wrap `/ideal` modal + phase cards** *(S)*
- Files: `src/ui/ideal-*.tsx` (or wherever `/ideal` renders)
- Outcome: `id="ideal-modal"`, `id="ideal-phase-{n}"` `role="region"`, info cards as `role="listitem"`.

**A.3 — Write `tests/harness/ideal.spec.ts`** *(S)*
- Pattern: copy `composer.spec.ts`; type `/ideal build a counter`, wait for `id=ideal-modal`, assert first phase visible, accept/advance through phases using fixture from A.4.

**A.4 — Fixture `tests/harness/fixtures/llm/ideal.json`** *(S, depends on G2)*
- Defer until G2 lands; until then, `it.skip` the multi-phase assertions and keep "modal opens" + "phase 1 renders" as the real assertion.

### Phase B — Mock-LLM multi-call (G2)

**B.1 — Extend fixture schema** *(M)*
- File: `src/agent-harness/mock-llm.ts`
- Today: `responses: [{ match: string, text: string }]` — first match wins, no state.
- Change: support a `sequence: [{...}]` mode where calls are consumed in order, AND keep current `responses` for stateless matching. Detect mode by presence of `sequence` key.
- Optional: support `match: { prompt?: string, callIndex?: number }` for finer control.

**B.2 — Council fixture using sequence** *(S)*
- File: `tests/harness/fixtures/llm/council.json`
- Sequence: leader spec → participant 1 → participant 2 → debate → synthesis (5 entries).

**B.3 — Flip `it.skip("full council flow")` → real test** *(S)*
- File: `tests/harness/council-flow.spec.ts` line 88.
- Assert `id=council-phases`, `id=council-status`, at least one `id=council-msg-*` appears.

**B.4 — Flip `/ideal` multi-phase asserts** *(S, depends on A.4)*
- Add 3–4 entries to `ideal.json` for each phase's LLM call.

### Phase C — Remaining modals (G4)

Each is a 20–30 min wrap + spec. Order by user value:

**C.1 — `ApiKeyModal`** — `id="api-key-modal"` `role="dialog" isModal`, fields `id="api-key-input"` `role="textbox"`. Test: covers the fresh-clone path where today we have to bypass with `-k FAKE`.

**C.2 — `SubagentsBrowserModal`** — list as `role="listbox"`, items as `role="listitem"` with `id="subagent-{name}"` `selected`.

**C.3 — `McpModal`** — same pattern.

**C.4 — `SubagentEditorModal`** — form fields with `role="textbox"` and `value` mirrored.

**C.5 — Project picker** (if it gets rendered) — `id="project-picker"` `role="listbox"`, items `selected` flag. Re-enable `tests/harness/modal-focus.spec.ts` todo afterward.

### Phase D — Guard rails (G5, G7, G8)

**D.1 — `props.scrollTop` mirroring** *(S)* — `MessagesScrollbox` exposes scroll position; mirror onto its `<Semantic role="log">` as `props.scrollTop`. Flip `scroll.spec.ts` todo.

**D.2 — Toast on LLM error** *(S)* — `agentRuntime.emitEvent({ t:"event", kind:"toast", text:"<error>" })` in the provider error handler. Flip `error-states.spec.ts` todo.

**D.3 — Lint/guard for unwrapped TUI** *(S, optional)*
- Either a unit test that boots the TUI in `--smoke-boot-only` mode and asserts a minimum set of `<Semantic>` IDs exists, OR an eslint rule that flags new `.tsx` components under `src/ui/` without a `<Semantic>` wrapper. Pick whichever is lower-friction.

**D.4 — Update `CLAUDE.md` checklist** *(S)* — "When adding a new TUI element: ① wrap with `<Semantic>` ② add a `tests/harness/*.spec.ts` ③ run `bash scripts/wsl-test-harness.sh`".

### Phase E — Windows parity (G6, optional / deferrable)

**E.1 — Named-pipe transport** *(L)*
- Replace fd3/4 createReadStream/createWriteStream pair with `\\.\pipe\muonroi-harness-{pid}-{in|out}` on Windows.
- Parent spawns child, then creates pipes; child connects on startup; same JSONL framing.
- Risk: race between spawn and connect — handshake message required.
- Removes the `wsl` hop from local dev. Defer until WSL workflow becomes a real friction point.

## Sequencing recommendation

```
A.1 (askcard wrap) ──► A.2 (ideal wrap) ──► A.3 (ideal spec, skips on multi-phase)
       │
       └──────► C.1–C.5 (other modals, parallelizable)

B.1 (mock-llm sequence) ──► B.2 (council fixture) ──► B.3 (council unskip)
                           └► A.4 (ideal fixture)  ──► flip A.3 skips

D.1, D.2, D.3, D.4 — any time after A

E.1 — only if Windows-local becomes painful
```

**Suggested first PR slice (1 session):** A.1 + A.2 + A.3 (with skips) + D.4. Tangible: `/ideal` becomes harness-observable today, askcard-driven flows unlock everywhere, doc reflects the new checklist.

**Suggested second PR slice:** B.1 + B.2 + B.3 + A.4. Tangible: council full flow goes green; `/ideal` multi-phase goes green.

**Suggested third PR slice:** C.1 + D.1 + D.2. Tangible: api-key flow no longer needs `-k FAKE` workaround; scroll + error-state todos flip green.

## Acceptance per phase

- Phase A: `bunx vitest run tests/harness/askcard.spec.ts tests/harness/ideal.spec.ts` passes on Linux. Manual: `/ideal` and any askcard prompt verifiable from agent session via WSL one-liner.
- Phase B: `tests/harness/council-flow.spec.ts` has zero `it.skip` for the full-flow case. 10× determinism still holds.
- Phase C: each modal has ≥1 E2E spec asserting open + close + at least one interaction.
- Phase D: `scroll.spec.ts` and `error-states.spec.ts` have zero `it.todo`. CLAUDE.md updated.
- Phase E: harness specs pass natively on Windows (no `describe.skipIf`).

## Discovered during execution (2026-05-14)

### F1 — `vitest serial` config for harness suite *(DONE in Wave 2, `9a5c323`)*
Harness specs spawn a full TUI per file. Running them in vitest's default file-parallel mode under WSL causes simultaneous bun startups to time-out each other's idle waits (~15 s timeout breached by ~1–2 s of contention).
**Fix shipped:** `vitest.harness.config.ts` with `fileParallelism: false` + 60 s default test timeout. Use `bunx vitest -c vitest.harness.config.ts run tests/harness/` for E2E runs. CLAUDE.md TL;DR updated.
**Follow-up improvement queued:** consider rolling this into the main `vitest.config.ts` via a `projects:` workspace block so devs don't have to remember the `-c` flag — low priority but improves DX.

### F2 — `createCouncilLLM` bypasses mock-LLM adapter *(BLOCKER for B.3/B.4 — discovered in Wave 2)*
`src/council/llm.ts` calls `generateText` / `generateObject` (AI SDK) directly; never checks `globalThis.__muonroiMockLlm`. So even with `--mock-llm`, council + product-loop hit real providers (or fail without a real key).
**Why it matters:** without this, council-flow + ideal multi-phase tests can never flip from `it.skip` to real — the sequence fixture from Wave 2 is currently dead code for those flows.
**Fix needed (~30 min):** in `src/council/llm.ts`, before each `generateText`/`generateObject` call, check for `globalThis.__muonroiMockLlm` (the test-mode hook the adapter already uses) and short-circuit to the mock when present. Same pattern as the composer path. Same for `src/council/debate-planner.ts`.
**Add as Wave 2.5** — must precede C/D for full council/ideal coverage.

## Out of scope (explicit)

- Catalog.json bundling into compiled binary (orthogonal infra concern).
- Replacing OpenTUI / changing render pipeline.
- Visual regression / screenshot diffing (not the harness's goal; selectors are the contract).
- Real-LLM-driven E2E (cost + non-determinism — use mock-llm fixtures).

## References

- CLAUDE.md (operating manual for the harness)
- docs/superpowers/specs/2026-05-14-agent-harness-design.md
- docs/superpowers/plans/2026-05-14-agent-harness.md (the executed plan)
- docs/agent-harness/PROTOCOL.md
