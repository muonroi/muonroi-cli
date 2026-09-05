/**
 * modal-focus-sweep.spec.ts
 *
 * The invariant, swept across the picker/connect modal layer:
 *
 *   **While any modal is open, EXACTLY ONE node in the semantic tree carries the
 *   `focus` flag.** Never zero, never two.
 *
 * Why both failure directions are dead ends for a driver:
 *
 *   - **zero** → `driver.query("focus")` returns `null`. This is the P0-9
 *     symptom measured 2026-09-05 on a live `/ideal` run: the tree was alive and
 *     correct, and a driver still could not tell which surface owned the
 *     keyboard. P0-9 fixed it for the halt/askcard family only; this file sweeps
 *     the picker/connect layer that SELF-IMPROVEMENT-PLAN.md §6.0 open item 4
 *     left outstanding.
 *   - **two** → `driver.query("focus")` THROWS
 *     (`packages/agent-harness-core/src/driver.ts:449` —
 *     `query: ambiguous — selector "focus" matched N nodes`). Strictly worse
 *     than `null`: it takes the driver out with an exception rather than a
 *     falsy value it can branch on.
 *
 * Measured on this file BEFORE the fix (2026-09-05): every case below returned
 * `[]` from `queryAll("focus")`, and `/sandbox` + `/wallet` had no Semantic node
 * of any kind, so `wait_for` timed out on their root ids entirely.
 *
 * The composer publishes `focus` unless `blockPrompt` (use-app-logic.tsx) or one
 * of the `composerFocused` suppressors (prompt-box.tsx:159-165) is set, so every
 * modal must either suppress that mirror AND claim focus itself, or leave the
 * composer as the single owner. `modalOwnsKeyboard` (prompt-box.tsx:231) does
 * the suppressing; `src/ui/modal-focus.ts` decides who claims it.
 *
 * ## Why one child per case
 *
 * A single long-lived agent-mode child exits partway through a sequential
 * sweep. Measured 2026-09-05, and it is NOT modal-related: a probe that only
 * ran `/clear` + `Escape` eight times in one child (no modal opened at any
 * point) died the same way at iteration 5 (`exit code=0`). Reusing one child
 * would make this spec flaky for a reason it does not test, so each case gets a
 * fresh one.
 *
 * Run:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/modal-focus-sweep.spec.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

/**
 * One modal surface: how to open it, the node id it renders, and the node id
 * expected to carry the single `focus` flag while it is open.
 */
type ModalCase = {
  /** Human label used in the test name. */
  label: string;
  /** Slash command that opens it. */
  command: string;
  /** Semantic id of the modal root, waited on before the assertion. */
  rootId: string;
  /** Semantic id expected to be the ONE focus owner while the modal is open. */
  focusOwnerId: string;
};

const CASES: ModalCase[] = [
  { label: "model picker (/model)", command: "/model", rootId: "model-picker", focusOwnerId: "model-picker" },
  { label: "session picker (/resume)", command: "/resume", rootId: "session-picker", focusOwnerId: "session-picker" },
  { label: "mcp browser (/mcp)", command: "/mcp", rootId: "mcp-modal", focusOwnerId: "mcp-modal" },
  { label: "agents browser (/agents)", command: "/agents", rootId: "subagents-modal", focusOwnerId: "subagents-modal" },
  {
    label: "schedule browser (/schedule)",
    command: "/schedule",
    rootId: "schedule-modal",
    focusOwnerId: "schedule-modal",
  },
  {
    label: "connect modal (/remote-control)",
    command: "/remote-control",
    rootId: "connect-modal",
    focusOwnerId: "connect-modal",
  },
  { label: "sandbox picker (/sandbox)", command: "/sandbox", rootId: "sandbox-picker", focusOwnerId: "sandbox-picker" },
  { label: "wallet picker (/wallet)", command: "/wallet", rootId: "wallet-picker", focusOwnerId: "wallet-picker" },
  {
    label: "ee connect card (/ee setup)",
    command: "/ee setup",
    rootId: "ee-connect-card",
    focusOwnerId: "ee-connect-card",
  },
  {
    label: "lsp setup card (/lsp setup)",
    command: "/lsp setup",
    rootId: "lsp-setup-card",
    focusOwnerId: "lsp-setup-card",
  },
];

describe("modal focus sweep — exactly one focus node per open modal", () => {
  for (const c of CASES) {
    it(`${c.label} publishes exactly one focus node`, async () => {
      const home = mkdtempSync(join(tmpdir(), "muonroi-modal-focus-home-"));
      const ctx = await spawnHarness({ cwd: home, env: { MUONROI_NO_SHELL_HOLD: "1" } });
      const { driver } = ctx;
      try {
        // Mount guard: React up, composer present, before driving the command.
        await driver.wait_for({ selector: "role=textbox", timeoutMs: 20_000 });
        // With nothing open the composer is the sole owner.
        expect(driver.queryAll("focus").map((n) => n.id)).toEqual(["composer"]);

        driver.type(c.command);
        driver.press("Enter");
        await driver.wait_for({ selector: `id=${c.rootId}`, timeoutMs: 20_000 });

        // Reported as ids so a failure names WHICH nodes collided — or that none did.
        expect(driver.queryAll("focus").map((n) => n.id)).toEqual([c.focusOwnerId]);
        // The whole point: query("focus") must resolve — not throw, not return null.
        expect(driver.query("focus")?.id).toBe(c.focusOwnerId);
        // The surface must also announce itself as a modal so a driver can see the stack.
        expect(driver.query(`id=${c.rootId}`)?.isModal).toBe(true);

        // Dismiss: ownership hands back to the composer, still exactly one owner.
        driver.press("Escape");
        const deadline = Date.now() + 10_000;
        while (driver.queryAll(`id=${c.rootId}`).length > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(driver.queryAll(`id=${c.rootId}`).length).toBe(0);
        expect(driver.queryAll("focus").map((n) => n.id)).toEqual(["composer"]);
      } finally {
        ctx.proc.kill();
        ctx.cleanup();
        try {
          rmSync(home, { recursive: true, force: true });
        } catch (err) {
          // Windows holds the child's cwd handle briefly after kill(); a leftover
          // temp dir must not fail the case, but must not vanish silently either.
          console.error(`[modal-focus-sweep] temp home cleanup failed: ${(err as Error)?.message ?? err}`, { home });
        }
      }
    }, 90_000);
  }

  /**
   * The needs-key card is not reachable by a slash command — it is raised at
   * boot by `warmMcpClients` when an ENABLED MCP server has no key (same setup
   * as tests/harness/mcp-needs-key.spec.ts). It is worth its own case because
   * it is one of the two cards whose focus flag moves BETWEEN nodes: the token
   * field owns it in `input` mode, the card root owns it otherwise
   * (src/ui/modals/mcp-needs-key-card.tsx). Both modes must still total one.
   */
  it("mcp needs-key card publishes exactly one focus node", async () => {
    const home = mkdtempSync(join(tmpdir(), "muonroi-modal-focus-needskey-"));
    mkdirSync(join(home, ".muonroi-cli"), { recursive: true });
    writeFileSync(
      join(home, ".muonroi-cli", "user-settings.json"),
      JSON.stringify({
        mcp: {
          servers: [
            {
              id: "tavily",
              label: "Tavily Web Search",
              enabled: true,
              transport: "stdio",
              command: "bun",
              args: ["x", "-y", "tavily-mcp"],
              env: { TAVILY_API_KEY: "" },
            },
          ],
        },
      }),
      "utf8",
    );
    const ctx = await spawnHarness({
      cwd: home,
      env: { MUONROI_NO_SHELL_HOLD: "1", TAVILY_API_KEY: "" },
    });
    const { driver } = ctx;
    try {
      await driver.wait_for({ selector: "id=mcp-needs-key-card", timeoutMs: 30_000 });
      // Action-list mode: the card root is the owner.
      expect(driver.queryAll("focus").map((n) => n.id)).toEqual(["mcp-needs-key-card"]);
      expect(driver.query("focus")?.id).toBe("mcp-needs-key-card");
    } finally {
      ctx.proc.kill();
      ctx.cleanup();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch (err) {
        console.error(`[modal-focus-sweep] temp home cleanup failed: ${(err as Error)?.message ?? err}`, { home });
      }
    }
  }, 90_000);
});
