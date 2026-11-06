/**
 * tests/harness/agents-md-only.spec.ts
 *
 * Owner decision (Codex parity): project instructions come from AGENTS.md
 * only. A project that also carries CLAUDE.md / GEMINI.md must NOT have them
 * injected into the orchestrator's system prompt — that was ~46.5k chars per
 * call in muonroi-cli itself (CLAUDE.md 46,800 B loaded alongside AGENTS.md).
 *
 * Spawns the real TUI in an isolated git project seeded with all three files,
 * sends one prompt, and inspects the recorded provider calls dumped by the
 * mock model: the main-agent system prompt carries the AGENTS.md marker and
 * neither the CLAUDE.md nor the GEMINI.md marker.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CostLeakHarness,
  exitTuiAndWaitForDump,
  makeTextStream,
  spawnCostLeakHarness,
} from "./cost-leak-tui-helpers.js";
import { isMainAgentCall, loadDumpedRecordings } from "./recording.js";

const AGENTS_MARKER = "AGENTS_MD_ONLY_SENTINEL_7f3a";
const CLAUDE_MARKER = "CLAUDE_MD_MUST_NOT_LOAD_91bc";
const GEMINI_MARKER = "GEMINI_MD_MUST_NOT_LOAD_42de";

describe("AGENTS.md only: the system prompt carries AGENTS.md, never CLAUDE.md / GEMINI.md", () => {
  let handle: CostLeakHarness;

  beforeAll(async () => {
    handle = await spawnCostLeakHarness(
      { stream: makeTextStream("ok") },
      {
        projectFiles: {
          // A real project root, so the loader walks root → cwd (Codex parity).
          ".git/HEAD": "ref: refs/heads/main\n",
          "AGENTS.md": `# Project rules\n${AGENTS_MARKER}: follow the project rules.\n`,
          "CLAUDE.md": `# Claude rules\n${CLAUDE_MARKER}\n`,
          "GEMINI.md": `# Gemini rules\n${GEMINI_MARKER}\n`,
        },
      },
    );
  }, 120_000);

  afterAll(() => {
    handle?.cleanup();
  });

  it("main-agent system prompt contains the AGENTS.md text and no CLAUDE.md / GEMINI.md marker", async () => {
    handle.driver.type("hello");
    handle.driver.press("Enter");

    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 15_000 });
    await handle.driver.wait_for({ idle: true, timeoutMs: 10_000 });
    // Let the continuous-dump hook flush the completed doStream (src/index.ts H3 hook).
    await new Promise((r) => setTimeout(r, 2000));

    await exitTuiAndWaitForDump(handle);

    const calls = loadDumpedRecordings(handle.dumpPath);
    const main = calls.filter(isMainAgentCall);
    expect(main.length, `no main-agent call among ${calls.length} recorded calls`).toBeGreaterThanOrEqual(1);
    for (const c of main) {
      expect(c.systemText).toContain(AGENTS_MARKER);
    }
    for (const c of calls) {
      expect(c.systemText).not.toContain(CLAUDE_MARKER);
      expect(c.systemText).not.toContain(GEMINI_MARKER);
    }
  }, 60_000);
});
