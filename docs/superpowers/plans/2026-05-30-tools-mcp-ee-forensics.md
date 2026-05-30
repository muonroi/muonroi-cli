# muonroi tools-mcp — EE + forensics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `muonroi tools-mcp` stdio server with `ee.query`, `ee.health`, and `usage.forensics` — read-only, synchronous, dependency-injected for testability.

**Architecture:** Two new thin register-functions (`registerEETools`, `registerForensicsTools`) wired into `createToolsServer` alongside `registerSelfVerifyTools`. EE calls go through `createEEClient` (already graceful: `search()` returns `null` on error, never throws). Forensics reads local SQLite via `collectCostForensics`. Each register-function takes optional `deps` so unit tests inject stubs instead of hitting `:8082` or the DB.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk` (`McpServer`), `zod`, Vitest. Reuses `src/ee/client.ts` (`createEEClient`), `src/ee/auth.ts` (`loadEEAuthToken`, `getCachedServerBaseUrl`), `src/cli/cost-forensics.ts` (`collectCostForensics`, new `resolveSessionIds`).

**Spec:** `docs/superpowers/specs/2026-05-30-tools-mcp-ee-forensics-design.md`
**Branch:** `feat/tools-mcp-ee-forensics` (stacked on `feat/tools-mcp-self-verify`).

---

## Known APIs (verified at plan time)

- `createEEClient(opts?: { baseUrl?; authToken?; timeoutMs?; fetchImpl? }): EEClient`
- `EEClient.search(query, opts?: { limit?; collections?; timeoutMs?; signal? }): Promise<EESearchResponse | null>` — returns `null` on any error/timeout (does NOT throw).
- `EEClient.health(): Promise<{ ok: boolean; status: number }>`
- `loadEEAuthToken(): Promise<string | null>` (also populates the cached base URL), `getCachedServerBaseUrl(): string | null` — both from `src/ee/auth.ts`.
- `collectCostForensics(sessionId: string): CostForensicsSummary` (sync, reads local SQLite) — from `src/cli/cost-forensics.ts`.
- `EESearchResponse` type is exported from `src/ee/types.js`.

The piece-1 `ok()` / `fail()` helpers live INSIDE `src/mcp/tools-server.ts` (not exported). This plan re-declares tiny local `ok`/`fail` in each new module to avoid changing piece-1's surface.

---

## File Structure

- **Modify** `src/cli/cost-forensics.ts` — add `export function resolveSessionIds(prefix): string[]` (additive; leaves the private `resolveSessionId` untouched).
- **Create** `src/mcp/ee-tools.ts` — `registerEETools(server, deps?)` registering `ee.query` + `ee.health`.
- **Create** `src/mcp/forensics-tools.ts` — `registerForensicsTools(server, deps?)` registering `usage.forensics`.
- **Modify** `src/mcp/tools-server.ts` — call the two new register-functions in `createToolsServer`.
- **Create** `src/mcp/__tests__/ee-tools.test.ts`, `src/mcp/__tests__/forensics-tools.test.ts`.
- **Modify** `src/mcp/__tests__/tools-server.smoke.test.ts` — assert the 3 new tool names.

Commit after each task with `--no-verify` (husky launcher broken, code 127), but run `node scripts/check-secrets.mjs` first and confirm exit 0.

---

## Task 1: `resolveSessionIds` helper in cost-forensics

**Files:**
- Modify: `src/cli/cost-forensics.ts`
- Test: `src/cli/cost-forensics.test.ts` (append one test)

- [ ] **Step 1: Read the existing private resolver**

Run: `grep -n "resolveSessionId\|getDatabase\|FROM sessions" src/cli/cost-forensics.ts`
You will find a private `function resolveSessionId(prefix)` that runs
`SELECT id FROM sessions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 5`.
Do NOT modify it.

- [ ] **Step 2: Write the failing test**

Append to `src/cli/cost-forensics.test.ts` (match the existing import of `getDatabase` / test DB setup in that file — reuse whatever seeding helper the file already uses; if it seeds a `sessions` table, insert two ids sharing a prefix):

```ts
import { resolveSessionIds } from "./cost-forensics.js";

describe("resolveSessionIds", () => {
  it("returns all session ids matching a prefix, newest first", () => {
    // Reuse the file's existing in-memory/temp DB seeding pattern. Seed two
    // sessions whose ids share the prefix "deadbeef":
    //   insert session id="deadbeef0001" created_at earlier
    //   insert session id="deadbeef0002" created_at later
    const ids = resolveSessionIds("deadbeef");
    expect(ids).toContain("deadbeef0001");
    expect(ids).toContain("deadbeef0002");
    expect(ids[0]).toBe("deadbeef0002"); // newest (later created_at) first
  });

  it("returns empty array for an unknown prefix", () => {
    expect(resolveSessionIds("zzzznomatch")).toEqual([]);
  });
});
```

NOTE for the implementer: open `src/cli/cost-forensics.test.ts` and copy its
existing DB-seeding approach exactly (it already sets up a test database for
`collectCostForensics` tests). Insert the two `sessions` rows using that same
mechanism. If the file uses a shared `beforeEach` seeding a temp SQLite file via
`getDatabase()`, insert with `getDatabase().prepare("INSERT INTO sessions ...").run(...)`.

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run src/cli/cost-forensics.test.ts -t resolveSessionIds`
Expected: FAIL — `resolveSessionIds is not exported` / not a function.

- [ ] **Step 4: Add the exported helper**

Add to `src/cli/cost-forensics.ts` (near the private `resolveSessionId`):

```ts
/**
 * Return ALL session ids matching a prefix (newest first, capped at 5).
 * Additive sibling of the private resolveSessionId — exposes the raw match
 * list for callers (e.g. the MCP forensics tool) that need to distinguish
 * "no match" from "ambiguous". The CLI path keeps using resolveSessionId.
 */
export function resolveSessionIds(prefix: string): string[] {
  const rows = getDatabase()
    .prepare(`SELECT id FROM sessions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 5`)
    .all(`${prefix}%`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run src/cli/cost-forensics.test.ts -t resolveSessionIds`
Expected: PASS (2 new tests). Then `bunx tsc --noEmit` → 0 errors.

- [ ] **Step 6: Commit**

```bash
node scripts/check-secrets.mjs
git add src/cli/cost-forensics.ts src/cli/cost-forensics.test.ts
git commit --no-verify -m "feat(forensics): export resolveSessionIds for MCP forensics tool"
```

---

## Task 2: EE tools (`ee.query`, `ee.health`)

**Files:**
- Create: `src/mcp/ee-tools.ts`
- Test: `src/mcp/__tests__/ee-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/__tests__/ee-tools.test.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerEETools } from "../ee-tools.js";

// Minimal harness: register tools onto a real McpServer, then invoke a tool's
// handler by reaching into the registered tool. We test the handler via the
// public callTool path using an in-process client would be heavier; instead we
// capture handlers through a thin fake that records registrations.
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

function textOf(result: unknown): unknown {
  // result is { content: [{ type:"text", text }], isError? }
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { json: JSON.parse(r.content[0]!.text), isError: r.isError };
}

describe("ee-tools", () => {
  it("ee.query returns hits from the injected search", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        search: async (q) => ({ hits: [{ id: "1", score: 0.9, text: `match:${q}` }] }) as never,
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    const out = textOf(await handlers["ee.query"]!({ query: "redactor" }));
    expect((out as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.stringify((out as { json: unknown }).json)).toContain("match:redactor");
  });

  it("ee.query returns ee_unavailable when search yields null", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { search: async () => null, health: async () => ({ ok: false, status: 0 }) }),
    );
    const out = textOf(await handlers["ee.query"]!({ query: "x" })) as { json: { error?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ee_unavailable");
  });

  it("ee.health returns the injected status", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { search: async () => null, health: async () => ({ ok: true, status: 200 }) }),
    );
    const out = textOf(await handlers["ee.health"]!({})) as { json: { ok: boolean; status: number } };
    expect(out.json).toEqual({ ok: true, status: 200 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/mcp/__tests__/ee-tools.test.ts`
Expected: FAIL — `Cannot find module '../ee-tools.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/ee-tools.ts`:

```ts
/**
 * src/mcp/ee-tools.ts
 *
 * EE (Experience Engine) MCP tools: ee.query (semantic search) + ee.health.
 * Read-only, synchronous. The EE client's search() returns null on any
 * error/timeout (graceful), so ee.query maps null → ee_unavailable.
 *
 * Dependencies are injected (deps) so unit tests never touch the network.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EESearchResponse } from "../ee/types.js";

export interface EEToolDeps {
  search?: (
    query: string,
    opts: { limit?: number; collections?: string[] },
  ) => Promise<EESearchResponse | null>;
  health?: () => Promise<{ ok: boolean; status: number }>;
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

/** Build a real EE client lazily (token + base URL from ~/.experience/config.json). */
async function realSearch(
  query: string,
  opts: { limit?: number; collections?: string[] },
): Promise<EESearchResponse | null> {
  const { createEEClient } = await import("../ee/client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("../ee/auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).search(query, opts);
}

async function realHealth(): Promise<{ ok: boolean; status: number }> {
  const { createEEClient } = await import("../ee/client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("../ee/auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).health();
}

export function registerEETools(server: McpServer, deps: EEToolDeps = {}): void {
  const search = deps.search ?? realSearch;
  const health = deps.health ?? realHealth;

  server.registerTool(
    "ee.query",
    {
      description:
        "Semantic search over the Experience Engine brain (learned warnings/recipes for this codebase). Returns hits, or an ee_unavailable error if EE is down.",
      inputSchema: {
        query: z.string().min(1).max(1000),
        collections: z.array(z.string().max(100)).max(10).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, collections, limit }) => {
      const resp = await search(query, { limit, collections });
      if (resp === null) {
        return fail("ee_unavailable", "EE search returned no response (server down, timeout, or circuit open)");
      }
      return ok(resp);
    },
  );

  server.registerTool(
    "ee.health",
    { description: "Check Experience Engine server reachability.", inputSchema: {} },
    async () => ok(await health()),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/mcp/__tests__/ee-tools.test.ts`
Expected: PASS (3 tests). Then `bunx tsc --noEmit` → 0 errors. (If `EESearchResponse` is not exported from `src/ee/types.js`, grep `export.*EESearchResponse` across `src/ee/` and fix the import path.)

- [ ] **Step 5: Commit**

```bash
node scripts/check-secrets.mjs
git add src/mcp/ee-tools.ts src/mcp/__tests__/ee-tools.test.ts
git commit --no-verify -m "feat(tools-mcp): ee.query + ee.health MCP tools"
```

---

## Task 3: Forensics tool (`usage.forensics`)

**Files:**
- Create: `src/mcp/forensics-tools.ts`
- Test: `src/mcp/__tests__/forensics-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/__tests__/forensics-tools.test.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { CostForensicsSummary } from "../../cli/cost-forensics.js";
import { registerForensicsTools } from "../forensics-tools.js";

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

const fakeSummary = (id: string): CostForensicsSummary =>
  ({
    sessionId: id,
    rowCount: 1,
    userPromptCount: 1,
    toolCallCount: 0,
    totalInput: 100,
    totalOutput: 50,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalCostUsd: 0.01,
    cacheHitRatio: 0,
    peakSingleCallInput: 100,
    events: [],
  }) as CostForensicsSummary;

describe("forensics-tools", () => {
  it("usage.forensics returns the summary for a unique prefix", async () => {
    const handlers = collectTools((s) =>
      registerForensicsTools(s, { resolve: () => ["sess123"], collect: (id) => fakeSummary(id) }),
    );
    const out = parse(await handlers["usage.forensics"]!({ prefix: "sess" }));
    expect(out.isError).toBeFalsy();
    expect(out.json.sessionId).toBe("sess123");
    expect(out.json.peakSingleCallInput).toBe(100);
  });

  it("usage.forensics returns not_found for zero matches", async () => {
    const handlers = collectTools((s) =>
      registerForensicsTools(s, { resolve: () => [], collect: () => fakeSummary("x") }),
    );
    const out = parse(await handlers["usage.forensics"]!({ prefix: "nope" }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("not_found");
  });

  it("usage.forensics returns ambiguous for multiple matches", async () => {
    const handlers = collectTools((s) =>
      registerForensicsTools(s, { resolve: () => ["a1", "a2"], collect: () => fakeSummary("a1") }),
    );
    const out = parse(await handlers["usage.forensics"]!({ prefix: "a" }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ambiguous");
    expect(out.json.matches).toEqual(["a1", "a2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/mcp/__tests__/forensics-tools.test.ts`
Expected: FAIL — `Cannot find module '../forensics-tools.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/forensics-tools.ts`:

```ts
/**
 * src/mcp/forensics-tools.ts
 *
 * usage.forensics MCP tool: per-session token-cost forensics by id prefix.
 * Read-only (local SQLite). Dependencies injected for unit testability.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CostForensicsSummary } from "../cli/cost-forensics.js";

export interface ForensicsToolDeps {
  resolve?: (prefix: string) => string[];
  collect?: (sessionId: string) => CostForensicsSummary;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(error: string, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error, message, ...extra }) }],
    isError: true,
  };
}

async function defaultResolve(prefix: string): Promise<string[]> {
  const { resolveSessionIds } = await import("../cli/cost-forensics.js");
  return resolveSessionIds(prefix);
}
async function defaultCollect(sessionId: string): Promise<CostForensicsSummary> {
  const { collectCostForensics } = await import("../cli/cost-forensics.js");
  return collectCostForensics(sessionId);
}

export function registerForensicsTools(server: McpServer, deps: ForensicsToolDeps = {}): void {
  const resolve = deps.resolve;
  const collect = deps.collect;

  server.registerTool(
    "usage.forensics",
    {
      description:
        "Per-session token-cost forensics by session-id prefix: peak input, cache-hit ratio, per-event breakdown.",
      inputSchema: { prefix: z.string().min(1).max(100) },
    },
    async ({ prefix }) => {
      let ids: string[];
      try {
        ids = resolve ? resolve(prefix) : await defaultResolve(prefix);
      } catch (e) {
        return fail("db_error", e instanceof Error ? e.message : String(e));
      }
      if (ids.length === 0) return fail("not_found", `no session matches prefix '${prefix}'`);
      if (ids.length > 1) return fail("ambiguous", `prefix '${prefix}' matched ${ids.length} sessions`, { matches: ids });
      try {
        const summary = collect ? collect(ids[0]!) : await defaultCollect(ids[0]!);
        return ok(summary);
      } catch (e) {
        return fail("db_error", e instanceof Error ? e.message : String(e));
      }
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/mcp/__tests__/forensics-tools.test.ts`
Expected: PASS (3 tests). Then `bunx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
node scripts/check-secrets.mjs
git add src/mcp/forensics-tools.ts src/mcp/__tests__/forensics-tools.test.ts
git commit --no-verify -m "feat(tools-mcp): usage.forensics MCP tool"
```

---

## Task 4: Wire the new tools into the server

**Files:**
- Modify: `src/mcp/tools-server.ts`
- Modify: `src/mcp/__tests__/tools-server.smoke.test.ts`

- [ ] **Step 1: Add the registrations**

In `src/mcp/tools-server.ts`, add imports near the existing import of `./self-verify-jobs.js`:

```ts
import { registerEETools } from "./ee-tools.js";
import { registerForensicsTools } from "./forensics-tools.js";
```

In `createToolsServer`, after the existing `registerSelfVerifyTools(server, jm);` line, add:

```ts
  registerEETools(server);
  registerForensicsTools(server);
```

- [ ] **Step 2: Extend the smoke test**

In `src/mcp/__tests__/tools-server.smoke.test.ts`, after the existing
`expect(names).toContain("selfverify.cancel");` assertion, add:

```ts
      expect(names).toContain("ee.query");
      expect(names).toContain("ee.health");
      expect(names).toContain("usage.forensics");
```

- [ ] **Step 3: Run the smoke test**

Run: `bunx vitest run src/mcp/__tests__/tools-server.smoke.test.ts`
Expected: PASS (1 test) — all 8 tool names advertised.

- [ ] **Step 4: Typecheck + full mcp suite**

Run: `bunx tsc --noEmit` → 0 errors.
Run: `bunx vitest run src/mcp/` → all green.

- [ ] **Step 5: Commit**

```bash
node scripts/check-secrets.mjs
git add src/mcp/tools-server.ts src/mcp/__tests__/tools-server.smoke.test.ts
git commit --no-verify -m "feat(tools-mcp): wire ee.* + usage.forensics into the server"
```

---

## Task 5: Final validation

- [ ] **Step 1: Typecheck** — `bunx tsc --noEmit` → 0 errors.
- [ ] **Step 2: New + adjacent tests** — `bunx vitest run src/mcp/ src/cli/cost-forensics.test.ts` → all green.
- [ ] **Step 3: Skip-lint** — `bun run lint:harness-skips` → no NEW skip added by this branch (pre-existing `cost-leak-f1-tui.spec.ts` warning is unrelated).
- [ ] **Step 4: Secret scan** — `node scripts/check-secrets.mjs` → exit 0.

---

## Self-Review

- **Spec coverage:** `ee.query` ✓ (Task 2), `ee.health` ✓ (Task 2), `usage.forensics` ✓ (Task 3), `resolveSessionIds` additive ✓ (Task 1), wired into existing server → 8 tools ✓ (Task 4), DI for tests ✓ (Tasks 2–3), graceful EE-down → `ee_unavailable` ✓ (Task 2), not_found/ambiguous ✓ (Task 3), zod clamps ✓, read-only/no-hardcode ✓, smoke advertises new names ✓ (Task 4).
- **Placeholder scan:** none — every code step is complete. The only narrative instruction is Task 1 Step 2's "reuse the existing DB-seeding pattern," which is necessary because the test-DB setup lives in the file being edited and must be matched, not reinvented.
- **Type consistency:** `EEToolDeps.search/health`, `ForensicsToolDeps.resolve/collect`, `CostForensicsSummary`, `EESearchResponse`, and the local `ok`/`fail` shapes are used identically across Tasks 2–4. `resolveSessionIds` (Task 1) is the exact name imported by `defaultResolve` (Task 3) and asserted in the smoke test indirectly via the tool. Tool names (`ee.query`, `ee.health`, `usage.forensics`) match between registration (Tasks 2–3) and the smoke assertions (Task 4).
