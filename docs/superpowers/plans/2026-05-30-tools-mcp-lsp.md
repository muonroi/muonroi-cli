# muonroi tools-mcp — lsp.query — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only `lsp.query` MCP tool to the existing `muonroi tools-mcp` server, wrapping `queryLsp()` so a client Claude session gets semantic code intelligence (definition/references/hover/symbols/implementation/call-hierarchy).

**Architecture:** A thin `registerLspTools(server, deps?)` (mirroring the piece-1/2 pattern) wired into `createToolsServer`. The single `lsp.query` tool delegates to `queryLsp(process.cwd(), input)` from `src/lsp/runtime.ts`, gated on `isLspToolEnabled(cwd)`. The `operation` enum is derived from the exported `LSP_TOOL_OPERATIONS` const so it never drifts. `deps` are injected so unit tests never spawn a language server.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk` (`McpServer`), `zod`, Vitest. Reuses `src/lsp/runtime.ts` (`queryLsp`, `isLspToolEnabled`), `src/lsp/types.ts` (`LSP_TOOL_OPERATIONS`, `LspQueryInput`, `LspToolResponse`).

**Spec:** `docs/superpowers/specs/2026-05-30-tools-mcp-lsp-design.md`
**Branch:** `feat/tools-mcp-lsp` (stacked on `feat/tools-mcp-ee-forensics`).

---

## Known APIs (verified at plan time)

- `queryLsp(cwd: string, input: LspQueryInput): Promise<LspToolResponse>` — from `src/lsp/runtime.ts`. Caches one manager per cwd; resolves relative `filePath` against cwd.
- `isLspToolEnabled(cwd: string): boolean` — from `src/lsp/runtime.ts`.
- `LspQueryInput = { operation: LspToolOperation; filePath: string; line?: number; character?: number; query?: string }` — `src/lsp/types.ts`.
- `LspToolResponse = { success: boolean; output: string; lspDiagnostics?: LspDiagnosticFile[] }` — `src/lsp/types.ts`.
- `LSP_TOOL_OPERATIONS` — exported `as const` tuple of 9 strings in `src/lsp/types.ts`: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`. `z.enum(LSP_TOOL_OPERATIONS)` works directly on this tuple.

`ok`/`fail` helpers from piece 1/2 live inside their modules (not exported); this plan re-declares tiny local `ok`/`fail` in `lsp-tools.ts` (consistent with `ee-tools.ts`).

---

## File Structure

- **Create** `src/mcp/lsp-tools.ts` — `registerLspTools(server, deps?)` registering `lsp.query`.
- **Create** `src/mcp/__tests__/lsp-tools.test.ts` — DI unit tests (3 cases).
- **Modify** `src/mcp/tools-server.ts` — call `registerLspTools(server)` in `createToolsServer`.
- **Modify** `src/mcp/__tests__/tools-server.smoke.test.ts` — assert `lsp.query` advertised.

Commit after each task with `--no-verify` (husky launcher broken, code 127); run `node scripts/check-secrets.mjs` (exit 0) first.

---

## Task 1: `lsp.query` tool module

**Files:**
- Create: `src/mcp/lsp-tools.ts`
- Test: `src/mcp/__tests__/lsp-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/__tests__/lsp-tools.test.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { LspToolResponse } from "../../lsp/types.js";
import { registerLspTools } from "../lsp-tools.js";

function collectTools(register: (s: McpServer) => void) {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  const fake = {
    registerTool(name: string, _def: unknown, handler: (args: unknown) => Promise<unknown>) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  register(fake);
  return handlers;
}
function parse(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { json: JSON.parse(r.content[0]!.text), isError: r.isError };
}

describe("lsp-tools", () => {
  it("lsp.query passes through the LspToolResponse when enabled", async () => {
    const resp: LspToolResponse = { success: true, output: "def at file.ts:10" };
    const handlers = collectTools((s) =>
      registerLspTools(s, { enabled: () => true, query: async () => resp }),
    );
    const out = parse(await handlers["lsp.query"]!({ operation: "goToDefinition", filePath: "a.ts", line: 1, character: 2 }));
    expect(out.isError).toBeFalsy();
    expect(out.json).toEqual(resp);
  });

  it("lsp.query returns lsp_disabled when LSP is off", async () => {
    const handlers = collectTools((s) =>
      registerLspTools(s, { enabled: () => false, query: async () => ({ success: true, output: "x" }) }),
    );
    const out = parse(await handlers["lsp.query"]!({ operation: "hover", filePath: "a.ts", line: 0, character: 0 }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("lsp_disabled");
  });

  it("lsp.query returns lsp_error when the query throws", async () => {
    const handlers = collectTools((s) =>
      registerLspTools(s, {
        enabled: () => true,
        query: async () => {
          throw new Error("server launch failed");
        },
      }),
    );
    const out = parse(await handlers["lsp.query"]!({ operation: "findReferences", filePath: "a.ts", line: 3, character: 4 }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("lsp_error");
    expect(out.json.message).toContain("server launch failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/mcp/__tests__/lsp-tools.test.ts`
Expected: FAIL — `Cannot find module '../lsp-tools.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/lsp-tools.ts`:

```ts
/**
 * src/mcp/lsp-tools.ts
 *
 * LSP code-intelligence MCP tool: a single lsp.query that mirrors the native
 * lsp tool surface (9 operations multiplexed through one query). Read-only.
 * Wraps queryLsp() (which caches one language-server manager per cwd).
 *
 * deps are injected so unit tests never spawn a real language server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LSP_TOOL_OPERATIONS, type LspQueryInput, type LspToolResponse } from "../lsp/types.js";

export interface LspToolDeps {
  query?: (cwd: string, input: LspQueryInput) => Promise<LspToolResponse>;
  enabled?: (cwd: string) => boolean;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(error: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error, message }) }],
    isError: true,
  };
}

async function defaultQuery(cwd: string, input: LspQueryInput): Promise<LspToolResponse> {
  const { queryLsp } = await import("../lsp/runtime.js");
  return queryLsp(cwd, input);
}
async function defaultEnabled(cwd: string): Promise<boolean> {
  const { isLspToolEnabled } = await import("../lsp/runtime.js");
  return isLspToolEnabled(cwd);
}

export function registerLspTools(server: McpServer, deps: LspToolDeps = {}): void {
  const query = deps.query ?? defaultQuery;
  const enabled = deps.enabled ?? defaultEnabled;

  server.registerTool(
    "lsp.query",
    {
      description:
        "Semantic code intelligence via language servers. operation is one of: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls. Provide filePath (+ line/character for position-based ops, or query for workspaceSymbol).",
      inputSchema: {
        operation: z.enum(LSP_TOOL_OPERATIONS),
        filePath: z.string().min(1).max(1000),
        line: z.number().int().min(0).optional(),
        character: z.number().int().min(0).optional(),
        query: z.string().max(1000).optional(),
      },
    },
    async (args) => {
      const cwd = process.cwd();
      let isEnabled: boolean;
      try {
        isEnabled = await enabled(cwd);
      } catch (e) {
        return fail("lsp_error", e instanceof Error ? e.message : String(e));
      }
      if (!isEnabled) {
        return fail("lsp_disabled", "LSP tool is disabled in settings (lsp.enabled / lsp.tool)");
      }
      try {
        const resp = await query(cwd, args as LspQueryInput);
        return ok(resp);
      } catch (e) {
        return fail("lsp_error", e instanceof Error ? e.message : String(e));
      }
    },
  );
}
```

NOTE: `enabled`'s default (`defaultEnabled`) is async, but the injected test
`enabled: () => true` is sync. The handler `await enabled(cwd)` works for both
(await on a non-Promise is a no-op). The `LspToolDeps.enabled` type is
`(cwd) => boolean`; widen it to `boolean | Promise<boolean>` so the async default
type-checks:

```ts
export interface LspToolDeps {
  query?: (cwd: string, input: LspQueryInput) => Promise<LspToolResponse>;
  enabled?: (cwd: string) => boolean | Promise<boolean>;
}
```
(Use this widened interface — it is the one the implementation above assumes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/mcp/__tests__/lsp-tools.test.ts`
Expected: PASS (3 tests). Then `bunx tsc --noEmit` → 0 errors. (If `z.enum` rejects the readonly tuple in the installed zod version, use `z.enum(LSP_TOOL_OPERATIONS as unknown as [string, ...string[]])` — but try the direct form first; modern zod accepts `readonly` tuples.)

- [ ] **Step 5: Commit**

```bash
node scripts/check-secrets.mjs
git add src/mcp/lsp-tools.ts src/mcp/__tests__/lsp-tools.test.ts
git commit --no-verify -m "feat(tools-mcp): lsp.query code-intelligence MCP tool"
```

---

## Task 2: Wire into the server + smoke test

**Files:**
- Modify: `src/mcp/tools-server.ts`
- Modify: `src/mcp/__tests__/tools-server.smoke.test.ts`

- [ ] **Step 1: Add the registration**

In `src/mcp/tools-server.ts`, add an import next to the existing
`import { registerForensicsTools } from "./forensics-tools.js";`:

```ts
import { registerLspTools } from "./lsp-tools.js";
```

In `createToolsServer`, after the existing `registerForensicsTools(server);` line, add:

```ts
  registerLspTools(server);
```

- [ ] **Step 2: Extend the smoke test**

In `src/mcp/__tests__/tools-server.smoke.test.ts`, after the existing
`expect(names).toContain("usage.forensics");` assertion, add:

```ts
      expect(names).toContain("lsp.query");
```

- [ ] **Step 3: Run the smoke test**

Run: `bunx vitest run src/mcp/__tests__/tools-server.smoke.test.ts`
Expected: PASS (1 test) — all 9 tool names advertised.

- [ ] **Step 4: Typecheck + full mcp suite**

Run: `bunx tsc --noEmit` → 0 errors.
Run: `bunx vitest run src/mcp/` → all green.

- [ ] **Step 5: Commit**

```bash
node scripts/check-secrets.mjs
git add src/mcp/tools-server.ts src/mcp/__tests__/tools-server.smoke.test.ts
git commit --no-verify -m "feat(tools-mcp): wire lsp.query into the server"
```

---

## Task 3: Final validation

- [ ] **Step 1: Typecheck** — `bunx tsc --noEmit` → 0 errors (run alone; if it OOM-crashes under concurrent load, re-run alone).
- [ ] **Step 2: Tests** — `bunx vitest run src/mcp/` → all green.
- [ ] **Step 3: Skip-lint** — `bun run lint:harness-skips` → no NEW skip from this branch (pre-existing `cost-leak-f1-tui.spec.ts` warning is unrelated).
- [ ] **Step 4: Secret scan** — `node scripts/check-secrets.mjs` → exit 0.

---

## Self-Review

- **Spec coverage:** single `lsp.query` tool ✓ (Task 1); wraps `queryLsp` ✓; gated on `isLspToolEnabled` → `lsp_disabled` ✓; `lsp_error` on throw ✓; operation enum derived from `LSP_TOOL_OPERATIONS` ✓ (`z.enum(LSP_TOOL_OPERATIONS)`); zod clamps (filePath max 1000, line/character int≥0, query max 1000) ✓; DI for tests ✓; wired into createToolsServer → 9 tools ✓ (Task 2); smoke asserts `lsp.query` ✓; never throws (both enabled() and query() wrapped) ✓; read-only / no hardcoded literals ✓.
- **Placeholder scan:** none — all code steps complete. The `z.enum` fallback note in Task 1 Step 4 is a contingency, not a placeholder (primary form is given).
- **Type consistency:** `LspToolDeps.query/enabled`, `LspQueryInput`, `LspToolResponse`, `LSP_TOOL_OPERATIONS`, and the local `ok`/`fail` shapes are used identically across Tasks 1–2. The widened `enabled?: (cwd) => boolean | Promise<boolean>` (Task 1 Step 3 note) is the interface the handler and tests both rely on. Tool name `lsp.query` matches between registration (Task 1) and smoke assertion (Task 2).
