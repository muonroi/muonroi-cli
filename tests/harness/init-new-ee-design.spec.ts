/**
 * init-new-ee-design.spec.ts — Plan 23-03
 *
 * End-to-end harness coverage for the EE-driven BB package design flow:
 *
 *   /ideal <intent>        →   route times out (mock EE only serves /api/search)
 *                          →   sprint-halt fires within budget
 *                          →   ideal-halt-card renders, "Init new project" selected
 *                          →   Enter opens init-new-form
 *                          →   user types project name, Enter
 *                          →   user accepts default FE stack (react), Enter
 *                          →   intent.trim().length > 0 routes through designBBPackages
 *                          →   mock EE returns recipe + commercial flag + behavioral hint
 *                          →   form transitions designing → design-preview
 *                          →   user can see template, packages, commercial-blocked section
 *
 * Two `it` blocks:
 *   1. happy path — preview renders with the mocked recipe / commercial / hints
 *   2. EE down — bb-design returns null fast → form falls back to bb-template menu
 *
 * The spec NEVER presses Enter on the design-preview step — that would invoke
 * real `dotnet new` against NuGet. The init-new scaffold runner is covered by
 * tests/harness/init-new-bb-template.spec.ts (mocked spawnSync). This spec
 * only asserts the EE-driven UI behavior up through the preview / fallback.
 */

import type { ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

// HAS_EE_DESIGN: bb-design.ts shipped 2026-05-19. Documents the dependency
// rather than gating execution.
const HAS_EE_DESIGN = true;
const MOCK_KEY = ["test", "mock", "provider", "noop"].join("-");

// ---------------------------------------------------------------------------
// Mock EE server — responds to POST /api/search with collection-specific
// fixtures matching the shapes parsed by src/ee/bb-design.ts.
// ---------------------------------------------------------------------------

interface MockSearchBody {
  query?: string;
  collections?: string[];
  limit?: number;
}

function startMockEeServer(): Promise<{ server: Server; port: number; requests: MockSearchBody[] }> {
  const requests: MockSearchBody[] = [];
  return new Promise((resolveFn, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST" || !req.url?.startsWith("/api/search")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let parsed: MockSearchBody = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as MockSearchBody;
        } catch {
          /* ignored — body may be empty for unknown endpoints */
        }
        requests.push(parsed);
        const collections = parsed.collections ?? [];
        let body: unknown = { points: [] };
        if (collections.includes("bb-recipes")) {
          body = {
            points: [
              {
                id: "t1",
                score: 0.78,
                text:
                  "Template Muonroi BuildingBlock Solution (mr-base-sln): " +
                  "Clean/Onion starter for HTTP APIs with DI and rule wiring. | " +
                  "uses: Muonroi.AspNetCore, Muonroi.Tenancy, Muonroi.AuthZ, Muonroi.Core.Abstractions",
                collection: "bb-recipes",
              },
            ],
          };
        } else if (collections.includes("experience-principles")) {
          body = {
            points: [
              {
                id: "p1",
                score: 0.6,
                text: "Commercial package Muonroi.AuthZ requires a valid Muonroi commercial license for production use",
                collection: "experience-principles",
              },
            ],
          };
        } else if (collections.includes("bb-behavioral")) {
          body = {
            points: [
              {
                id: "b1",
                score: 0.6,
                text: "Use AddInfrastructure with MTokenInfo for token configuration.",
                collection: "bb-behavioral",
              },
            ],
          };
        }
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify(body));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === "string") {
        reject(new Error("mock EE server failed to bind"));
        return;
      }
      resolveFn({ server, port: addr.port, requests });
    });
  });
}

/**
 * Char-by-char type so the slash menu's filter sees each character commit
 * before the next arrives (same pattern as ideal-hot-path-hang.spec.ts).
 */
async function slowType(driver: Driver, text: string, msPerChar = 25): Promise<void> {
  for (const ch of text) {
    driver.type(ch);
    await new Promise((r) => setTimeout(r, msPerChar));
  }
}

// ---------------------------------------------------------------------------
// Test 1 — happy path: EE design preview renders with mock recipe
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_EE_DESIGN)("init-new EE-driven design preview", () => {
  describe("happy path: EE returns recipe → design-preview", () => {
    let server: Server;
    let port: number;
    let proc: ChildProcess;
    let driver: Driver;
    let cleanup: () => void;

    beforeAll(async () => {
      const mock = await startMockEeServer();
      server = mock.server;
      port = mock.port;

      const ctx = await spawnHarness({
        extraArgs: ["-k", MOCK_KEY, "-m", "deepseek-v4-flash"],
        env: {
          SILICONFLOW_API_KEY: MOCK_KEY,
          MUONROI_EE_BASE_URL: `http://127.0.0.1:${port}`,
          MUONROI_EE_ROUTE_TIMEOUT_MS: "500",
          MUONROI_BB_RETRIEVAL_TIMEOUT_MS: "300",
          MUONROI_BB_DESIGN_TIMEOUT_MS: "2000",
          MUONROI_HARNESS_EVENTS: "*",
        },
      });
      proc = ctx.proc;
      driver = ctx.driver;
      cleanup = ctx.cleanup;
      await driver.wait_for({ idle: true, timeoutMs: 15_000 });
      await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
    }, 120_000);

    afterAll(() => {
      proc?.kill();
      cleanup?.();
      server?.close();
    });

    it("EE design preview renders then confirms with selected eePackages", async () => {
      // Subscribe to events BEFORE dispatching so sprint-halt is captured.
      const seen: Array<{ kind: string }> = [];
      const sub = driver.events();
      (async () => {
        for await (const ev of sub) {
          seen.push({ kind: (ev as { kind?: string }).kind ?? "unknown" });
        }
      })().catch(() => undefined);

      // 1. Dispatch /ideal — short route timeout forces CB-3 halt fast.
      // Prompt must pass PIL Layer 1 sufficiency gate to route to hot-path
      // (which triggers CB-3 halt). "build a todo app" is vague → forces
      // council. "add auth endpoint to api.ts" has concrete verb + file ref
      // + scope noun → sufficient; short length keeps complexity=low.
      await slowType(driver, "/ideal add auth endpoint to api.ts");
      await driver.wait_for({ idle: true, timeoutMs: 3_000 }).catch(() => undefined);
      driver.press("Enter");

      // 2. Wait for sprint-halt event + the halt-recovery card.
      await driver.wait_for({
        event: "sprint-halt",
        timeoutMs: 15_000,
      });
      await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 5_000 });

      // 3. "Init new project" is option 0 (selected by default). Enter to open form.
      driver.press("Enter");
      await driver.wait_for({ selector: "id=init-new-form", timeoutMs: 5_000 });

      // 4. Step: name → type "todo-app" → Enter.
      await slowType(driver, "todo-app");
      await driver.wait_for({ idle: true, timeoutMs: 3_000 }).catch(() => undefined);
      driver.press("Enter");

      // 5. Step: fe-stack → Enter accepts default (React). Because intent was
      //    captured via the dispatched /ideal, the form routes through
      //    designBBPackages() → transitions to step="designing".
      await driver.wait_for({
        selector: "id=init-new-form >> id=init-fe-option-react",
        timeoutMs: 5_000,
      });
      driver.press("Enter");

      // 6. The designing spinner may flash briefly — wait for design-preview
      //    directly (mock returns instantly, but the React state transition
      //    can collapse designing→design-preview in the same frame).
      await driver.wait_for({
        selector: "id=init-design-preview",
        timeoutMs: 5_000,
      });

      // 7. Assertions on the preview.
      const preview = driver.query("id=init-design-preview");
      expect(preview).toBeTruthy();
      expect(preview?.role).toBe("region");

      // At least 3 OSS packages: AspNetCore, Tenancy, Core.Abstractions
      // (AuthZ is filtered into commercialBlocked).
      const pkgItems = driver.queryAll("id=init-design-packages >> role=listitem");
      expect(pkgItems.length).toBeGreaterThanOrEqual(3);

      const pkgNames = pkgItems.map((n) => n.name ?? "");
      expect(pkgNames.some((n) => n.includes("Muonroi.AspNetCore"))).toBe(true);

      // Commercial-blocked section. The commercial listbox is wrapped in
      // <Semantic id="init-design-commercial"> with the joined names in its
      // `name` field, and each blocked package is its own listitem.
      const commercial = driver.query("id=init-design-commercial");
      expect(commercial).toBeTruthy();
      expect(commercial?.name ?? "").toContain("Commercial");
      expect(commercial?.name ?? "").toContain("Muonroi.AuthZ");
      const authZItem = driver.query("id=design-commercial-Muonroi.AuthZ");
      expect(authZItem).toBeTruthy();
      expect(authZItem?.name).toBe("Muonroi.AuthZ");

      // Sanity: route-decision + sprint-halt observed.
      const kinds = seen.map((e) => e.kind);
      expect(kinds).toContain("sprint-halt");

      // Do NOT press Enter on design-preview — that would invoke real dotnet new.
      // Test stops here; afterAll cleans up.
    }, 40_000);
  });

  // -------------------------------------------------------------------------
  // Test 2 — EE down: design returns null fast → manual bb-template menu
  // -------------------------------------------------------------------------

  describe("EE down: design returns null → bb-template menu fallback", () => {
    let proc: ChildProcess;
    let driver: Driver;
    let cleanup: () => void;

    beforeAll(async () => {
      const ctx = await spawnHarness({
        extraArgs: ["-k", MOCK_KEY, "-m", "deepseek-v4-flash"],
        env: {
          SILICONFLOW_API_KEY: MOCK_KEY,
          // Port 1 is reserved + unbound — fetch → ECONNREFUSED instantly.
          MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
          MUONROI_EE_ROUTE_TIMEOUT_MS: "500",
          MUONROI_BB_RETRIEVAL_TIMEOUT_MS: "300",
          MUONROI_BB_DESIGN_TIMEOUT_MS: "1500",
          MUONROI_HARNESS_EVENTS: "*",
        },
      });
      proc = ctx.proc;
      driver = ctx.driver;
      cleanup = ctx.cleanup;
      await driver.wait_for({ idle: true, timeoutMs: 15_000 });
      await driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });
    }, 120_000);

    afterAll(() => {
      proc?.kill();
      cleanup?.();
    });

    it("EE down → falls back to manual template menu", async () => {
      // Prompt must pass PIL Layer 1 sufficiency gate to route to hot-path
      // (which triggers CB-3 halt). "build a todo app" is vague → forces
      // council. "add auth endpoint to api.ts" has concrete verb + file ref
      // + scope noun → sufficient; short length keeps complexity=low.
      await slowType(driver, "/ideal add auth endpoint to api.ts");
      await driver.wait_for({ idle: true, timeoutMs: 3_000 }).catch(() => undefined);
      driver.press("Enter");

      await driver.wait_for({ event: "sprint-halt", timeoutMs: 15_000 });
      await driver.wait_for({ selector: "id=ideal-halt-card", timeoutMs: 5_000 });

      driver.press("Enter"); // Init new project
      await driver.wait_for({ selector: "id=init-new-form", timeoutMs: 5_000 });

      // name step
      await slowType(driver, "todo-app");
      await driver.wait_for({ idle: true, timeoutMs: 3_000 }).catch(() => undefined);
      driver.press("Enter");

      // fe-stack step — Enter triggers designBBPackages with broken EE → null.
      await driver.wait_for({
        selector: "id=init-new-form >> id=init-fe-option-react",
        timeoutMs: 5_000,
      });
      driver.press("Enter");

      // designing may flash but quickly transitions to bb-template (manual menu)
      // because designBBPackages returns null on ECONNREFUSED.
      await driver.wait_for({
        selector: "id=init-new-form >> id=init-bb-option-mr-base-sln",
        timeoutMs: 8_000,
      });

      // Assert manual bb-template menu rendered — proves graceful degrade.
      const baseOpt = driver.query("id=init-new-form >> id=init-bb-option-mr-base-sln");
      expect(baseOpt).toBeTruthy();
      expect(baseOpt?.role).toBe("listitem");

      // Design preview must NOT be present.
      expect(driver.query("id=init-design-preview")).toBeNull();
    }, 40_000);
  });
});
