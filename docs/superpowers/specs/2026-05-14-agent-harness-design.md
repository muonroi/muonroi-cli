# Agent Harness for muonroi-cli — Design (revised)

- Status: Approved design v2.1 (after cross-review)
- Date: 2026-05-14
- Owner: muonroi
- Spec version: 0.1.0-experimental

> Revision note: this version incorporates findings from three cross-reviews (architect, protocol designer, integration / security). Changes are visible in §6 (schema), §8 (selectors / driver), §9 (MCP security), §10 (idle), §11 (transport framing), §12 (phasing + Phase 0 spike), §14 (test plan).

## 1. Problem

External agent CLIs (Claude CLI, Codex CLI, Gemini CLI, …) cannot meaningfully test or debug a real TUI after building a feature. Current options:

1. Unit tests — verify functions, not user-facing behavior.
2. Non-interactive / scripted mode — narrow surface, far from the real TUI.
3. Screenshot + vision analysis — wastes tokens, no semantic information about focus, modals, async events.

Result: agents claim "feature works" without ever driving the TUI as a user. muonroi-cli's TUI (OpenTUI/React) is the immediate pain point; the same pain exists across the agent-CLI ecosystem.

Secondary problem: muonroi-cli's `ideal` feature spins up a multi-agent team (BA / Design / QA / Review …). Those reviewers currently consume prose UI descriptions. They could be far more rigorous if design artifacts were structural, text-only, and stack-agnostic.

## 2. Goals

### P0 (must)
Allow any external agent to drive muonroi-cli's TUI as a real user: send keys, read structured state, wait on idle, assert against named widgets. Achieved via a stable documented protocol and a thin, sandboxed MCP entry point.

### P1 (nice-to-have)
Have the `ideal` design/QA/Review phase emit a **Harness UI Spec** — a structural JSON description of UI layouts, states, transitions — reusable across TUI, React, Angular targets.

## 3. Non-goals

- A PTY + ASCII-grid fallback for vanilla TUIs that do not implement the protocol.
- Screenshot / image-based tools for agent consumption. (Plain ASCII render is allowed as a human-debug aid; see §9.)
- Built and maintained adapters for Ink / Textual / Bubble Tea / ratatui (reference examples only in `docs/`).
- TUI replay recorder / time-travel debugger.
- Public OSS extraction of a separate harness package in v1.

Note on PTY: the harness child process is spawned via **plain pipes**, not a PTY. Applications that hard-require a TTY for input would not work; muonroi-cli's TUI does not, because `--agent-mode` bypasses raw-TTY handling.

## 4. Insight

Both problems share a single schema for the UI tree, differing only in **mode**:

| Mode | Source | Content |
|---|---|---|
| `live` | Running app (renderer hook) | Frame seq, focus, modal stack, events stream, idle signal |
| `design` | Designer / QA agent in `ideal` | Scenes, possible states, transitions, copy |

One protocol family. Two producers. N consumers.

## 5. Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │       docs/agent-harness/PROTOCOL.md          │
                  │  schema.json (UINode, LiveFrame, DesignSpec)  │
                  └────────────┬─────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  Producer A             Producer B             Consumer
  agent-mode             ideal designer         external agent
  (OpenTUI hook          agent emits            via MCP, or
   emits LiveFrame)      DesignSpec.json        in-process driver
```

All code lives in `muonroi-cli`. The protocol document and JSON Schema are the only public contract.

## 6. Schema

### 6.1 UINode

```ts
type Role =
  | "dialog" | "textbox" | "listbox" | "listitem"
  | "button" | "checkbox" | "radio" | "radiogroup"
  | "tab" | "tablist" | "tree" | "treeitem"
  | "table" | "row" | "cell"
  | "progressbar" | "spinner"
  | "log" | "statusbar" | "menu" | "menuitem" | "toast" | "tooltip";

type UINode = {
  id: string;              // stable across renders within a session
  role: Role;
  name?: string;
  value?: string;          // textbox content, OR id of selected child for listbox/radiogroup/tablist
  focus?: true;
  selected?: true;
  disabled?: true;
  hidden?: true;
  state?: string;          // semantic flag: "loading" | "error" | custom
  props?: Record<string, unknown>;  // consumer-opaque extras (e.g., { pct: 72, maxLength: 500 })
  children?: UINode[];
};
```

Rules:
- `id` is stable across renders within a session. Components must derive `id` from a deterministic key, not render index.
- For container roles (`listbox`, `radiogroup`, `tablist`), `value` carries the **id** of the selected child to spare consumers a tree walk.
- `props` is opaque to selectors by default; matched only via `props.<key>=...` syntax.
- Role vocabulary is fixed at this version; additions require a spec bump.

### 6.2 LiveFrame & LiveEvent

```ts
type LiveFrame = {
  mode: "live"; version: "0.1.0";
  seq: number; ts: number;
  focus?: string;          // id
  modals?: string[];       // ordered stack (bottom → top); top = active
  nodes: UINode[];
};

type LiveEvent =
  | { t: "event"; kind: "stream.delta"; target: string; text: string }
  | { t: "event"; kind: "toast"; level: "info"|"warn"|"error"; text: string; ttlMs?: number }
  | { t: "idle" };
```

Modal stack supports nested dialogs (confirm-on-top-of-settings).

### 6.3 DesignSpec

```ts
type StatePatch = { id: string } & Partial<Omit<UINode, "children">>;

type DesignSpec = {
  mode: "design"; version: "0.1.0";
  target?: "tui" | "react" | "angular" | "any";
  scenes: Array<{
    id: string; name: string;
    layout: UINode;
    states?: Array<{ name: string; patches: StatePatch[] }>;
    transitions?: Array<{ from: string; on: string; to: string }>;
    notes?: string;
  }>;
};
```

Patch resolution (mandatory in `PROTOCOL.md`):
1. For each `StatePatch`, locate node in `scene.layout` by `id`. If not found → validation error.
2. Shallow-merge all non-`children` fields onto the located node.
3. `children` are never patched indirectly; if a state needs different children, declare them in a separate scene.

### 6.4 Versioning

- Every top-level message carries `version`.
- **Major** mismatch: consumer rejects the message.
- **Minor** additions: forward-compatible; consumers ignore unknown fields.
- Deprecations: producer may include `deprecated_fields?: string[]`; producers must keep deprecated fields working for two minor versions.
- Version negotiation: see `tui.capabilities()` in §9.

## 7. Component layout

```
muonroi-cli/
  docs/agent-harness/
    PROTOCOL.md            # public spec, versioned
    schema.json            # JSON Schema (draft 2020-12)
    examples/
      ink-producer.ts      # docs-only reference for other stacks
  src/
    agent-harness/
      protocol.ts          # TypeScript types
      reconciler-hook.ts   # OpenTUI render tree → LiveFrame
      sidechannel.ts       # JSONL transport (see §11)
      driver.ts            # in-process API
      selector.ts          # selector parser + matcher
      idle.ts              # render scheduler hook → emit idle
      mock-llm.ts          # deterministic LLM fixtures
    cli/
      agent-mode.ts        # --agent-mode flag wiring
      mcp-driver.ts        # `muonroi-cli mcp-driver` subcommand
    features/ideal/
      design-output.ts     # designer agent emits DesignSpec
  tests/harness/
    council-flow.spec.ts
    composer.spec.ts
    config-picker.spec.ts
    error-states.spec.ts
    timeouts.spec.ts
```

## 8. Driver API and selectors

### 8.1 API

```ts
driver.snapshot();
driver.changes_since(seq);
driver.press("Enter" | "Down" | "Ctrl+C");
driver.press_sequence(["Ctrl+K", "Ctrl+S"]);
driver.type("hello");
driver.focus(selector);                    // direct focus, no Tab-walking
driver.wait_for({ idle: true });
driver.wait_for({ selector, timeoutMs: 2000 });
driver.wait_for({ all: [{ idle: true }, { selector }] });
driver.query(selector);                    // throws on multi-match
driver.queryAll(selector);
driver.count(selector);
driver.expect(selector, predicate);        // predicate = typed object, see §9.2
driver.last_event(kind);                   // ephemeral events (toasts)
driver.render_text();                      // ASCII grid, human-debug only
```

### 8.2 Selector grammar

```
selector  := term (combinator term)*
combinator:= ' '   (descendant)
           | ' >> ' (child)
term      := key op value | flag | '[' positional ']'
key       := role | name | id | state | text | props.<dotpath>
op        := '='   (exact)
           | '~='  (contains, case-insensitive)
           | '*='  (regex)
flag      := focus | selected | disabled
positional:= 'index=' N
value     := bareword | "quoted string"
```

Examples:
- `role=button name="Send"`
- `role=button name~=Send`
- `role=listbox name="Council picker" >> role=listitem [index=2]`
- `role=textbox props.maxLength*=^[0-9]+$` (rare; mainly for `state` matching)
- `role=toast focus` — invalid: toasts cannot be focused. Use `driver.last_event("toast")`.

`query` / `wait_for` / `expect` throw if a selector matches more than one node; use `queryAll` or `count` for multi-match cases.

## 9. MCP entry point

Subcommand `muonroi-cli mcp-driver` exposes one-to-one MCP tools.

### 9.1 Tool surface

| Tool | Maps to |
|---|---|
| `tui.capabilities()` | returns `{ protocol: "0.1.0", features: [...] }` |
| `tui.start({ args, cwd, env })` | spawn child with `--agent-mode` (sandboxed, see §9.2) |
| `tui.snapshot()` | `driver.snapshot()` |
| `tui.changes_since({ seq })` | `driver.changes_since(seq)` |
| `tui.press({ key })` / `tui.press_sequence` | `driver.press(...)` |
| `tui.type({ text })` | `driver.type(...)` |
| `tui.focus({ selector })` | `driver.focus(...)` |
| `tui.wait_for({ selector?, idle?, all?, timeoutMs? })` | `driver.wait_for(...)` |
| `tui.query({ selector })` / `tui.query_all` / `tui.count` | `driver.query*` |
| `tui.expect({ selector, predicate })` | `driver.expect(...)` |
| `tui.last_event({ kind })` | `driver.last_event(...)` |
| `tui.render_text()` | ASCII render for human debug |
| `tui.stop()` | kill child |

Transport: stdio MCP. The driver process owns the child stdio pipes; the agent never touches raw bytes.

### 9.2 Security boundary (HIGH)

`tui.start` is the only attack surface. Hardening:

- **Argv allowlist.** `args[]` entries are accepted only if they match `^(--agent-[a-z-]+(=.*)?|--mock-llm(=.+)?|--profile=[a-zA-Z0-9_-]+)$`. Any other entry is rejected with a structured error. No subcommands are accepted from MCP; the driver fixes `argv[0]` to the muonroi-cli binary path.
- **Env sanitization.** `env` is merged onto a base, with the following keys stripped: `NODE_OPTIONS`, `BUN_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`. Keys outside `^[A-Z_][A-Z0-9_]{0,63}$` are rejected.
- **CWD allowlist.** `cwd` must resolve under the user's home directory or the repo root; symlinks resolved and re-checked.
- **No network exposure.** MCP runs on stdio only.
- **Predicate is data, not code.** `tui.expect.predicate` is a Zod-validated object:
  ```ts
  type Predicate =
    | { field: "name"|"value"|"state"; op: "eq"|"neq"|"contains"|"regex"; rhs: string }
    | { flag: "focus"|"selected"|"disabled"; value: boolean }
    | { all: Predicate[] } | { any: Predicate[] } | { not: Predicate };
  ```
  No string interpretation. No function transport.

These rules are enforced inside `mcp-driver.ts`; the in-process `driver.ts` API is unrestricted because it is called from trusted code.

## 10. Idle detection

Chosen approach: hook OpenTUI's render scheduler. Emit `{ t: "idle" }` when no render is pending AND no timer is queued for `N` ms (default 50; configurable via `--agent-idle-ms`).

**Hook viability is unverified.** Phase 0 includes a half-day spike (§12) to confirm OpenTUI exposes a stable surface. Outcomes:

- **Hook exists, public.** Proceed as designed.
- **Hook exists, internal-only.** Wrap usage in `reconciler-hook.ts`, pin `@opentui/core` to the exact tested version, add a smoke test that fails on upgrade.
- **No hook.** Fallback: render-delta heuristic — emit `idle` if (a) no `LiveFrame` produced for 80 ms and (b) no LLM stream event in the last 80 ms. Documented as `--agent-idle-mode=heuristic`. Less accurate; explicitly inferior.

Streaming token output flows through the event channel (`stream.delta`), never as new frames. Driver consumes events and frames as two interleaved streams.

## 11. Transport, determinism, framing

### 11.1 Sidechannel

- **POSIX:** extra file descriptors. Bun: `Bun.spawn({ stdio: [..., fd3, fd4] })` with `Bun ≥ 1.1`. Node fallback: `child_process.spawn(..., { stdio: ['pipe','pipe','pipe','pipe','pipe'] })`. fd 3 = frames+events (child → driver), fd 4 = commands (driver → child).
- **Windows:** named pipes. Pipe name `\\.\pipe\muonroi-harness-<pid>-<rand>` is negotiated by the child as the first stdout line in a single JSON handshake (`{"t":"handshake","pipe":"…"}`); after that, all sidechannel traffic moves to the named pipe and stdout becomes silent.

### 11.2 Framing

JSON Lines: each message is one UTF-8 line terminated by `\n`, max 1 MiB. Readers buffer until `\n` before parsing. The 1 MiB cap is enforced by the producer; oversized messages are split (e.g., huge `stream.delta` chunks).

### 11.3 Determinism

`--agent-mode` automatically:
- Fixes terminal size to 120×40 (override: `--agent-cols`, `--agent-rows`).
- Disables spinners and typing animations.
- Routes timers through a monotonic clock; `--agent-fake-clock` exposes a stepping clock for tests.
- When `--mock-llm <fixtures-dir>` is passed, all LLM calls are served from the fixture directory.

Determinism known limits: third-party libraries that read wall-clock `Date.now()` directly (e.g., logger timestamps) remain non-deterministic. Test plan (§14) sidesteps this by snapshotting `LiveFrame` only, never log text.

## 12. Phasing

| Phase | Scope | Effort | Exit criterion |
|---|---|---|---|
| **0a** | OpenTUI hook spike | ½ day | Demonstrated working reconciler hook OR documented fallback path |
| **0b** | `PROTOCOL.md` + `schema.json` + TypeScript types | ½ day | JSON Schema validates 3 hand-crafted `LiveFrame` and 2 `DesignSpec` fixtures |
| 1 | `--agent-mode` + reconciler hook + sidechannel (POSIX & Windows) | 1.5–2 days | JSONL frames stream for composer screen on both platforms |
| 2 | `driver.ts` + selector + idle + tests | 1 day | Vitest E2E for composer → send passes |
| 3 | `mock-llm.ts` + fake clock | ½ day | Council flow E2E passes without API key |
| 4 | `mcp-driver` subcommand + security hardening | 1 day | External agent drives full council flow via MCP; pen-tests pass argv/env injection cases |
| **P0 sub-total** | | **~4.5–5 days** | |
| 5 | Ideal `design-output.ts` | ½ day | Designer agent emits `DesignSpec` validated by `schema.json` |
| 6 | `DesignSpec` consumer helpers (query / diff / validate) | 1 day | Reviewer agent walks spec end-to-end; `diff_specs(a, b)` returns structured delta |
| **P1 sub-total** | | **~1.5 days** | |

**Total ≈ 6–6.5 days.** Stop after Phase 4 still satisfies P0.

## 13. Risks and mitigations

- **OpenTUI internal API drift.** Phase 0a spike confirms surface; production code wraps all usage in `reconciler-hook.ts`; OpenTUI version pinned; smoke test on upgrade.
- **Cross-platform pipe transport.** Implemented and tested separately on Linux/macOS (fds) and Windows (named pipes); CI matrix covers both.
- **Bun + extra fds.** Verified in Phase 1 against current Bun version. If unsupported, fall back to Node `child_process` for the MCP driver (driver is not user-facing perf-critical).
- **LLM streaming causing frame flicker.** Frames emit only on stable state transitions; token deltas use the event channel.
- **Protocol bloat.** Schema stays at `0.1.0`; new fields require two consumer requests on record.
- **Selector ambiguity.** `query` / `wait_for` / `expect` throw on multi-match.
- **MCP injection.** Argv allowlist, env strip, cwd allowlist, predicate-as-data (§9.2).
- **Determinism leakage.** Test plan snapshots `LiveFrame`, not logs; wall-clock-using libs are tolerated.
- **`tui.expect` predicate complexity creep.** Predicate grammar capped at the typed-object form in §9.2; no extensions without spec bump.

## 14. Test plan

Vitest E2E via `driver.ts` covers, at minimum:

1. **Composer → send.** Type a message, press Enter, await `idle`, assert log contains response.
2. **`/council` picker → debate plan.** Open picker, navigate, select, assert debate plan rendered.
3. **`/config` model picker.** Open, change model, assert statusbar updates.
4. **Error state.** Mock LLM error; assert `role=toast level=error` appears via `last_event`.
5. **Modal dismissal + focus restore.** Open dialog → Esc → focus returns to prior element.
6. **Large list scroll.** 200-item listbox; `press("Down")` × 50; assert visible window advances via `props.scrollTop`.
7. **Concurrent input during stream.** Type while `stream.delta` events flowing; assert `seq` strictly monotonic, no drops.
8. **`wait_for` timeout.** Selector that never appears; assert timed-out error after `timeoutMs`, no hang.
9. **Sidechannel disconnect.** Kill child mid-session; assert MCP driver cleans up handles and emits typed error.

Cross-cutting:
- Every emitted frame and event passes `schema.json`.
- MCP integration test: spawn `muonroi-cli mcp-driver`, run a full session over stdio MCP.
- Determinism check: run flow #2 fifty times under `--mock-llm`; require byte-identical traces of `LiveFrame` JSON.
- Security tests: `tui.start` rejects `--require`, `--preload`, `--loader`, `-e`, `--eval`, and env keys `NODE_OPTIONS`/`BUN_OPTIONS`/`LD_PRELOAD`.
- Windows CI added to GitHub Actions matrix; named-pipe path exercised there.

## 15. Open questions

None at design time. Phase 0a may surface a forced fallback for idle (§10); document the outcome in the implementation plan, not here.

## 16. Out of scope (explicit)

See §3.

---

Approval gate: this design moves to writing-plans only after user review.
