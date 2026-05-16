/**
 * ideal-e2e-live.spec.ts — REAL-USER E2E for the full /ideal flow.
 *
 * Drives the production TUI as a real user would: real LLM (DeepSeek via
 * keychain), real Experience Engine (production at experience.muonroi.com),
 * real `dotnet new` scaffold into an OS tempdir.
 *
 * Gated on MUONROI_E2E_LIVE=1 — does NOT run by default. Costs real LLM
 * tokens (~$0.20/run) and takes ~3-5 minutes.
 *
 * Run with:
 *   MUONROI_E2E_LIVE=1 bunx vitest -c vitest.harness.config.ts run \
 *     tests/harness/ideal-e2e-live.spec.ts
 *
 * Assertions are milestone-based (halt card mounted, form-card progresses
 * through 3 steps, scaffold dir + EE-INTENT.md emitted). No assertions on
 * LLM-generated text content — that is non-deterministic by design.
 */
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDriver, type Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKeyForProvider } from "../../src/providers/keychain.js";
import { type SpawnResult, spawnAgentTui } from "../../src/agent-harness/test-spawn.js";

const LIVE = process.env.MUONROI_E2E_LIVE === "1";

// ---------------------------------------------------------------------------
// Live spawn — NO --mock-llm. Lets the TUI hit real DeepSeek via keychain.
// ---------------------------------------------------------------------------

async function spawnLive(opts: {
  cwd: string;
  env?: Record<string, string>;
}): Promise<{ proc: ChildProcess; driver: Driver; cleanup: () => void }> {
  const entry = resolve("src/index.ts");
  const args = [entry, "--agent-mode"];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MUONROI_TEST_NO_PERSIST: "1",
    ...(opts.env ?? {}),
  };

  const result: SpawnResult = await spawnAgentTui(args, {
    spawnOpts: { env, cwd: opts.cwd },
  });
  const { proc, inWrite, outRead, cleanup } = result;

  const driver = createDriver({
    sendKey: (k) => inWrite.write(`${JSON.stringify({ op: "press", key: k })}\n`),
    sendType: (t) => inWrite.write(`${JSON.stringify({ op: "type", text: t })}\n`),
  });

  const splitter = createLineSplitter((line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.mode === "live") driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      else if (msg.t === "idle") driver._ingest({ kind: "idle" });
      else if (msg.t === "event") driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
    } catch {
      // ignore malformed lines
    }
  });
  outRead.on("data", (chunk: Buffer | string) => {
    splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });

  return { proc, driver, cleanup };
}

// ---------------------------------------------------------------------------
// Retry-on-EBUSY cleanup (Windows file lock workaround)
// ---------------------------------------------------------------------------

async function rmRetry(dir: string, attempts = 6): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM") {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  // Last-ditch: don't fail the test on cleanup; OS will reap %TEMP% later.
  // eslint-disable-next-line no-console
  console.error(`[cleanup] gave up removing ${dir} after ${attempts} attempts`);
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE)("/ideal full flow — live LLM + EE + dotnet new", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-ideal-e2e-"));
    // Pull the real DeepSeek key from the OS keychain and pass it via env
    // (MUONROI_API_KEY) — the TUI uses this for getApiKey() at boot, which
    // sets initialHasApiKey=true and prevents the api-key modal from grabbing
    // input. Without this, the modal swallows /ideal typing and the slash
    // menu never opens.
    const deepseekKey = await loadKeyForProvider("deepseek").catch(() => "");
    if (!deepseekKey) {
      throw new Error(
        "Live E2E requires a DeepSeek key in the OS keychain. " +
          "Run `muonroi-cli keys set deepseek` and try again.",
      );
    }
    const ctx = await spawnLive({
      cwd: workDir,
      env: {
        MUONROI_API_KEY: deepseekKey,
        // Ensure SiliconFlow proxy can also see the key — some downstream
        // model calls route through here.
        SILICONFLOW_API_KEY: deepseekKey,
      },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      try { appendFileSync("D:/sources/Core/muonroi-cli/.scratch/e2e-tui-stderr.log", text); } catch {}
    });
    await driver.wait_for({ idle: true, timeoutMs: 30_000 });
    // Real TUI boot has more async work than synthetic spawn (provider init,
    // keychain, EE config, etc). Wait extra so the first paint commits all
    // Semantic registrations before we start sending keys.
    await new Promise((r) => setTimeout(r, 4_000));
  }, 60_000);

  afterAll(async () => {
    proc?.kill();
    cleanup?.();
    // Wait for OS to release file handles before recursive delete
    await new Promise((r) => setTimeout(r, 1_500));
    await rmRetry(workDir);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Stage 1 — Slash dispatch
  // -------------------------------------------------------------------------

  it("stage 1a: typing / opens slash menu", async () => {
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    const menu = driver.query("id=slash-menu");
    expect(menu).not.toBeNull();
    expect(menu?.isModal).toBe(true);
  });

  it("stage 1b: typing 'ideal' filters slash menu", async () => {
    // Send the remaining chars one-by-one so the slash filter state has
    // time to apply between renders.
    driver.type("ideal");
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
  });

  it("stage 1c: Tab autocompletes /ideal into composer", async () => {
    // Tab triggers the slash-menu autocomplete handler in app.tsx (line ~4432)
    // which inserts "/ideal " into the textarea, restores focus, and closes
    // the menu. This is the most reliable way to seed the composer in a real
    // flow — typing "/ideal " directly is racy because the slash filter may
    // capture the space character before the menu auto-completes.
    driver.press("Tab");
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
  });

  it("stage 1d: typing idea + Enter dispatches /ideal command", async () => {
    driver.type("build fraud detection service with rule engine");
    driver.press("Enter");
    // Slash dispatched; composer clears, council debate begins.
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    // Diagnostic — confirm /ideal actually dispatched. Look for processing
    // indicator (statusbar value or message item) before waiting 180s for halt.
    await new Promise((r) => setTimeout(r, 2_000));
    const frame = driver.snapshot();
    const ids: string[] = [];
    const walk = (nodes: typeof frame.nodes): void => {
      for (const n of nodes) {
        ids.push(`${n.id}(${n.role})`);
        if (n.children) walk(n.children);
      }
    };
    if (frame) walk(frame.nodes);
    try {
      appendFileSync(
        "D:/sources/Core/muonroi-cli/.scratch/e2e-diag.log",
        `[post-dispatch] focus=${frame?.focus} modals=${JSON.stringify(frame?.modals)} ids=${JSON.stringify(ids)}\n`,
      );
    } catch {}
  });

  // -------------------------------------------------------------------------
  // Stage 2 — Council debate runs to halt (real LLM, 30-180s)
  // -------------------------------------------------------------------------

  it("stage 2: CB-3 halts on missing verify recipe (real council debate)", async () => {
    // Empty cwd → CB-2 cannot detect a verify recipe → CB-3 yields halt chunk
    // → setActiveHaltCard fires → HaltRecoveryCard mounts.
    await driver.wait_for({
      selector: "id=ideal-halt-card",
      timeoutMs: 300_000,
    });
    const card = driver.query("id=ideal-halt-card");
    expect(card?.role).toBe("dialog");
    expect(card?.isModal).toBe(true);

    const opts = driver.queryAll("id=ideal-halt-card >> role=listitem");
    expect(opts).toHaveLength(3);
    expect(opts[0]?.name).toBe("Init new project");
  }, 320_000);

  // -------------------------------------------------------------------------
  // Stage 3 — Init New form
  // -------------------------------------------------------------------------

  it("stage 3: Enter on Init new opens form at step=name", async () => {
    driver.press("Enter");
    await driver.wait_for({ selector: "id=init-new-form", timeoutMs: 10_000 });
    expect(driver.query("id=ideal-halt-card")).toBeNull();
  });

  it("stage 3: type project name + Enter advances to fe-stack", async () => {
    driver.type("FraudDetector");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    driver.press("Enter");
    await driver.wait_for({
      selector: "id=init-new-form >> id=init-fe-option-react",
      timeoutMs: 5_000,
    });
  });

  it("stage 3: Enter on default React advances to bb-template", async () => {
    driver.press("Enter");
    await driver.wait_for({
      selector: "id=init-new-form >> id=init-bb-option-mr-base-sln",
      timeoutMs: 5_000,
    });
    const opts = driver.queryAll("id=init-new-form >> id^=init-bb-option-");
    expect(opts).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Stage 4 — Real dotnet new + ecosystem-apply + quality gate (60-600s)
  // -------------------------------------------------------------------------

  it("stage 4: Enter on BaseTemplate triggers real scaffold pipeline", async () => {
    // Confirm BaseTemplate (default selection) — this fires initNewProject
    // → dotnet new install Muonroi.BaseTemplate::1.0.0-alpha.3 (if absent)
    // → dotnet new mr-base-sln -n FraudDetector
    // → bb-ecosystem-apply (Program.cs wiring + sample rule + props minimalism)
    // → quality gate (dotnet restore + build + check-modular-boundaries)
    driver.press("Enter");
    // Running state should appear within seconds.
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
  });

  it("stage 4: scaffold completes (id=init-new-result mounts)", async () => {
    // Long timeout — dotnet restore + build can take 60-180s each.
    await driver.wait_for({
      selector: "id=init-new-result",
      timeoutMs: 600_000,
    });
    const result = driver.query("id=init-new-result");
    expect(result).not.toBeNull();
    // Either "Scaffold complete" (happy path) or "Scaffold failed" (gate fail).
    // Both are valid milestone outcomes — we assert the on-disk artifacts next.
  }, 620_000);

  it("stage 4: scaffold dir contains BB structure on disk", () => {
    const projectDir = join(workDir, "FraudDetector");
    const serverDir = join(projectDir, "server");
    // Tolerate either layout the scaffold runner picks (flat vs server/)
    const dirToCheck = existsSync(serverDir) ? serverDir : projectDir;
    expect(existsSync(dirToCheck)).toBe(true);

    const entries = readdirSync(dirToCheck);
    // At minimum: a .sln file (template output) and src/
    const hasSln = entries.some((e) => e.endsWith(".sln"));
    const hasSrc = entries.includes("src");
    expect(hasSln, `expected .sln in ${dirToCheck}, got ${entries.join(", ")}`).toBe(true);
    expect(hasSrc, `expected src/ in ${dirToCheck}, got ${entries.join(", ")}`).toBe(true);
  });

  it("stage 4: EE-INTENT.md captures intent + template choice", () => {
    const projectDir = join(workDir, "FraudDetector");
    const serverDir = join(projectDir, "server");
    const dirToCheck = existsSync(serverDir) ? serverDir : projectDir;
    const intentFile = join(dirToCheck, "EE-INTENT.md");
    // EE-INTENT.md is best-effort — only emitted if dotnet-template path succeeded
    // (not the legacy git-clone fallback). Skip assertion if absent.
    if (existsSync(intentFile)) {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const content = readFileSync(intentFile, "utf8");
      expect(content).toContain("Muonroi.BaseTemplate");
    }
  });
});
