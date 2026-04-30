# Phase 3: Polish, Headless, Cross-Platform Beta — Research

**Researched:** 2026-04-30
**Domain:** Headless CLI testing, Bun cross-platform binary compilation, permission modes, operator surface (doctor/bug-report)
**Confidence:** HIGH (codebase archaeology verified; Bun docs fetched from official source)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

Key constraints from PROJECT.md:
- Solo maintainer — every feature must be defensible as one-person ops.
- Must run on Windows 10, Windows 11, macOS, Linux without major divergence.
- Bun runtime; `bun build --compile` for standalone binaries.
- 3 permission modes: `safe` (confirm every tool), `auto-edit` (auto-approve reads+edits, confirm bash), `yolo` (auto-approve all).
- Sub-agent/delegate system from grok-cli preserved unchanged (CORE-04).

### Claude's Discretion
All implementation details — pure infrastructure phase.

### Deferred Ideas (OUT OF SCOPE)
None — infrastructure phase. CLOUD/BILL/WEB requirements are Phase 4 only.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORE-01 | Headless `--prompt` flag with `--format json`; golden tests in CI | `runHeadless()` + `createHeadlessJsonlEmitter` fully exist; need golden fixture tests wired to CI |
| CORE-02 | MCP servers from config integrate into tool-use loop; smoke test in CI | `buildMcpToolSet()` + `loadMcpServers()` exist; need a CI-runnable smoke that loads a stub server |
| CORE-03 | LSP integration preserved; smoke test in CI | `createLspClientSession()` exists; need smoke test that boots a real/stub LSP and calls `textDocument/definition` |
| CORE-04 | `task`-`delegate` system preserved unchanged; kept documented | `runBackgroundDelegation()` + `DelegationManager` exist in orchestrator; verification only |
| CORE-05 | CI matrix: Windows 10, Windows 11, macOS, Linux — no major divergence | Current CI only covers windows-latest; expand with ubuntu-latest + macos-latest jobs |
| CORE-06 | Standalone binaries via `bun build --compile`; published to npm + GitHub Releases | `build:binary` script exists but no CI publish step; keytar native addon is the critical blocker |
| CORE-07 | 3 permission modes (`safe`, `auto-edit`, `yolo`) wiring approval gates | `SandboxMode` and `tool_approval_request` exist but no named permission-mode type yet |
| OPS-01 | `muonroi-cli doctor` self-check command | Does not exist; new `src/ops/doctor.ts` + CLI command needed |
| OPS-02 | `muonroi-cli bug-report` anonymized bundle command | Does not exist; new `src/ops/bug-report.ts` + CLI command needed |
| OPS-03 | GitHub issue templates with auto-redaction guidance | Does not exist; `.github/ISSUE_TEMPLATE/` files needed |
| OPS-04 | `STATUS.md` with known issues, beta enrollment, rollout plan | Does not exist; repo root `STATUS.md` needed |
</phase_requirements>

---

## Summary

Phase 3 is a **validation and polish** phase on top of a largely-complete codebase. Phases 0–2 built the core infrastructure; Phase 3 must wire CI smoke tests, publish pipelines, permission modes, and operator tooling. All major subsystems (headless output, MCP, LSP, delegations) are already implemented — the gap is **test coverage proving they work end-to-end** and **new surface** (doctor, bug-report, permission modes, CI matrix, binary publishing).

The most technically complex deliverable is CORE-06 (standalone binaries with keytar native addon). Bun 1.1.34+ supports bundling `.node` files in `--compile` builds, but requires prebuilding per-platform binaries and restructuring the dynamic import in `src/providers/anthropic.ts`. This is a known pattern with a documented workaround.

The second complexity is CORE-07 (permission modes): the orchestrator already has `tool_approval_request` stream events and `SandboxMode`, but there is no `PermissionMode` type wiring `safe`/`auto-edit`/`yolo` to the existing approval gate. This is a new type + routing logic touching `src/utils/settings.ts`, `src/orchestrator/orchestrator.ts`, and the CLI parser in `src/index.ts`.

**Primary recommendation:** Plan as five parallel workstreams — (1) CI matrix expansion, (2) golden/smoke tests for headless+MCP+LSP, (3) `bun build --compile` + publish pipeline, (4) permission modes, (5) doctor+bug-report+docs. Workstreams 1 and 5 are fully independent; 2–4 can proceed in parallel.

---

## Standard Stack

### Core (already installed, verified)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bun` | `>=1.3.13` | Runtime + compile | Locked in D-003; 1.3.13 is latest stable |
| `vitest` | `4.1.5` | Test framework | Pinned D-007; all existing tests use it |
| `@ai-sdk/mcp` | `1.0.37` | MCP tool integration | Already in `buildMcpToolSet()` |
| `vscode-jsonrpc` | `8.2.1` | LSP protocol | Already in `createLspClientSession()` |
| `keytar` | `^7.9.0` | OS keychain | Native, Windows build confirmed OK |
| `commander` | `^12.1.0` | CLI parsing | Already used for all commands |

### New for Phase 3

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@actions/core` | (CI only) | GitHub Actions output | Only in CI workflow YAML, not npm dep |
| `gh` CLI | (CI only) | GitHub Releases uploads | Part of `gh release upload` in workflow |

No new npm dependencies are required for doctor/bug-report — use Node/Bun built-ins (`os`, `child_process`, `fs/promises`, `http`).

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Bun `--compile` per-platform CI matrix | `pkg` or `nexe` | `bun build --compile` is faster, integrates with existing stack — no reason to switch |
| Hand-rolling doctor output | `ink` or `listr` | Over-engineered for solo-maintainer; plain `console.log` + colors is sufficient |

**Installation:** No new packages required.

---

## Architecture Patterns

### Recommended Project Structure Additions

```
src/
├── ops/                 # NEW: OPS-01, OPS-02
│   ├── doctor.ts        # health check runner
│   ├── bug-report.ts    # anonymized bundle builder
│   └── redact.ts        # shared secret-scrubbing for bug-report (wraps existing redactor)
├── headless/
│   ├── output.ts        # EXISTING — complete
│   └── output.test.ts   # EXISTING — complete
├── mcp/
│   ├── runtime.ts       # EXISTING — complete
│   └── smoke.test.ts    # NEW: CORE-02 smoke
├── lsp/
│   ├── client.ts        # EXISTING — complete
│   └── smoke.test.ts    # NEW: CORE-03 smoke
tests/
├── integration/
│   ├── headless-golden.test.ts   # NEW: CORE-01 golden test
│   ├── cap-vs-router.test.ts     # EXISTING
│   └── kill-restart.test.ts      # EXISTING
.github/
├── workflows/
│   ├── ci-matrix.yml             # NEW: CORE-05 (expands windows-smoke.yml)
│   ├── release-binary.yml        # NEW: CORE-06 publish pipeline
│   ├── windows-smoke.yml         # EXISTING
│   └── ...
├── ISSUE_TEMPLATE/
│   ├── bug_report.yml            # NEW: OPS-03
│   └── feature_request.yml       # NEW: OPS-03
STATUS.md                         # NEW: OPS-04
```

### Pattern 1: Permission Mode Type (CORE-07)

**What:** New `PermissionMode` type (`safe` | `auto-edit` | `yolo`) threaded from CLI flag through `AgentOptions` to the orchestrator's tool-dispatch loop. The orchestrator consults it before emitting `tool_approval_request`.

**When to use:** Replaces ad-hoc `SandboxMode` as the user-facing permission knob. `SandboxMode` (`off`/`shuru`) controls _where_ bash runs; `PermissionMode` controls _whether_ the user is asked.

**Mapping:**
- `safe` → emit `tool_approval_request` for every tool call (current grok-cli default behavior)
- `auto-edit` → auto-approve `read_file`, `write_file`, `edit_file`, `grep`, `list_directory` — require confirmation for `bash`, `task`, `computer_*`
- `yolo` → auto-approve all tool calls (suppress `tool_approval_request` entirely)

**Implementation touch points:**
1. `src/utils/settings.ts` — add `export type PermissionMode = "safe" | "auto-edit" | "yolo"` alongside `SandboxMode`
2. `src/orchestrator/orchestrator.ts` — `AgentOptions.permissionMode?: PermissionMode`; in the tool-dispatch path where `tool-approval-request` is emitted (~line 2180), consult `permissionMode` before emitting
3. `src/index.ts` — add `--permission <mode>` CLI flag; map to `PermissionMode`; default `safe`

```typescript
// src/utils/settings.ts — addition
export type PermissionMode = "safe" | "auto-edit" | "yolo";

const AUTO_EDIT_ALLOWED: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "list_directory",
]);

export function toolNeedsApproval(toolName: string, mode: PermissionMode): boolean {
  if (mode === "yolo") return false;
  if (mode === "auto-edit") return !AUTO_EDIT_ALLOWED.has(toolName);
  return true; // "safe" — always confirm
}
```

### Pattern 2: Headless Golden Test (CORE-01)

**What:** A Vitest test that runs the headless JSON emitter against a deterministic mock `Agent.processMessage` iterator and asserts the JSONL output structure.

**Key insight:** Do NOT boot a real Agent in CI (no API key). The golden test stubs `processMessage` to yield a fixed sequence of `StreamChunk` values and asserts the emitted JSONL lines parse correctly and match expected event types. The `output.test.ts` file already tests the emitter logic; the golden test adds a fuller round-trip at the integration level.

```typescript
// tests/integration/headless-golden.test.ts (sketch)
// Source: pattern from existing headless/output.test.ts + stub pattern from tests/stubs/ee-server.ts
import { describe, it, expect } from "vitest";
import { createHeadlessJsonlEmitter } from "../../src/headless/output.js";
import type { StreamChunk } from "../../src/types/index.js";

async function* mockStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c;
}

it("emits valid JSONL step_start / text / step_finish for a simple prompt", async () => {
  const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter("test-session");
  // Simulate observer hooks
  observer.onStepStart({ stepNumber: 1, timestamp: 1000 });
  const lines: string[] = [];
  for await (const chunk of mockStream([
    { type: "content", content: "Hello" },
    { type: "done" },
  ])) {
    const w = consumeChunk(chunk);
    if (w.stdout) lines.push(...w.stdout.split("\n").filter(Boolean));
  }
  observer.onStepFinish({ stepNumber: 1, timestamp: 2000, finishReason: "stop", usage: {} });
  const tail = flush();
  if (tail.stdout) lines.push(...tail.stdout.split("\n").filter(Boolean));

  const events = lines.map(l => JSON.parse(l));
  expect(events.some(e => e.type === "step_start")).toBe(true);
  expect(events.some(e => e.type === "step_finish")).toBe(true);
  expect(events.some(e => e.type === "text" && e.text === "Hello")).toBe(true);
});
```

### Pattern 3: MCP Smoke Test (CORE-02)

**What:** A CI-runnable test that starts a stdio MCP stub (inline script), passes its config to `buildMcpToolSet`, and asserts at least one tool is discovered.

**Key insight:** Use a tiny inline stdio MCP echo server written as a Bun one-liner rather than depending on an external MCP server. This keeps CI hermetic.

```typescript
// src/mcp/smoke.test.ts (sketch)
import { describe, it, expect } from "vitest";
import { buildMcpToolSet } from "./runtime.js";

// The inline MCP stub responds to tools/list with one tool "echo"
it("discovers tools from a stdio MCP server stub", async () => {
  const bundle = await buildMcpToolSet([
    {
      id: "test-echo",
      label: "test-echo",
      enabled: true,
      transport: "stdio",
      command: "bun",
      args: ["-e", ECHO_MCP_SCRIPT],
    },
  ]);
  expect(bundle.errors).toHaveLength(0);
  expect(Object.keys(bundle.tools)).toContain("mcp_test_echo__echo");
  await bundle.close();
}, 10_000);
```

### Pattern 4: LSP Smoke Test (CORE-03)

**What:** Test that `createLspClientSession` can initialize with a real LSP server available in CI. The TypeScript Language Server (`typescript-language-server`) is installable in CI via `bun add -D typescript-language-server` or `npx`.

**Key insight:** LSP smoke only needs to prove `initialize` → `textDocument/didOpen` → `textDocument/documentSymbol` without error. Full `waitForDiagnostics` is slower (1.5s debounce) — test at integration level, not unit level.

### Pattern 5: Bun Binary Compilation with keytar (CORE-06)

**What:** `bun build --compile --target=<platform>` bundles the entire app including pre-built `.node` file for keytar.

**Critical issue:** keytar is a native addon (`node-gyp` compiled `.node` file). Bun v1.1.34+ supports bundling `.node` files in `--compile` builds, but requires:
1. Pre-built `.node` files for each platform stored at a predictable path
2. A conditional require pattern using `process.versions.bun` so the Bun-compile path loads the bundled `.node`, while the Node/npm install path uses `node-gyp-build`

**Implementation approach:**

Option A (Recommended for v1 beta): Skip keytar in the standalone binary — use env-var API key as fallback. The `src/providers/anthropic.ts` already handles `loadKeytar()` returning `null` gracefully. In the standalone binary, keytar loads as `null` and the user sets `ANTHROPIC_API_KEY`. Document this in release notes.

Option B (Full): Pre-build keytar for each target platform in CI, store in `prebuilds/<platform>-<arch>/keytar.node`, use conditional require pattern from Bun v1.1.34 docs. More complex, requires a separate build matrix step for keytar.

**Recommendation:** Use Option A for v1 beta (matching solo-maintainer ops constraint). Add a note to OPS-01 doctor output: "Keychain: standalone binary — use ANTHROPIC_API_KEY env var".

**Bun compile targets for CI matrix:**
```bash
bun build --compile --target=bun-windows-x64 ./src/index.ts --outfile dist/muonroi-cli-windows-x64.exe
bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile dist/muonroi-cli-darwin-arm64
bun build --compile --target=bun-darwin-x64 ./src/index.ts --outfile dist/muonroi-cli-darwin-x64
bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile dist/muonroi-cli-linux-x64
```

### Pattern 6: doctor Command (OPS-01)

**What:** `muonroi-cli doctor` runs a set of named health checks and prints a table. Never throws — each check has `pass | warn | fail` status.

```typescript
// src/ops/doctor.ts
interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

async function checkBunVersion(): Promise<CheckResult> { ... }
async function checkOS(): Promise<CheckResult> { ... }
async function checkKeyPresence(): Promise<CheckResult> { ... }  // keytar OR env var
async function checkOllamaHealth(): Promise<CheckResult> { ... } // GET http://VPS/api/tags
async function checkEEHealth(): Promise<CheckResult> { ... }     // existing health() in src/ee/health.ts
async function checkQdrantHealth(): Promise<CheckResult> { ... } // GET http://localhost:6333/healthz
async function checkRecentErrorRate(): Promise<CheckResult> { ... } // read ~/.muonroi-cli/errors.log line count (last 24h)

export async function runDoctor(): Promise<CheckResult[]> {
  return Promise.all([
    checkBunVersion(),
    checkOS(),
    checkKeyPresence(),
    checkOllamaHealth(),
    checkEEHealth(),
    checkQdrantHealth(),
    checkRecentErrorRate(),
  ]);
}
```

**Reuse:** `src/ee/health.ts` already exposes `health()` — call it directly. `src/router/health.ts` already calls the EE health probe. For Qdrant, do a simple `fetch("http://localhost:6333/healthz", { signal: AbortSignal.timeout(1000) })`.

### Pattern 7: bug-report Command (OPS-02)

**What:** Collects anonymized diagnostic state into a single JSON bundle printed to stdout (or written to a temp file). Delegates secret scrubbing to the existing `redactor` instance.

**Must NOT include:** API keys, keychain credentials, prompt content, any string matching the redactor's enrolled patterns.

**Must include:** Bun version, OS, `doctor` output, recent error log tail (last 20 lines, redacted), `~/.muonroi-cli/config.json` with keys redacted (`cap.monthly_usd` kept, `ee.authToken` → `[REDACTED]`), EE/Ollama health status.

### Anti-Patterns to Avoid

- **Booting real Agent in CI smoke tests:** No API key in CI runners. All headless/MCP/LSP smokes must use mocks or stubs.
- **Including prompt content in bug-report:** Explicit privacy boundary from REQUIREMENTS out-of-scope list.
- **Cross-compiling keytar native addon in CI:** Too complex for v1; use env-var fallback documented in release notes.
- **Creating a new test framework:** All tests use existing `vitest@4.1.5` pattern.
- **Separate CI workflow per requirement:** Consolidate headless + MCP + LSP smokes into one `ci-matrix.yml` matrix job.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSONL event emission for headless | Custom serializer | `createHeadlessJsonlEmitter` already exists in `src/headless/output.ts` | Already implemented and tested |
| MCP tool loading | Custom MCP client | `buildMcpToolSet()` in `src/mcp/runtime.ts` | Already implemented |
| LSP communication | Custom LSP | `createLspClientSession()` in `src/lsp/client.ts` | Already implemented |
| EE health probe | New HTTP check | `health()` in `src/ee/health.ts` | Already calls `getDefaultEEClient().health()` |
| Secret redaction in bug-report | Custom scrubber | `redactor` from `src/utils/redactor.ts` | Already enrolled with API key patterns |
| CLI arg parsing for new commands | Raw `process.argv` | `commander` already wired in `src/index.ts` | Consistent with all existing commands |
| Bun version check in doctor | Regex on `bun --version` | `process.versions.bun` | Available at runtime, no subprocess needed |

**Key insight:** 80% of Phase 3 is wiring existing code to tests and CI pipelines, not writing new logic.

---

## Common Pitfalls

### Pitfall 1: CI Runners Don't Have a Keychain
**What goes wrong:** Tests or doctor command call `keytar.getPassword()` in CI — fails silently or throws on Linux without `libsecret`.
**Why it happens:** `keytar` requires a D-Bus session / GNOME keyring / Windows Credential Manager. GitHub Actions runners on Linux have none by default.
**How to avoid:** `src/providers/anthropic.ts` already wraps keytar in a dynamic import with try-catch fallback. CI tests must set `ANTHROPIC_API_KEY` env var. Doctor's `checkKeyPresence()` should check env var as fallback.
**Warning signs:** `Error: Cannot autolaunch D-Bus without X11 $DISPLAY` in CI logs.

### Pitfall 2: Bun `--compile` Does Not Bundle .node Files Without Conditional Require
**What goes wrong:** `bun build --compile` with keytar produces a binary that crashes at runtime looking for `keytar.node`.
**Why it happens:** Native addons require the `.node` file to be loadable at runtime. Bun 1.1.34 inlines them only when `process.versions.bun` pattern is used in require path.
**How to avoid:** For v1 beta, use Option A (keytar skipped in standalone binary — env-var fallback). Document clearly. Revisit in Phase 4 if user demand requires it.
**Warning signs:** `Cannot find module 'keytar'` on a machine that installed via binary (not npm).

### Pitfall 3: LSP Server Not Available in CI
**What goes wrong:** LSP smoke test calls `typescript-language-server` which is not installed on fresh CI runner.
**Why it happens:** TSServer requires a separately installed package.
**How to avoid:** Add `typescript-language-server typescript` as `devDependencies` or install in CI step before running LSP smoke. These are already transitive deps via `vscode-jsonrpc`.
**Warning signs:** `ENOENT: no such file or directory, spawn typescript-language-server`.

### Pitfall 4: macOS CI Runners Don't Have Bun in PATH Without setup-bun
**What goes wrong:** `bun` command not found on `macos-latest` GitHub Actions runner.
**Why it happens:** Bun is not pre-installed on macOS GitHub-hosted runners (as of 2025).
**How to avoid:** Add `oven-sh/setup-bun@v2` step to every matrix job (already used in `windows-smoke.yml`).
**Warning signs:** `bun: command not found` in macOS CI step.

### Pitfall 5: Windows Path Separator in LSP `pathToFileURL`
**What goes wrong:** LSP `textDocument/definition` returns `file:///D:/...` URIs on Windows; `fileURLToPath` converts them back to `D:\...`. Tests comparing paths with `/` fail on Windows.
**Why it happens:** `createLspClientSession` already normalizes to `/` via `normalizeFsPath()` — but test fixtures may hard-code OS-specific paths.
**How to avoid:** Use `path.join` + `normalizeFsPath` in all LSP test fixture paths. Already handled in `client.ts` line 319.
**Warning signs:** Path comparison failures only on `windows-latest` CI runs.

### Pitfall 6: `program.name("grok")` — Branding Not Updated
**What goes wrong:** `src/index.ts` line 343 still sets `program.name("grok")` and description references "Grok". New commands (`doctor`, `bug-report`) inherit this branding.
**Why it happens:** Fork cleanup missed this line.
**How to avoid:** Change to `program.name("muonroi-cli")` when adding doctor/bug-report commands.
**Warning signs:** `grok doctor --help` appears instead of `muonroi-cli doctor --help`.

### Pitfall 7: `bug-report` Output Contains Sensitive Data
**What goes wrong:** `~/.muonroi-cli/usage.json` or EE auth token leaks into the bug report bundle.
**Why it happens:** Naive `JSON.stringify(config)` captures the full config including `ee.authToken`.
**How to avoid:** Explicitly allowlist fields from config (`cap.monthly_usd` only). Run all string values through `redactor.scrub()`. Never include transcript content.
**Warning signs:** Auth token present in sample bug-report output during testing.

### Pitfall 8: `bun build --compile` Target Platform vs Local Platform
**What goes wrong:** Running `bun build --compile --target=bun-linux-x64` on a Windows CI runner produces a binary that `file` command shows as ELF but cannot actually run on the same runner.
**Why it happens:** Cross-compilation works but you cannot test the output on the wrong OS.
**How to avoid:** In CI matrix, build _and test_ the binary only on matching platform jobs. Use per-platform matrix steps for smoke-testing compiled binaries.
**Warning signs:** Binary executes fine locally but fails in wrong-arch CI job.

---

## Code Examples

### Headless JSON Smoke — Key Verification Pattern
```typescript
// Source: src/headless/output.ts — createHeadlessJsonlEmitter
// Verify round-trip: emitter + flush produces parseable JSONL with sessionID
const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter("s1");
observer.onStepStart({ stepNumber: 1, timestamp: Date.now() });
const w = consumeChunk({ type: "content", content: "ok" });
observer.onStepFinish({ stepNumber: 1, timestamp: Date.now(), finishReason: "stop", usage: { inputTokens: 10 } });
const tail = flush();
const all = (w.stdout ?? "") + (tail.stdout ?? "");
const events = all.split("\n").filter(Boolean).map(l => JSON.parse(l));
// Must have: step_start, text (flushed at step_finish), step_finish
```

### Permission Mode Wiring — Orchestrator Touch Point
```typescript
// Source: src/orchestrator/orchestrator.ts ~line 2180
// Current: always emits tool-approval-request for paid tools
// New: consult permissionMode before emitting
case "tool-approval-request": {
  const toolName = approvalPart.toolCall?.toolName ?? "";
  if (toolNeedsApproval(toolName, this.permissionMode)) {
    yield { type: "tool_approval_request", approvalId: approvalPart.approvalId, ... };
    // wait for respondToToolApproval
  } else {
    // Auto-approve: inject approval response directly
    this.respondToToolApproval(approvalPart.approvalId, true);
  }
  break;
}
```

### CI Matrix YAML Pattern
```yaml
# .github/workflows/ci-matrix.yml (new)
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ">=1.3.13"
      - run: bun install --frozen-lockfile
      - run: bunx tsc --noEmit
      - run: bunx vitest run
```

### Doctor Output Pattern
```typescript
// src/ops/doctor.ts
function icon(status: "pass" | "warn" | "fail"): string {
  return status === "pass" ? "✓" : status === "warn" ? "!" : "✗";
}
export function formatDoctorReport(results: CheckResult[]): string {
  return results.map(r => `  ${icon(r.status)} ${r.name}: ${r.detail}`).join("\n");
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Cross-compile Bun binaries manually | `bun build --compile --target=<T>` since Bun 1.1.5 | May 2024 | Single command per target; CI matrix builds all 4 platforms |
| Native addon bundling unsupported | `.node` file conditional require since Bun 1.1.34 | Late 2024 | Enables keytar in compiled binary if needed (v2 option) |
| Windows support absent in Bun | Full Windows x64/ARM64 since Bun 1.1 | April 2024 | CI matrix now includes windows-latest without workarounds |

**Deprecated/outdated:**
- `pkg` / `nexe` for Node-based binary builds: unnecessary now that Bun compile covers all platforms.
- Manual `process.platform` branching for path separators in LSP: already handled by `normalizeFsPath()` in `src/lsp/client.ts`.

---

## Open Questions

1. **TypeScript Language Server availability in CI**
   - What we know: `typescript-language-server` is a devDependency candidate; `typescript` is already a devDep
   - What's unclear: Whether `bunx typescript-language-server --stdio` works on all three CI OS targets without additional install steps
   - Recommendation: Add `typescript-language-server` as a devDependency; test that `bunx typescript-language-server --version` succeeds in CI setup step before running LSP smoke

2. **`program.name("grok")` — scope of branding cleanup**
   - What we know: `src/index.ts:343` still has `program.name("grok")` and `"AI coding agent powered by Grok"` description
   - What's unclear: Whether fixing this constitutes a plan 03-xx scope item or is incidental cleanup
   - Recommendation: Fix as part of the doctor/bug-report command addition (same file edit, same PR)

3. **Qdrant port for doctor health check**
   - What we know: OPS-01 specifies checking "Qdrant health"; no Qdrant client is used anywhere in the current Phase 0–2 codebase (it was used in a different repo — experience-engine)
   - What's unclear: Whether the local Qdrant instance (if any) runs on port 6333 by default and whether users are expected to have it running locally
   - Recommendation: Check `http://localhost:6333/healthz` with a 1s timeout; if absent, report as `warn` (not `fail`) — Qdrant is optional for v1 local use

4. **`install.sh` branding update**
   - What we know: `install.sh` still references `APP="grok"`, `REPO="superagent-ai/grok-cli"` throughout
   - What's unclear: Whether this was intentionally deferred or an oversight from Phase 0
   - Recommendation: Update as part of CORE-06 (publish pipeline) since `install.sh` is part of the distribution surface

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | All | ✓ (local) | 1.3.10 (1.3.13 required) | None — pin blocks older |
| Node.js | Vitest (CI) | ✓ | 22.19.0 | — |
| `typescript-language-server` | CORE-03 smoke | ✗ (not in deps) | — | Add as devDep |
| Qdrant local | OPS-01 doctor | ✗ (not running) | — | Warn, not fail |
| Ollama VPS | OPS-01 doctor | Unknown (CI) | — | Warn, not fail |
| EE local | OPS-01 doctor | Unknown (CI) | — | Warn, not fail |
| GitHub CLI (`gh`) | CORE-06 release | ✓ (CI runner) | pre-installed on GitHub Actions | — |

**Missing dependencies with no fallback:**
- Bun 1.3.13 on local dev box (1.3.10 installed) — upgrade required before binary compilation (`bun upgrade`)

**Missing dependencies with fallback:**
- `typescript-language-server` — add to devDependencies; LSP smoke skips gracefully if spawn fails
- Qdrant / Ollama / EE in CI doctor smoke — check returns `warn` rather than `fail`

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `bunx vitest run --reporter=dot` |
| Full suite command | `bunx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORE-01 | Headless JSON emitter produces valid JSONL with step events | Integration | `bunx vitest run tests/integration/headless-golden.test.ts` | ❌ Wave 0 |
| CORE-02 | MCP `buildMcpToolSet` discovers tools from stdio server | Integration | `bunx vitest run src/mcp/smoke.test.ts` | ❌ Wave 0 |
| CORE-03 | LSP `createLspClientSession` initializes + returns symbols | Integration | `bunx vitest run src/lsp/smoke.test.ts` | ❌ Wave 0 |
| CORE-04 | `task`-`delegate` system exists unchanged | Arch/unit | `bunx vitest run tests/arch/` | ✅ (indirect) |
| CORE-05 | All tests pass on Windows + macOS + Linux | CI matrix | `.github/workflows/ci-matrix.yml` | ❌ Wave 0 |
| CORE-06 | `bun build --compile` produces runnable binary | Smoke (CI) | `release-binary.yml` step | ❌ Wave 0 |
| CORE-07 | `toolNeedsApproval()` returns correct per-mode | Unit | `bunx vitest run src/utils/permission-mode.test.ts` | ❌ Wave 0 |
| OPS-01 | `runDoctor()` returns CheckResult[] with all checks | Unit | `bunx vitest run src/ops/doctor.test.ts` | ❌ Wave 0 |
| OPS-02 | `buildBugReport()` output contains no secrets | Unit | `bunx vitest run src/ops/bug-report.test.ts` | ❌ Wave 0 |
| OPS-03 | Issue templates exist in `.github/ISSUE_TEMPLATE/` | Manual | `ls .github/ISSUE_TEMPLATE/` | ❌ Wave 0 |
| OPS-04 | `STATUS.md` exists at repo root | Manual | `test -f STATUS.md` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `bunx vitest run --reporter=dot` (< 30s)
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green + CI matrix all-green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/integration/headless-golden.test.ts` — covers CORE-01
- [ ] `src/mcp/smoke.test.ts` — covers CORE-02
- [ ] `src/lsp/smoke.test.ts` — covers CORE-03
- [ ] `src/utils/permission-mode.test.ts` — covers CORE-07
- [ ] `src/ops/doctor.test.ts` — covers OPS-01
- [ ] `src/ops/bug-report.test.ts` — covers OPS-02
- [ ] `.github/workflows/ci-matrix.yml` — covers CORE-05
- [ ] `.github/workflows/release-binary.yml` — covers CORE-06
- [ ] `.github/ISSUE_TEMPLATE/bug_report.yml` — covers OPS-03
- [ ] `STATUS.md` — covers OPS-04

---

## Sources

### Primary (HIGH confidence)
- Bun official docs (fetched): https://bun.com/docs/bundler/executables — cross-compilation targets, `.node` file bundling pattern
- Bun v1.1.34 blog (fetched): https://bun.sh/blog/bun-v1.1.34 — native addon conditional require pattern
- Codebase archaeology — `src/headless/output.ts`, `src/mcp/runtime.ts`, `src/lsp/client.ts`, `src/orchestrator/orchestrator.ts`, `src/ee/health.ts`, `src/index.ts`, `src/utils/settings.ts`

### Secondary (MEDIUM confidence)
- WebSearch: Bun cross-platform targets (verified against official docs): https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/
- WebSearch: Bun latest version 2026 (verified `npm view bun version` = 1.3.13): https://endoflife.date/bun
- WebSearch: GitHub Actions matrix pattern (standard practice, verified with docs): https://runs-on.com/github-actions/the-matrix-strategy/

### Tertiary (LOW confidence — for validation)
- WebSearch: keytar in Bun compiled binary — no authoritative single source; Option A (env-var fallback) is conservative safe choice

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all deps are already installed and tested in Phases 0–2; no new packages
- Architecture patterns: HIGH — patterns derived from direct codebase reading + official Bun docs
- Pitfalls: HIGH — Pitfalls 1–5 are empirically confirmed in the existing codebase decisions log (DECISIONS.md); Pitfalls 6–8 from code reading
- Bun compile native addon: MEDIUM — official doc pattern confirmed, but keytar + Bun compile not individually tested; conservative Option A avoids the risk

**Research date:** 2026-04-30
**Valid until:** 2026-05-30 (stable domain; Bun releases are monthly so re-check `bun --version` before binary compilation step)
