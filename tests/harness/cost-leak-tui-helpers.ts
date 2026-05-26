/**
 * tests/harness/cost-leak-tui-helpers.ts
 *
 * Shared helpers for the Phase F cost-leak TUI specs. Wraps the common
 * spawn → drive → dump → load cycle so each spec file stays focused on its
 * one invariant.
 *
 * Cross-process boundary: the parent vitest spec writes a temp fixture +
 * dump path, the child TUI spawns with --mock-llm <dir> and
 * MUONROI_MOCK_MODEL_DUMP=<file>. After at least one streamText call, the
 * child dumps doStreamCalls (atomic rename). Parent loads and asserts.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Driver } from "@muonroi/agent-harness-core/driver";
import { spawnHarness } from "./helpers.js";

/**
 * StreamChunks shape matching src/agent-harness/mock-model.ts. Kept as
 * `unknown[]` here to avoid pulling AI SDK types into a test helper —
 * fixtures are serialized to JSON anyway, so the structural shape is what
 * the loader cares about.
 */
export type StreamChunks = unknown[];

export interface ModelFixture {
  /** Single round or array-of-rounds. */
  stream: StreamChunks | StreamChunks[];
  /** OAuth-style param drops. */
  unsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
  /** Provider-options injected on every call (mirrors OAuth registry). */
  defaultProviderOptions?: Record<string, unknown>;
  provider?: string;
  modelId?: string;
}

export interface CostLeakHarness {
  proc: ChildProcess;
  driver: Driver;
  /** Path the child writes doStreamCalls to. Read after each prompt. */
  dumpPath: string;
  /** Temp directory the helper owns — cleaned up by `cleanup()`. */
  workDir: string;
  cleanup(): void;
}

/** Build a one-finish-stop text-only stream. */
export function makeTextStream(text: string, inputTokens = 10, outputTokens = 5): StreamChunks {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
      },
    },
  ];
}

export interface SpawnCostLeakOptions {
  /**
   * Override the model id passed to the spawned TUI. Defaults to a SiliconFlow
   * model id (no real network call because `__muonroiMockModel` intercepts).
   * Set to e.g. "gpt-5.4-mini" to route capability dispatch through the OpenAI
   * provider — required for specs that assert openai-specific providerOptions
   * such as `promptCacheKey` (F1) which only `OpenAIProviderCapabilities` sets.
   */
  modelId?: string;
  /**
   * Override the API key passed via `-k`. Defaults to a stub — the mock
   * intercepts before any auth happens, so any non-empty value works.
   */
  apiKey?: string;
}

/**
 * Spawn the TUI with the given fixture installed and a dump path wired up.
 * Caller should:
 *   1. drive driver.type("...") / driver.press("Enter")
 *   2. wait for the LLM round-trip via wait_for + a small sleep
 *   3. call exitTuiAndLoadDump(handle) to get InspectedCall[]
 */
export async function spawnCostLeakHarness(
  fixture: ModelFixture,
  opts: SpawnCostLeakOptions = {},
): Promise<CostLeakHarness> {
  const workDir = mkdtempSync(join(tmpdir(), "muonroi-cl-tui-"));
  const fixDir = join(workDir, "fix");
  mkdirSync(fixDir);
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({ responses: [{ match: "*", text: "continue. summary: mock succeeding." }], model: fixture }),
    "utf8",
  );
  const dumpPath = join(workDir, "calls.json");

  const modelId = opts.modelId ?? "deepseek-ai/DeepSeek-V4-Flash";
  const apiKey = opts.apiKey ?? "FAKE_KEY_FOR_TESTS";

  const ctx = await spawnHarness({
    extraArgs: ["-k", apiKey, "-m", modelId, "--mock-llm", fixDir],
    env: {
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_NO_SHELL_HOLD: "1",
      // Cost-leak specs verify provider-layer behaviour (param drops, cache
      // keys, message compaction). They do NOT exercise PIL discovery, but
      // discovery WILL fire interview askcards for the synthetic test prompts
      // (e.g. "please dispatch a sub-agent...") and block streamText until
      // the test answers — which it never does, producing a dump file with
      // zero recorded calls and the cryptic "expected 0 to be greater than
      // or equal to 3" failure seen in CI runs 26431673369 / 26431994835.
      // Disabling discovery is the surgical fix: the specs need streamText
      // round-trips, not gap-elicitation UX.
      MUONROI_PIL_DISCOVERY: "0",
    },
  });

  // Bubble child stderr so dumpRecordings failures surface in CI logs.
  ctx.proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[child] ${chunk.toString("utf8")}`);
  });

  await ctx.driver.wait_for({ idle: true, timeoutMs: 15_000 });
  // POSIX race: the first idle event can fire after the empty seq=0 frame
  // before React mounts. Wait for the textbox to actually appear before
  // returning, so callers can dispatch keystrokes to a fully-rendered TUI.
  await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });

  return {
    proc: ctx.proc,
    driver: ctx.driver,
    dumpPath,
    workDir,
    cleanup: () => {
      try {
        ctx.proc.kill();
      } catch {
        // ignore
      }
      ctx.cleanup?.();
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Send /exit, wait for proc.exit (or hard-kill after timeoutMs), and poll
 * for the dump file. Returns the dump path so the caller can call
 * loadDumpedRecordings on it.
 */
export async function exitTuiAndWaitForDump(handle: CostLeakHarness, timeoutMs = 20_000): Promise<void> {
  handle.driver.type("/exit");
  handle.driver.press("Enter");

  await new Promise<void>((resolve) => {
    if (handle.proc.exitCode !== null) {
      resolve();
      return;
    }
    handle.proc.once("exit", () => resolve());
    setTimeout(() => {
      try {
        handle.proc.kill();
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
  });

  // Poll briefly for the file — atomic rename means it appears all at once.
  // The dump is also written after each doStream call (see src/index.ts H3
  // hook) so this is usually already present by the time we get here.
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !existsSync(handle.dumpPath)) {
    await new Promise((r) => setTimeout(r, 100));
  }
}
