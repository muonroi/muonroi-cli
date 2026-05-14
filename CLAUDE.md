# CLAUDE.md — Agent harness verification workflow

> Project context lives in `AGENTS.md`. This file is the **operating manual** for verifying TUI features end-to-end via the agent harness (`src/agent-harness/`, `src/mcp/harness-driver.ts`).
> If you are a new agent session starting work on `muonroi-cli`, read this top-to-bottom before writing E2E tests or debugging harness failures.

## TL;DR

```bash
# WSL one-time setup (already done — see "WSL setup" below if missing):
#   - bun installed at ~/.npm-global/bin/bun, symlinked to ~/.local/bin/bun
#   - repo cloned at ~/muonroi-cli with Linux-native node_modules

# Every test cycle from Windows:
git push                                                    # push your changes
wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest run tests/harness/'
```

## Why this exists

The agent harness lets external CLIs (`claude`, `codex`, `gemini`) drive the TUI as a real user via structured JSON — no screenshots, no OCR. It is **POSIX-only by design** (uses `fd3`/`fd4` sidechannels not available on Windows). On Windows the only verifiable path is the MCP protocol contract (argv allowlist, env strip, capabilities). For actual TUI driving you need POSIX → use WSL.

Core components:
- `src/agent-harness/protocol.ts` — `LiveFrame` / `LiveEvent` / `UINode` / `DesignSpec`
- `src/agent-harness/selector.ts` — `parseSelector`, `matchSelector` (CSS-like grammar)
- `src/agent-harness/predicate.ts` — Zod-typed predicate evaluator
- `src/agent-harness/driver.ts` — in-process `Driver` API
- `src/agent-harness/semantic.tsx` — `<Semantic id="..." role="...">` React wrapper
- `src/agent-harness/reconciler-hook.ts` — `SemanticRegistry`, snapshot to `LiveFrame`
- `src/agent-harness/mock-llm.ts` — fixture-based provider for deterministic tests
- `src/mcp/harness-driver.ts` — `mcp-driver` subcommand, 16 tools over stdio MCP
- `tests/harness/` — E2E specs (POSIX-only suites use `describe.skipIf(process.platform === "win32")`)

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

1. **`composer.spec.ts` asserting `query("focus")`** can fail on a fresh WSL clone because the API-key modal grabs focus when no key is configured. The composer Semantic is correctly wired but reports `focus: undefined`. Either pre-seed a key (`bun run src/index.ts -k FAKE -m gpt-4o-mini --smoke-boot-only` won't persist it; need keychain) or relax the test to assert role only.

2. **`council-flow.spec.ts` and `determinism.spec.ts` are `describe.skip`** — they wait for a Council picker dialog that the TUI doesn't render yet. Re-enable after wrapping the picker (if it gets built) with `<Semantic role="dialog" name="Council" isModal>`.

3. **`scroll.spec.ts`, `modal-focus.spec.ts`, `error-states.spec.ts`** have `it.todo` stubs documenting features the TUI doesn't yet expose (props.scrollTop, modal focus restore, mock-llm error injection).

4. **Frame timing**: `addPostProcessFn` fires at targetFps (~60Hz) even without React changes. The harness dedupes via hash. If you see suspiciously many duplicate `LiveFrame` lines in fd3, the dedup may have broken — see spike-0a-findings.md.

5. **Windows native fd3/4**: bun's `spawn` accepts `stdio: [..., "pipe", "pipe"]` on Linux/macOS but fails on Windows. The MCP driver's `tui.start` explicitly returns `windows_unsupported` rather than trying. To extend to Windows, swap fd3/4 for named pipes (~½ day, not started).

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

## When you finish a feature

Before opening a PR:
1. `bunx tsc --noEmit` — 0 errors
2. `bunx vitest run` from Windows — full unit + headless suite (4 pre-existing PIL failures are baseline noise unrelated to harness)
3. `wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && git pull && bunx vitest run tests/harness/'` — POSIX E2E confirmed
4. If you added a TUI element: confirm `<Semantic>` is wrapping it (otherwise harness can't see it)
5. If you added a slash command or modal: write an E2E spec under `tests/harness/`

## References

- Design doc: `docs/superpowers/specs/2026-05-14-agent-harness-design.md`
- Implementation plan (executed): `docs/superpowers/plans/2026-05-14-agent-harness.md`
- Protocol schema: `docs/agent-harness/PROTOCOL.md`, `docs/agent-harness/schema.json`
- Spike findings: `docs/agent-harness/spike-0a-findings.md` (OpenTUI hook), `spike-0c-findings.md` (POSIX stdio), `spike-0d-mcp-sdk.md` (MCP SDK API)
