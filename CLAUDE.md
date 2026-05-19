# CLAUDE.md — Agent harness verification workflow

> Project context lives in `AGENTS.md`. This file is the **operating manual** for verifying TUI features end-to-end via the agent harness (`src/agent-harness/`, `src/mcp/harness-driver.ts`).
> If you are a new agent session starting work on `muonroi-cli`, read this top-to-bottom before writing E2E tests or debugging harness failures.

## TL;DR

```powershell
# Primary path — run natively on Windows (no WSL required):
bunx vitest -c vitest.harness.config.ts run tests/harness/
```

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

Core components:
- `src/agent-harness/protocol.ts` — `LiveFrame` / `LiveEvent` / `UINode` / `DesignSpec`
- `src/agent-harness/selector.ts` — `parseSelector`, `matchSelector` (CSS-like grammar)
- `src/agent-harness/predicate.ts` — Zod-typed predicate evaluator
- `src/agent-harness/driver.ts` — in-process `Driver` API
- `src/agent-harness/test-spawn.ts` — cross-platform spawn helper (fd 3/4 on POSIX, named pipes on Windows)
- `src/agent-harness/semantic.tsx` — `<Semantic id="..." role="...">` React wrapper
- `src/agent-harness/reconciler-hook.ts` — `SemanticRegistry`, snapshot to `LiveFrame`
- `src/agent-harness/mock-llm.ts` — fixture-based provider for deterministic tests
- `src/mcp/harness-driver.ts` — `mcp-driver` subcommand, 16 tools over stdio MCP
- `tests/harness/` — E2E specs (no platform guards — run on Windows and POSIX via `test-spawn.ts`)
- `tests/harness/helpers.ts` — shared `spawnHarness()` helper used by all spawn-based specs

## BB-aware `/ideal`

When the scaffold target resolves to `muonroi-building-block` (BB) — i.e., presence of `Directory.Build.props` + `*.sln` + any `src/Muonroi.*` directory — `/ideal` injects BB-specific context into the council system prompt at CB-1. Key files:

- `src/ee/bb-retrieval.ts` — `fetchBBContext(prompt, opts)` queries EE collections `bb-recipes`, `bb-behavioral`, `experience-principles` in parallel with retry-once + graceful degrade. Token budget 1500. Marker-stamped output for Layer 3 dedup.
- `src/product-loop/loop-driver.ts` — CB-1 entry point that injects the retrieved BB context BEFORE council debate fires.
- `src/pil/layer3-ee-injection.ts` — scans `ctx.enriched` for `<!-- bb-context-injected:<sha> -->` markers and skips already-injected hits.
- `src/scaffold/init-new.ts` — detects BB target heuristically, sets `IntentDetectionTrace.targetFramework = "muonroi-building-block"`.
- `src/scaffold/bb-ecosystem-apply.ts` — applies senior-bar code-gen (Program.cs wiring, sample rule + test, props minimalism, modular-boundaries gate).
- `src/scaffold/bb-quality-gate.ts` — runs `dotnet restore` + `dotnet build` + `check-modular-boundaries.ps1` + sentinel regex check after scaffold.
- `src/scaffold/resume-from-gate-failures.ts` — `/ideal --resume <path>` re-enters CB-1 with `EE-GATE-FAILURES.md` context.

Ingestion + collection layout: `docs/agent-harness/EE-INGESTION.md`.

EE failure-mode reference (what every call site does when EE is down):
`docs/ee/EE-DOWN-BEHAVIOR.md`.

Feature flag: `userSettings.eeBBContext: false` to disable BB retrieval.

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

| kind | When emitted | Key payload fields |
|---|---|---|
| `route-decision` | /ideal dispatched → routing decision made | `path`, `complexity`, `forceCouncil`, `runId` |
| `council-step` | Council phase changes state | `phaseId`, `phaseKind`, `state`, `label`, `elapsedMs` |
| `council-speaker` | Per-role speaker turn starts/ends | `role`, `status` ("start"\|"done"), `round`, `correlationId` |
| `askcard-open` | Council question card appears | `questionId`, `question`, `phase`, `optionCount` |
| `askcard-answered` | User answers question card | `questionId`, `answerKind`, `answerText` |
| `askcard-cancel` | User presses Escape on question card | `questionId` |
| `sprint-stage` | Sprint enters a new stage | `sprintIndex`, `stage` ("planning"\|"implementation"\|"verification"\|"judgment"), `runId` |
| `sprint-halt` | CB-gate fires — sprint halted | `sprintN`, `reason`, `runId` |
| `sprint-plan-committed` | Leader/council commits final sprint plan, before first sprint fires | `runId`, `projectDir`, `sprintCount`, `sprintIds`, `source` ("leader"\|"council"\|"auto"), `ts` |
| `llm-token` | Text delta from model (opt-in only) | `correlationId`, `delta`, `tokenIndex` |
| `llm-done` | LLM call completes | `correlationId`, `totalChars`, `finishReason` |
| `toast` | Error/info toast displayed | `level`, `text` |
| `stream.delta` | Streaming text chunk | `target`, `text` |
| `ee-timeout` | Experience Engine call exceeded its budget | `source`, `elapsedMs`, `budgetMs`, `ts` |
| `ee-error` | Experience Engine call failed with a non-timeout error | `source`, `name`, `message`, `ts` |

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
bun run src/index.ts mcp-driver         # boots stdio MCP server, advertises 16 tools
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
- mock-llm path: must resolve inside repo root
- Windows: returns `{error: "windows_unsupported"}` — POSIX-only

## WSL setup (one-time)

If `wsl -d Ubuntu -- bash -lc 'which bun'` returns empty:

```powershell
# 1. Install bun in WSL user-local (no sudo, no unzip required)
wsl -d Ubuntu -- bash -c 'mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g bun'

# 2. Put bun on PATH for login shells
wsl -d Ubuntu -- bash -c 'echo "export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >> ~/.bashrc'
wsl -d Ubuntu -- bash -c 'echo "export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >> ~/.profile'
wsl -d Ubuntu -- bash -c 'mkdir -p ~/.local/bin && ln -sf ~/.npm-global/bin/bun ~/.local/bin/bun && ln -sf ~/.npm-global/bin/bunx ~/.local/bin/bunx'

# 3. Clone repo into WSL home (separate from /mnt/d to keep Linux node_modules isolated)
wsl -d Ubuntu -- bash -lc 'cd ~ && git clone https://github.com/muonroi/muonroi-cli.git && cd muonroi-cli && bun install'

# 4. Verify
wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && bunx vitest run tests/harness/mcp-integration.spec.ts'
# expected: 2 passed
```

**Why not run from `/mnt/d/sources/Core/muonroi-cli`?** node_modules installed on Windows contains Windows-specific native bindings (rolldown, esbuild). Linux needs its own copy. Cloning into `~/muonroi-cli` keeps the two checkouts isolated. Git stays in sync — pull before each test.

## Known caveats (read before debugging "test failures")

1. **`composer.spec.ts` asserting `query("focus")`** can fail on a fresh WSL clone because the API-key modal grabs focus when no key is configured. The composer Semantic is correctly wired but reports `focus: undefined`. Either pre-seed a key (`bun run src/index.ts -k FAKE -m gpt-4o-mini --smoke-boot-only` won't persist it; need keychain) or relax the test to assert role only. (The api-key modal spec itself is fully un-skipped — see commit `62ec65a` wiring `MUONROI_TEST_NO_KEYCHAIN=1`.)

2. **`council-flow.spec.ts:69` and `askcard.spec.ts:33,51` and `ideal.spec.ts:49,68` are `it.skip`** (not `describe.skip`). Blocker: the council/loop orchestrator phase pipeline (preflight + debate-planner `generateObject`, and `src/product-loop/loop-driver.ts` phase gating) rejects the mock-llm fixture JSON, so the `council_question` / `product_status_card` chunks never reach `app.tsx` within 30s. Fix requires instrumenting the orchestrator and expanding fixture coverage — out of scope for harness work.

3. **`scroll.spec.ts`, `modal-focus.spec.ts`** have `it.todo` stubs documenting features the TUI doesn't yet expose (props.scrollTop on a scrollable listbox, modal focus restore). `error-states.spec.ts` was un-skipped in commit `96ae341` and is now active.

4. **`cost-leak-f1-tui.spec.ts:47` is `it.skip`** — the `openai.promptCacheKey` branch in `src/orchestrator/orchestrator.ts` is not exercised because the mock-llm path uses a deepseek model id. Fix requires threading a provider-id override through `--mock-llm` so the mock claims the openai provider while still being routed through `resolveModelRuntime`.

5. **Frame timing**: `addPostProcessFn` fires at targetFps (~60Hz) even without React changes. The harness dedupes via hash. If you see suspiciously many duplicate `LiveFrame` lines in fd3, the dedup may have broken — see spike-0a-findings.md.

6. **Windows native fd3/4**: bun's `spawn` accepts `stdio: [..., "pipe", "pipe"]` on Linux/macOS but fails on Windows. The MCP driver's `tui.start` explicitly returns `windows_unsupported` rather than trying. To extend to Windows, swap fd3/4 for named pipes (~½ day, not started).

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

Forensics tells you what happened *after* a real session. To verify a
provider-layer fix *before* burning real tokens, install
`MockLanguageModelV3` from `ai/test` in front of the orchestrator's
`streamText` calls and assert against the recorded `doStreamCalls`.

The harness pieces live in:

- `src/agent-harness/mock-model.ts` — `createMockModel`, `installMockModel`, `textOnlyStream`, `toolCallStream`
- `src/providers/runtime.ts` — `resolveModelRuntime()` short-circuits when `globalThis.__muonroiMockModel` is set
- `src/providers/runtime.ts` — `shouldDropParam(runtime, param)` — central rule used by orchestrator AND specs (do NOT inline this logic in specs)
- `tests/harness/recording.ts` — `inspectAll`, `inspectByRole`, `cumulativePromptChars`, `assertParamAbsent`, `assertParamPresent`, `getProviderOption`

### Pattern: write a cost-leak spec

```ts
// tests/harness/cost-leak-<id>.spec.ts
import { streamText } from "ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMockModel, textOnlyStream } from "../../src/agent-harness/mock-model.js";
import { loadCatalog } from "../../src/models/registry.js";
import { resolveModelRuntime, shouldDropParam } from "../../src/providers/runtime.js";
import { assertParamAbsent, inspectAll } from "./recording.js";

describe("<leak id>: <one-line claim>", () => {
  beforeAll(async () => { await loadCatalog(); });
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it("<expected behaviour>", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("done") },
      unsupportedParams: ["maxOutputTokens"],   // simulate OAuth registry
      defaultProviderOptions: { store: false },  // simulate provider quirks
    });
    cleanup = handle.uninstall;

    const runtime = resolveModelRuntime(/* stub factory */, "gpt-5.4");
    const result = streamText({
      model: runtime.model,
      system: "You are the Explore sub-agent.",
      messages: [{ role: "user", content: "go" }],
      ...(shouldDropParam(runtime, "maxOutputTokens") ? {} : { maxOutputTokens: 8192 }),
      ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
    });
    for await (const _ of result.fullStream) { /* drain */ }

    assertParamAbsent(inspectAll(handle)[0]!, "maxOutputTokens");
  });
});
```

Run only the harness suite — natively on Windows (named pipes) and POSIX
(fd 3/4); WSL fallback identical:

```powershell
bunx vitest -c vitest.harness.config.ts run tests/harness/
```

### Coverage map by leak

| Leak | Spec | What it asserts |
|---|---|---|
| **G1** — OAuth backend rejects `max_output_tokens` | `cost-leak-g1.spec.ts` ✅ | `assertParamAbsent(call, "maxOutputTokens")` when `unsupportedParams` includes it; control test asserts param IS present otherwise. |
| **F1** — Stable OpenAI `promptCacheKey` | `cost-leak-f1.spec.ts` ✅ | `getProviderOption(call, "openai", "promptCacheKey")` returns a deterministic sha256 prefix across all rounds in the same session. |
| **B3** — Sub-agent `prepareStep` compaction | `cost-leak-b3.spec.ts` ✅ | `cumulativePromptChars(handle)` stays well below the uncompacted control; older tool_result parts visibly rewritten to `[elided by sub-agent compactor]` stubs. |
| **B4** — Top-level `prepareStep` compaction | `cost-leak-b4.spec.ts` ✅ | Same as B3 but with `label: "top-level"` — assertion text checks `elided by top-level compactor`. |
| **C1** — DeepSeek cache split field | `src/orchestrator/__tests__/usage-normalizer-c1.test.ts` ✅ | DeepSeek-shaped usage with `prompt_cache_hit_tokens` is read into `cacheReadTokens`; control: OpenAI shape unchanged. |

### Anti-patterns

- **Do NOT inline `runtime.unsupportedParams?.includes(...)`** in specs. Always go through `shouldDropParam` so a future refactor of the rule updates both production and tests together.
- **Do NOT depend on `globalThis.__muonroiMockModel` from the parent test process when you also spawn a TUI child** — the mock lives in the process that imports it. For TUI E2E, the fixture file's `model` block is loaded by the child via `loadMockModelFromDir` in `src/index.ts`.
- **Do NOT skip `loadCatalog()` in `beforeAll`** — without it, `getModelInfo(modelId)` returns `undefined` and the `providerOptions` merge block silently no-ops.

Optional env overrides for the caps:

| Env | Range | Default | Effect |
|---|---|---|---|
| `MUONROI_MAX_TOOL_OUTPUT_CHARS` | 10_000–200_000 | 32_000 | Per-call tool-output cap (applies to every tool returning text). |
| `MUONROI_SUB_AGENT_BUDGET_CHARS` | 20_000–600_000 | 120_000 | Cumulative budget the `task` sub-agent may receive across one invocation. Tiers at 30%/70% (aggressive). |
| `MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS` | 50_000–1_500_000 | 400_000 | Cumulative budget for the TOP-LEVEL agentic tool loop, fresh per turn. Tiers at 50%/80% (loose — single-tool turns unaffected). Kicks in when sub-agent path fails and the top-level loop has to fall back to direct tool calls. |
| `MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS` | 20_000–500_000 | 80_000 | Phase B3 — cumulative message-chars above which the sub-agent `prepareStep` compactor rewrites older tool_result parts into short summary stubs. |
| `MUONROI_SUBAGENT_COMPACT_KEEP_LAST` | 1–20 | 3 | Phase B3 — trailing tool turns kept verbatim during sub-agent compaction. |
| `MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS` | 50_000–1_500_000 | 200_000 | Phase B4 — same as B3 threshold but for the top-level orchestrator loop. Higher default because top-level agents carry more useful early context. |
| `MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST` | 1–30 | 5 | Phase B4 — trailing tool turns kept verbatim during top-level compaction. |
| `MUONROI_CROSS_TURN_DEDUP` | `0` / `1` | `1` | Phase C3 — session-scoped dedup of identical tool outputs across user turns. Set to `0` to disable. When enabled, the second time the agent produces an identical tool result (e.g. `read_file` on the same file in turn 2), the content is replaced with `[tool_result identical to earlier turn — dedup ref sha1=..., originally from tool=... turn=...]`. LRU cap 200 entries per session, min 500 chars to qualify. |
| `MUONROI_DEBUG_SUBAGENT` | `0` / `1` | `0` | Emit detailed stderr telemetry from `task` sub-agents: streamText start config, per-part stream counts, finish reason, error parts, full catch-block error shape (name/statusCode/cause/responseBody/stack). Use when diagnosing silent task failures (e.g. "No output generated" with reasoning models). |

## When you finish a feature

Before opening a PR:
1. `bunx tsc --noEmit` — 0 errors
2. `bunx vitest run` from Windows — full unit + headless suite. PIL suite is fully green (the 4 pre-existing PIL failures were resolved in commit `955b8c6`). On Linux, two unrelated flaky failures may surface: `src/mcp/smoke.test.ts` "discovers tools from stdio MCP echo stub" (needs node + MCP framing; already `skipIf` Windows/CI) and `packages/agent-harness-core/__tests__/browser-bundle.spec.ts` "contains no Node built-ins" (esbuild EPIPE teardown race). Neither blocks merge.
3. `wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest run tests/harness/'` — POSIX E2E confirmed
4. If you added a TUI element: confirm `<Semantic>` is wrapping it (otherwise harness can't see it)
5. If you added a slash command or modal: write an E2E spec under `tests/harness/`

### Adding a new TUI component

1. Wrap the user-visible root with `<Semantic id="..." role="..." name="...">`. Pick `role` from the union in `src/agent-harness/protocol.ts`.
2. If it's a list/picker, wrap items with `role="listitem"` and mirror `selected` from your active-index state.
3. If it accepts input, mirror `value` (and `focus` when relevant).
4. If it's a modal, set `isModal`.
5. Add `tests/harness/<feature>.spec.ts` following the composer pattern.
6. Run the spec: `bunx vitest -c vitest.harness.config.ts run tests/harness/<feature>.spec.ts` — works natively on Windows (named pipes) and POSIX (fd 3/4). WSL fallback: `wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest -c vitest.harness.config.ts run tests/harness/<feature>.spec.ts'`.
7. If the flow requires multiple LLM round-trips, extend the corresponding fixture in `tests/harness/fixtures/llm/` (sequence mode — see `mock-llm.ts`).
8. Run `bun run lint:semantic` — it warns on `.tsx` files under `src/ui/` whose root is not `<Semantic>`. Address warnings before merging. To suppress a file that is intentionally unwrapped (child component, utility, test), add its repo-relative path to `scripts/.semantic-wrap-allow.txt`.

## Multi-framework package layout

As of Phase 6, the harness is split into four independently-publishable packages under `packages/`:

| Package | npm name | Purpose |
|---|---|---|
| `packages/agent-harness-core` | `@muonroi/agent-harness-core` | Protocol types, selector/predicate engine, `Driver`, WebSocket transport, `findUnwrappedComponents` lint helper. Framework-agnostic. |
| `packages/agent-harness-opentui` | `@muonroi/agent-harness-opentui` | OpenTUI adapter — `SemanticRegistry`, `reconciler-hook`, `input-bridge`, agent-mode bootstrap. Used by `src/index.ts` in this repo. |
| `packages/agent-harness-react` | `@muonroi/agent-harness-react` | React DOM adapter — `<Semantic>`, `<SemanticProvider>`, `installReactHarness()`. Peer-requires React ≥ 18. |
| `packages/agent-harness-angular` | `@muonroi/agent-harness-angular` | Angular 16+ adapter — `[muonroiSemantic]` directive, `SemanticRegistryService`, `SemanticSnapshotService`. |

The backwards-compatibility shim at `src/agent-harness/` re-exports everything from `@muonroi/agent-harness-core` and `@muonroi/agent-harness-opentui` so existing imports inside this repo continue to work unchanged.

### Adding a new framework adapter

1. Copy `packages/agent-harness-react` (or `-angular`) as a starting point.
2. Implement a `SemanticRegistry`-compatible tree builder that calls `registry.register(node)` on mount and `registry.unregister(id)` on unmount.
3. Snapshot the tree and emit it as a `LiveFrame` via `snapshotToLiveFrame(registry, seq, ts)` from `@muonroi/agent-harness-core`.
4. Wire commands (`press`, `type`, `focus`) from the transport back into your framework's DOM/event system.
5. Export a single `install<Framework>Harness(opts)` entry-point that sets up the registry, transport, and teardown handle.
6. Add a per-package `README.md` (see `packages/agent-harness-react/README.md` as template).
7. Add the package to `bun.workspaces` in the root `package.json`.

Per-package README files:
- `packages/agent-harness-core/README.md`
- `packages/agent-harness-opentui/README.md`
- `packages/agent-harness-react/README.md`
- `packages/agent-harness-angular/README.md`

## References

- Design doc: `docs/superpowers/specs/2026-05-14-agent-harness-design.md`
- Implementation plan (executed): `docs/superpowers/plans/2026-05-14-agent-harness.md`
- Protocol schema: `docs/agent-harness/PROTOCOL.md`, `docs/agent-harness/schema.json`
- Transport spec: `docs/agent-harness/TRANSPORTS.md`
- Spike findings: `docs/agent-harness/spike-0a-findings.md` (OpenTUI hook), `spike-0c-findings.md` (POSIX stdio), `spike-0d-mcp-sdk.md` (MCP SDK API)
