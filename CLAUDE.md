# CLAUDE.md — Agent harness verification workflow

> Project context lives in `AGENTS.md`. This file is the **operating manual** for verifying TUI features end-to-end via the agent harness (`packages/agent-harness-core/`, in-repo shim at `src/agent-harness/index.ts`, MCP server at `packages/agent-harness-core/src/mcp-server.ts`).
> If you are a new agent session starting work on `muonroi-cli`, read this top-to-bottom before writing E2E tests or debugging harness failures.

## Zero Hardcode Rule — Model & Provider IDs

**NEVER** hardcode model IDs (`"claude-sonnet-4-6"`, `"gpt-4o"`, `"deepseek-v4-flash"`) or provider IDs (`"anthropic"`, `"openai"`, `"deepseek"`) as string literals in production code. All model/provider references MUST derive from:

- **`catalog.json`** (`src/models/catalog.json`) — single source of truth for available models
- **User settings** — `getCurrentModel()`, `getDefaultProvider()` from `src/utils/settings.ts`
- **Runtime detection** — `detectProviderForModel(modelId)` from `src/providers/runtime.ts`
- **Catalog lookup** — `getModelByTier()`, `getModelsForProvider()` from `src/models/registry.ts`

If a model/provider cannot be resolved from these sources, **throw an error** — do NOT fall back to a hardcoded string like `?? "anthropic"`. The only acceptable string literals are in:
- Type union definitions (`type ProviderId = "anthropic" | "openai" | ...`)
- Test fixtures and test assertions
- `catalog.json` itself
- `pricing.ts` static reference pricing table (read-only data, not routing decisions)

## TL;DR

```powershell
# Primary path — run natively on Windows (no WSL required):
bunx vitest -c vitest.harness.config.ts run tests/harness/
```

## Self-QA workflow (UI / harness changes — IMPORTANT)

> Unit tests cover function-level logic. They DO NOT cover modal lifecycle,
> slash-menu navigation, askcard flow, focus chain, or toast levels. When you
> modify any of these surfaces you MUST also run `self-verify`.

**Watched surfaces** (pre-push hook auto-triggers Tier 1 on these):
- `src/ui/**/*.tsx`, `src/ui/**/*.ts`
- `src/self-qa/**/*.ts`
- `src/agent-harness/**/*.ts`
- `packages/agent-harness-opentui/**/*.ts`

**Tier 1 — heuristic, free, fast (~30s)**:
```powershell
bun run src/index.ts self-verify --since HEAD~1 --max 4
```
Reads git diff, finds touched Semantic IDs, drives the inner CLI through
template scenarios (textbox/button/dialog/menu/list), judges pass/fail with
rules. Emits `tests/harness/auto/*.spec.ts` for every passing scenario —
those become permanent regression specs.

**Tier 2 — LLM-in-the-loop, ~$0.01, ~30s-2min**:
```powershell
bun run src/index.ts self-verify --agentic `
  --goal "<narrate the user-visible flow you just changed>" `
  --llm "deepseek-v4-flash" --turns 8
```
Outer LLM reads the semantic tree + event tail every turn, decides next
action (type / press / wait_for / done), observes outcome. Catches
intent-vs-reality mismatches that scripted tests cannot express.

**Pre-push gate**: `.husky/pre-push` runs Tier 1 automatically when a
push touches watched surfaces. Skip with `git push --no-verify` or
`SELF_VERIFY_PRE_PUSH=0 git push`.

**PostToolUse hook (Claude Code only)**: `.claude/settings.json` wires
`.claude/hooks/self-qa-post-edit.cjs` to fire AFTER every Edit/Write/MultiEdit
on a watched surface — even during an interactive Claude session, before any
commit. The hook spawns Tier 1 detached so the agent doesn't block; result
lands at `.claude/self-qa-last.json` (~30s later). 60s throttle prevents
spam during rapid edits. Disable: `$env:SELF_QA_POST_EDIT="0"` or delete the
hook file. The agent can read the result file at any time to see whether its
recent edit broke a scenario.

**Tier 3 — sprint pipeline gate (default ON in local dev)**: when `/ideal`
runs, after the verification recipe PASSES, sprint-runner auto-fires Tier 1
self-verify against UI/harness surfaces touched in this sprint. A
self-verify failure downgrades the sprint verdict to FAIL so the loop
iterates again with the failure context in `verifyResult.error`.
Auto-disabled when `CI=true` or `NODE_ENV=ci`. Disable locally with
`$env:MUONROI_SPRINT_SELF_VERIFY="0"` (PowerShell) or
`MUONROI_SPRINT_SELF_VERIFY=0 bun run src/index.ts ...` (POSIX).
Module: `src/product-loop/sprint-self-verify.ts`. Hook point:
`src/product-loop/sprint-runner.ts` (after `parseVerifyResult`).

**Parallel with TUI**: self-verify spawns its own child via unique
named-pipe per pid+uuid — no conflict with a live TUI session. Run it
in a second terminal while you develop.

**EE behavioral rule**: `docs/self-qa/ee-rule-seed.json` — ingest into
`muonroi-cli-behavioral` collection so every agent (Claude / Codex /
Gemini) gets a high-confidence reminder when they touch a watched
surface.

When in doubt: if your change affects what a user SEES or CLICKS,
self-verify covers blind spots vitest cannot reach.

---

```bash
# Fallback / CI verification — run from WSL (POSIX fd 3/4 path):
wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest -c vitest.harness.config.ts run tests/harness/'
# vitest.harness.config.ts sets fileParallelism:false — prevents idle-timeout contention
# when multiple TUI processes spawn under WSL simultaneously.
```

## Why this exists

The agent harness lets external CLIs (`claude`, `codex`, `gemini`) drive the TUI as a real user via structured JSON — no screenshots, no OCR.

**Transport**: POSIX uses `fd 3`/`fd 4` sidechannels; Windows uses named pipes (`\\.\pipe\muonroi-harness-{pid}-{uuid}-{in|out}`). Both paths are verified by `tests/harness/**`. The helper in `src/agent-harness/test-spawn.ts` selects the right transport automatically; spec files have no platform guards.

The WSL workflow remains documented below as a fallback for CI environments that don't support named pipes or for comparing POSIX vs Windows behaviour.

Core components (post Phase 6 multi-package split — see "Multi-framework package layout" below):
- `packages/agent-harness-core/src/protocol.ts` — `LiveFrame` / `LiveEvent` / `UINode` / `DesignSpec` (protocol v0.4.0)
- `packages/agent-harness-core/src/selector.ts` — `parseSelector`, `matchSelector` (CSS-like grammar)
- `packages/agent-harness-core/src/predicate.ts` — Zod-typed predicate evaluator
- `packages/agent-harness-core/src/driver.ts` — in-process `Driver` API
- `packages/agent-harness-core/src/mcp-server.ts` — `createMcpHarnessServer`, 16 `tui.*` tools over stdio MCP (Windows + POSIX)
- `packages/agent-harness-opentui/src/semantic.tsx` — `<Semantic id="..." role="...">` React wrapper
- `packages/agent-harness-opentui/src/reconciler-hook.ts` — `SemanticRegistry`, snapshot to `LiveFrame`
- `packages/agent-harness-opentui/src/agent-mode.ts` — Windows named-pipe + POSIX fd 3/4 transport
- `src/agent-harness/test-spawn.ts` — cross-platform spawn helper used by spec files
- `src/agent-harness/mock-model.ts` — `MockLanguageModelV3` install hook for provider-layer tests
- `src/index.ts:1403` — CLI wiring for `mcp-driver` subcommand
- `tests/harness/` — E2E specs (no platform guards — run on Windows and POSIX via `test-spawn.ts`)
- `tests/harness/helpers.ts` — shared `spawnHarness()` helper used by all spawn-based specs
- Imports inside this repo go through the in-repo shim `src/agent-harness/index.ts` which re-exports from `@muonroi/agent-harness-core` + `@muonroi/agent-harness-opentui`

## BB-aware `/ideal`

When the scaffold target resolves to `muonroi-building-block` (BB) — i.e., presence of `Directory.Build.props` + `*.sln` + any `src/Muonroi.*` directory — `/ideal` injects BB-specific context into the council system prompt at CB-1. Key files:

- `src/ee/bb-retrieval.ts` — `fetchBBContext(prompt, opts)` queries EE collections `bb-recipes`, `bb-behavioral`, `experience-principles` in parallel with retry-once + graceful degrade. Token budget 1500. Marker-stamped output for Layer 3 dedup.
- `src/product-loop/loop-driver.ts` — CB-1 entry point that injects the retrieved BB context BEFORE council debate fires.
- `src/pil/layer3-ee-injection.ts` — scans `ctx.enriched` for `<!-- bb-context-injected:<sha> -->` markers and skips already-injected hits.
- `src/pil/layer3-ee-injection.ts` (ee-anti-mu) — also extracts `<!-- ee-checkpoint-injected:<sha> -->`, injects formatTaskCheckpoints from behavioral search for "Context checkpoint summary", enriches layer1 raw for long sessions, and supports ee.query (MCP) for explicit "recent task checkpoint Progress DONE".
- `src/scaffold/init-new.ts` — detects BB target heuristically, sets `IntentDetectionTrace.targetFramework = "muonroi-building-block"`.
- `src/scaffold/bb-ecosystem-apply.ts` — applies senior-bar code-gen (Program.cs wiring, sample rule + test, props minimalism, modular-boundaries gate).
- `src/scaffold/bb-quality-gate.ts` — runs `dotnet restore` + `dotnet build` + `check-modular-boundaries.ps1` + sentinel regex check after scaffold.
- `src/scaffold/resume-from-gate-failures.ts` — `/ideal --resume <path>` re-enters CB-1 with `EE-GATE-FAILURES.md` context.

Ingestion + collection layout: `docs/agent-harness/EE-INGESTION.md`.

EE failure-mode reference (what every call site does when EE is down):
`docs/ee/EE-DOWN-BEHAVIOR.md`.

Feature flag: `userSettings.eeBBContext: false` to disable BB retrieval.

## Native GSD depth pipeline & the hard mutation gate

GSD is **native to the runtime**, not the external superpowers skill. Depth is
agent-decided and variable — `quick` | `standard` | `heavy` | (none) — and every
stage consumes the prior stage's artifact, so the flow is one continuous pipeline
built on the GSD SDK (`src/gsd/`), never a workaround around it.

**The one depth slot everything reads.** layer1 model-first classify emits
`pilCtx.modelDepthTier` + `pilCtx.confidence` (`src/pil/layer1-intent.ts`) →
`syncWorkflowContext(cwd, model, depth)` in `src/orchestrator/message-processor.ts`
→ SDK `setStateField` writes `Depth` into `.planning/STATE.md`. Downstream code
reads depth via `readState(cwd).depth`, never off a propagated pilCtx field.

**Pipeline stages (each feeds the next):**

1. **Complexity assessor** (`src/gsd/complexity-assessor.ts`) — a leader-tier
   single-shot call (`createCouncilLLM(...).generate`, billed `source=council`,
   no cost leak) that *enriches the same* `modelDepthTier` slot. `shouldAssess`
   pre-filters: standard/heavy always assess, low-confidence (<0.7) quick
   assesses, high-confidence quick skips. NEVER throws (parse/leader failure →
   `parse-failed-fallback`). Writes `.planning/ASSESSMENT.md`.
2. **Council context** (`src/gsd/council-context.ts`) folds `ASSESSMENT.md`
   into `buildCouncilContextBundle`, so plan-review AND verify councils both see
   the assessment rationale — pipeline coherence.
3. **Directive** (`src/pil/layer4-gsd.ts`) is keyed on the *assessed* depth:
   heavy → MANDATORY `gsd_status → gsd_discuss → gsd_plan → gsd_plan_review`,
   mutation tools BLOCKED until plan-review passes; standard → advisory
   ("recommend gsd_plan_review", no BLOCKED); quick → no gate.
4. **Mutation gate** (`src/gsd/mutation-gate.ts`) — `evaluateMutationGate` runs
   inside the tool-engine write-mutex wrapper (`src/orchestrator/tool-engine.ts`)
   before every non-read-only, non-`respond_`, non-`gsd_*` tool. It reads depth
   from `readState(cwd).depth` and **delegates to the SDK's `canExecute(cwd,
   depth)`** — no reimplemented gate. Fail-open: only explicit `standard`/`heavy`
   arm it; `null`/`quick` pass through. Blocked → `{success:false, output, error}`
   BEFORE the mutation runs.
5. **Verify layer** (`gsd_verify` in `src/gsd/workflow-tools.ts`) — deterministic
   floor first (tests/lint evidence); if the floor passes at standard/heavy,
   `runVerifyCouncil` (`src/gsd/verify-council.ts`) adjudicates goal-achievement
   and its verdict **overrides** the model's self-reported `passed`. Parse
   failure → `revise`, never a silent approve. Writes `.planning/VERIFY-COUNCIL.md`.

**Env flags** (all default ON with native GSD; opt out with `=0`), defined in
`src/gsd/flags.ts`:

| Flag | Effect |
|---|---|
| `MUONROI_GSD_NATIVE=0` | Disable native GSD entirely → legacy playbook rubric, no `gsd_*` tools. |
| `MUONROI_GSD_ASSESSOR=0` | Skip the leader-tier assessor; depth comes only from layer1 classify. |
| `MUONROI_GSD_HARD_GATE=0` | Disable the mutation gate; directives become advisory-only. |

E2E coverage of the deterministic gate: `tests/harness/gsd-hard-gate.spec.ts`
(seeds `.planning/STATE.md` in a throwaway temp cwd; assessor OFF for
determinism). Gate/assessor/verify logic is unit-covered under `src/gsd/__tests__/`.

## Workflow: verify a new TUI feature

When you add a new TUI component or behavior and want to verify it as a real user would experience it:

### 1. Add semantic instrumentation
Wrap user-visible elements with `<Semantic>`:

```tsx
import { Semantic } from "../agent-harness/semantic.js";

<Semantic id="my-feature-modal" role="dialog" name="Project picker" isModal>
  <ProjectPickerModal ... />
</Semantic>
```

Required fields: `id` (unique), `role` (from `Role` union in `protocol.ts`). Optional: `name`, `value`, `focus`, `selected`, `disabled`, `state`, `props`, `isModal`.

**Semantic is invisible** — it renders only React Context, no OpenTUI element. Zero layout/runtime cost when `agentRuntime` is unset (normal user mode).

Already wired (Phase 7, commit `8f55bbb`):
- `id="composer"` `role="textbox"` (PromptBox textarea)
- `id="status"` `role="statusbar"` (StatusBar)
- `id="log"` `role="log"` (messages scrollbox)
- `id="msg-{i}"` `role="listitem"` (each MessageView)
- `id="slash-menu"` `role="menu"` `isModal` (SlashInlineMenu)
- `toast` events on LLM error (via `agentRuntime.emitEvent`)

### 2. Write a fixture for the mock-LLM (if your feature talks to a model)

```json
// tests/harness/fixtures/llm/my-feature.json
{
  "responses": [
    { "match": "build a counter", "text": "Here is a counter:\n```ts\nlet n = 0\n```" },
    { "match": "*", "text": "Default reply" }
  ]
}
```

Match priority: exact substring first, then `*` wildcard.

### 3. Write an E2E spec following the composer pattern

```ts
// tests/harness/my-feature.spec.ts
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver } from "../../src/agent-harness/driver";
import type { LiveEvent, LiveFrame } from "../../src/agent-harness/protocol";
import { createLineSplitter } from "../../src/agent-harness/sidechannel";

describe.skipIf(process.platform === "win32")("my-feature E2E", () => {
  let proc: ChildProcess;
  let driver: ReturnType<typeof createDriver>;

  beforeAll(async () => {
    const entry = resolve("src/index.ts");
    const fix = resolve("tests/harness/fixtures/llm");
    proc = spawn("bun", ["run", entry, "--agent-mode", "--mock-llm", fix], {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });

    driver = createDriver({
      sendKey: (k) => proc.stdio[4]?.write(JSON.stringify({ op: "press", key: k }) + "\n"),
      sendType: (t) => proc.stdio[4]?.write(JSON.stringify({ op: "type", text: t }) + "\n"),
    });

    const splitter = createLineSplitter((line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.mode === "live") driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
        else if (msg.t === "idle") driver._ingest({ kind: "idle" });
        else if (msg.t === "event") driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
      } catch {}
    });
    proc.stdio[3]?.on("data", (chunk: Buffer | string) =>
      splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 20_000);

  afterAll(() => { proc?.kill(); });

  it("renders my feature", async () => {
    driver.type("/my-feature");
    driver.press("Enter");
    await driver.wait_for({ selector: 'id=my-feature-modal', timeoutMs: 5000 });
    expect(driver.query('id=my-feature-modal')?.name).toBe("Project picker");
  });
});
```

### 4. Run from WSL

```bash
wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest run tests/harness/my-feature.spec.ts'
```

If passing on WSL but the CI pipeline differs, also test on actual Linux/macOS in the matrix.

## Driver API cheat sheet

```ts
driver.snapshot()                       // current LiveFrame or null
driver.query("role=textbox")            // single UINode or null; throws if >1 match
driver.queryAll("role=listitem")        // UINode[]
driver.count("role=listitem")           // number
driver.expect("id=foo", { field: "value", op: "eq", rhs: "bar" })  // boolean
driver.press("Enter")                   // single key
driver.press_sequence(["Down", "Down", "Enter"])
driver.type("hello")                    // literal text
driver.focus("id=composer")             // dispatches __focus__:<id>; throws on ambiguous
await driver.wait_for({ idle: true, timeoutMs: 5000 })
await driver.wait_for({ selector: "role=toast", timeoutMs: 3000 })
await driver.wait_for({ all: [{ selector: "id=log" }, { idle: true }], timeoutMs: 5000 })
driver.last_event("toast")              // most recent event of kind
driver.render_text()                    // ASCII debug render
```

## Event-driven E2E pattern

Instead of polling `driver.query()` in a sleep loop, subscribe to the event stream.
The canonical example is `tests/harness/events.spec.ts`.

### Core concept

The TUI emits discrete `LiveEvent` objects on the sidechannel whenever a
lifecycle boundary is crossed (route decided, council phase changed, askcard
opened, sprint stage entered, etc.). The driver buffers these in a ring (cap
1000) and delivers them to `events()` subscribers.

**Subscribe BEFORE dispatching the command** so no events are missed — though
`events()` replays all buffered events on subscribe anyway, so late-subscribe
also works.

### Reacting to modal lifecycle

```ts
// Subscribe before dispatching the command so no events are missed.
const events = driver.events(
  (e) => e.kind === "askcard-open" || e.kind === "sprint-halt"
);
driver.type("/ideal --force-council build X");
driver.press("Enter");

for await (const e of events) {
  if (e.kind === "askcard-open") {
    await driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 });
    driver.press("Enter"); // accept default
    continue;
  }
  if (e.kind === "sprint-halt") break;
}
await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 15_000 });
```

### Wait for a specific council phase to complete

```ts
await driver.wait_for({
  event: "council-step",
  match: (e) => e.kind === "council-step" && e.phaseKind === "synthesis" && e.state === "done",
  timeoutMs: 60_000,
});
```

### One-shot last_event check (after wait_for)

```ts
await driver.wait_for({ event: "route-decision", timeoutMs: 10_000 });
const e = driver.last_event("route-decision");
expect(e?.path).toBe("hot-path");
```

### `driver.events()` late-subscribe note

The iterator replays all events already in the buffer (cap 1000, FIFO eviction)
before streaming new ones. Subscribing after a fast event fires still captures
it — no event is lost between `spawnHarness()` and the `events()` call.

### `MUONROI_HARNESS_EVENTS` quick reference

Controls which event kinds are emitted on the sidechannel.

| Value | Effect |
|---|---|
| unset (default) | lifecycle preset — all kinds except `llm-token` |
| `lifecycle` | same as default |
| `*` or `all` | all kinds including high-volume `llm-token` |
| `llm-token,council-step` | exact comma-separated allowlist |

`llm-token` is off by default because DeepSeek Flash emits 80–120 tokens/sec —
opt in with `MUONROI_HARNESS_EVENTS=llm-token` only when you need token-level
correlation.

### All LiveEvent kinds (protocol version 0.4.0)

See authoritative schema in `docs/agent-harness/PROTOCOL.md` and https://docs.muonroi.com (covers 18+ kinds + `usage`, idle sentinel etc).

Commonly used: `route-decision`, `council-step` / `council-speaker`, `askcard-*`, `sprint-stage` / `sprint-halt` / `sprint-plan-committed`, `toast`, `ee-timeout` / `ee-error`, `steer-inject`, `llm-done`. `llm-token` is opt-in only (very high volume).

## Selector grammar quick reference

```
role=textbox                    # exact match
name~="Council"                 # case-insensitive substring
name*="Co.*l$"                  # regex
focus                           # flag (also: selected, disabled)
[index=0]                       # positional within siblings
role=dialog >> role=button      # child combinator
role=listitem name="OK"         # multiple terms AND together
```

Field names: `id`, `role`, `name`, `value`, `state`, `props.<key>` (dotted nested access). Plus flags: `focus`, `selected`, `disabled`.

## MCP path (external agent driving the TUI)

```bash
bun run src/index.ts mcp-driver         # boots stdio MCP server, advertises 16 tools (incl. changes_since)
```

Add to your MCP client config (Claude Desktop / Cursor / etc.):
```json
{
  "mcpServers": {
    "muonroi-harness": {
      "command": "bun",
      "args": ["run", "/path/to/muonroi-cli/src/index.ts", "mcp-driver"]
    }
  }
}
```

Then drive via tool calls: `tui.start`, `tui.snapshot`, `tui.press`, `tui.type`, `tui.query`, `tui.wait_for`, `tui.expect`, `tui.last_event`, `tui.stop`.

`tui.start` security boundary (enforced before any spawn):
- argv allowlist: `--agent-*`, `--mock-llm=*`, `--profile=*`. Anything else → `{error: "argv_rejected"}`
- env strip: `NODE_OPTIONS`, `BUN_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `LD_AUDIT`, `NODE_PATH` removed
- cwd containment: `realpathSync` against `homedir()` or repo root
- cwd extra roots (opt-in, default-deny preserved): set env `MUONROI_HARNESS_EXTRA_ROOTS` (OS-path-list or comma-separated) **or** create `.muonroi-harness-roots.json` (`{ "roots": [...] }`, gitignored) at repo root to also allow dogfooding sibling ecosystem repos (e.g. `D:\sources\Core\*`). Clean checkouts have neither → identical to home+repo-only. Implemented in `packages/agent-harness-core/src/mcp-server.ts` (`loadExtraRoots`)
- mock-llm path: must resolve inside repo root
- Windows: **supported** via named-pipe transport (`packages/agent-harness-opentui/src/agent-mode.ts:73`); the legacy `windows_unsupported` guard is no longer emitted
- Permission modes (safe / auto-edit / yolo) + shuru sandbox now emit mandatory audit events (yolo-override, permission-override, shuru wraps with redacted cmd) to decision-log; review via `usage security-audit --since 7d`. See AGENTS.md "Permission Mode Threat Model" and 01-security-hardening-PLAN.md:134-150.

## WSL setup (one-time)

See the one-time WSL + bun install steps in `docs/agent-harness` notes or the spike docs. Key points:

- Install bun *inside* WSL (user-local via npm prefix).
- Clone a Linux-side checkout (`~/muonroi-cli`) — do **not** run harness tests over `/mnt/d` bind mount (wrong native modules).
- Always `git pull` before harness runs in WSL.

Full commands are in git history / previous Claude sessions or `scripts/wsl-test-harness.sh`.

## Known caveats (read before debugging "test failures")

1. **`composer.spec.ts` asserting `query("focus")`** can fail on a fresh WSL clone because the API-key modal grabs focus when no key is configured. The composer Semantic is correctly wired but reports `focus: undefined`. Either pre-seed a key (`bun run src/index.ts -k FAKE -m gpt-4o-mini --smoke-boot-only` won't persist it; need keychain) or relax the test to assert role only. (The api-key modal spec itself is fully un-skipped — see commit `62ec65a` wiring `MUONROI_TEST_NO_KEYCHAIN=1`.)

2. **`council-flow.spec.ts`, `askcard.spec.ts`, `ideal.spec.ts` council/loop E2E — NOW UN-SKIPPED (2026-06-15).** The old blocker was misattributed to "orchestrator rejects mock JSON". The real cause was that these specs spawned in the **repo root**, so the `/ideal` discover phase (and `/council` conversationContext snapshot) scanned the large muonroi-cli repo — a slow, highly-variable cost (28s..>40s) that raced the 30s timeout. Fix: spawn in a **fresh greenfield temp cwd** (`spawnHarness({ cwd })`) so the scan is instant; the `council_question` / `product_status_card` / `council_phase` chunks then surface in <1s, deterministically (measured 463/476/476ms across 3 runs). `/ideal` specs also pass `--force-council` to force the council/loop path (greenfield + low-complexity otherwise routes to hot-path). Secondary: `createMockModel` now implements `doGenerate` (`src/agent-harness/mock-model.ts`) so the debate-planner's `generateObject` no longer throws "Not implemented" — it returns `{}` by default → debate-planner falls through to its fallback plan; supply a `generate` fixture field for the happy path.

3. **`scroll.spec.ts`, `modal-focus.spec.ts`** have `it.todo` stubs documenting features the TUI doesn't yet expose (props.scrollTop on a scrollable listbox, modal focus restore). `error-states.spec.ts` was un-skipped in commit `96ae341` and is now active.

4. **`cost-leak-f1-tui.spec.ts:47` is `it.skip`** — the `openai.promptCacheKey` branch in `src/orchestrator/orchestrator.ts` is not exercised because the mock-llm path uses a deepseek model id. Fix requires threading a provider-id override through `--mock-llm` so the mock claims the openai provider while still being routed through `resolveModelRuntime`.

5. **Frame timing**: `addPostProcessFn` fires at targetFps (~60Hz) even without React changes. The harness dedupes via hash. If you see suspiciously many duplicate `LiveFrame` lines in fd3, the dedup may have broken — see spike-0a-findings.md.

6. **Windows native fd3/4**: bun's `spawn` accepts `stdio: [..., "pipe", "pipe"]` on Linux/macOS but fails on Windows. The harness now uses **named pipes** (`\\.\pipe\muonroi-harness-{pid}-{uuid}-{in|out}`) on Windows transparently — `tui.start` no longer returns `windows_unsupported`. Implementation: `packages/agent-harness-opentui/src/agent-mode.ts:73`.

7. **Skip ratio policing**: `bun run lint:harness-skips` audits every `.skip` / `.todo` in `tests/harness/**` against `scripts/.harness-skips-allow.json`. Default threshold 40% (warn-only); `lint:harness-skips:strict` exits non-zero in CI when the ratio is exceeded or a new skip is added without an allowlist entry.

## Headless verification (no TUI, no terminal)

Useful for quick smoke when you don't need to observe the UI:

```bash
# Real LLM headless prompt (needs API key)
bun run src/index.ts -p "Reply: PONG" -m "deepseek-ai/DeepSeek-V4-Flash" -k "$SF_KEY" --format text

# Boot-only smoke (no provider call, no keychain)
bun run src/index.ts --smoke-boot-only

# MCP protocol smoke (Windows-compatible)
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tui.capabilities","arguments":{}}}\n' | bun run src/index.ts mcp-driver
```

## Cost-leak forensics & acceptance checks

When investigating "why did this prompt cost so much" or verifying the
Phase A/B/C cost-optimization caps still hold:

```bash
# Per-event breakdown of a recent session by ID prefix.
bun run src/index.ts usage forensics <id-prefix>          # human-readable
bun run src/index.ts usage forensics <id-prefix> --json   # machine-parseable
```

Inline anomaly flags (each tied to a plan phase target):

| Anomaly | Meaning |
|---|---|
| `peak single-call input > 80,000` | Sub-agent cumulative cap did NOT engage (Phase B target breach). Check `getSubAgentBudgetChars()` + the `wrapToolSetWithCap` wiring around `childBaseTools` in `runTaskRequest` / `runTaskRequestBatch`. |
| `NULL message_seq on 'message' source` | Phase A5 message write-ahead bypassed. Verify `persistMessageWriteAhead` is called BEFORE streamText in `processMessage` (sees `messageSeqs.push(seq)` not `push(null)`). |
| `zero cache_creation_tokens across deepseek input tokens` | Scoped to deepseek events only; expected behaviour (DeepSeek never emits cache_creation — it has cache reads only via `prompt_cache_hit_tokens`). The C1 fix made the metric flow correctly; the warning is conservative and may fire on legitimate deepseek-dominant sessions — only treat as a regression if `cacheReadTokens` is ALSO 0 across the same events. |

Known baselines:
- **Pre-fix worst case**: session `b58603caceb9` (peak 504,737 input on a
  single prompt — all anomalies firing).
- **Post-fix DeepSeek**: session `5f349ef73ccb` (peak 31,702 input on the
  same "explore oauth" prompt — 16x reduction, 41.6% cache hit).
- **Post-fix OAuth gpt-5.4**: session `63974a79c0cd` (peak 31,827 input,
  97% cache hit on shorter prompts).

After A1-A5 + B1-B4 + C1-C3 + F1 + G1-G2 + M1 + O1 ship, peak should
stay ≤ 80K input tokens on any single call.

## Verifying provider-layer behavior with the mock model (H1)

Use `installMockModel` + `textOnlyStream` / `toolCallStream` from `src/agent-harness/mock-model.ts` + `shouldDropParam` + recording helpers to assert provider call shape *before* real tokens.

See `tests/harness/cost-leak-*.spec.ts` and `tests/harness/recording.ts` for patterns. Always `loadCatalog()` in beforeAll. Prefer `shouldDropParam(runtime, "maxOutputTokens")` over inlining `unsupportedParams`.

Key env caps (and their Phase targets) are documented in `src/orchestrator` and usage forensics. Full coverage table and anti-patterns in git history / previous sessions.

## When you finish a feature (pre-PR checklist)

1. `bunx tsc --noEmit` (0 errors)
2. `bunx vitest run` (Windows) + `wsl ... bunx vitest run tests/harness/` for POSIX E2E
3. For UI/harness surfaces: ensure `<Semantic>` wrapper + `tests/harness/*.spec.ts`
4. Run `bun run lint:semantic` (and `lint:harness-skips`)
5. Self-verify on touched watched surfaces when relevant.

### Adding a new TUI component (quick)

- Wrap root with `<Semantic id="..." role="..." name="..." isModal?>`
- Mirror `focus`/`value`/`selected` for interactive elements.
- Add matching harness spec + fixture if LLM involved.
- Run the spec on both Windows (named pipe) + WSL.
- Update `scripts/.semantic-wrap-allow.txt` only for intentional non-wrapped files.

## Multi-framework package layout

Harness is split (Phase 6):

- `@muonroi/agent-harness-core` — protocol, driver, selector, predicate (framework agnostic)
- `@muonroi/agent-harness-opentui` — OpenTUI `Semantic` + reconciler + agent-mode (used here)
- `@muonroi/agent-harness-react` + `-angular` — adapters for other UI frameworks

Shim at `src/agent-harness/` re-exports for in-repo use. See per-pkg READMEs in `packages/`.

## References

- `docs/superpowers/specs/2026-05-14-agent-harness-design.md`
- `docs/superpowers/plans/2026-05-14-agent-harness.md`
- `docs/agent-harness/PROTOCOL.md`, `TRANSPORTS.md`
- Protocol schema: `docs/agent-harness/PROTOCOL.md`, `docs/agent-harness/schema.json`
- Transport spec: `docs/agent-harness/TRANSPORTS.md`
- Spike findings: `docs/agent-harness/spike-0a-findings.md` (OpenTUI hook), `spike-0c-findings.md` (POSIX stdio), `spike-0d-mcp-sdk.md` (MCP SDK API)
