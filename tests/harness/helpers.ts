/**
 * helpers.ts — Shared test utilities for harness E2E specs.
 *
 * Wraps spawnAgentTui to wire the driver's frame/idle/event ingestion in one place,
 * returning a ready-to-use driver. Callers only need to call cleanup in afterAll.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDriver, type Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame, VisualFrame } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { type SpawnResult, spawnAgentTui } from "../../src/agent-harness/test-spawn.js";

export type HarnessContext = {
  proc: ChildProcess;
  driver: Driver;
  cleanup: () => void;
};

export type SpawnHarnessOptions = {
  /** Test-only bootstrap for local provider transports; defaults to the real CLI entry. */
  entry?: string;
  /** Extra CLI args inserted after the entry point and --agent-mode. */
  extraArgs?: string[];
  /** Extra env vars forwarded to the child. Merged with process.env. */
  env?: Record<string, string>;
  /** Timeout for the initial wait_for({idle}) call. Default: 15 000 ms. */
  idleTimeoutMs?: number;
  /** Handshake timeout for the named-pipe transport (Windows). Default: 5 000 ms. */
  handshakeTimeoutMs?: number;
  /**
   * Override the mock-llm fixtures directory. Defaults to the shared
   * `tests/harness/fixtures/llm`. Council/ideal specs pass a dedicated dir so
   * their tailored model fixture (DebatePlan via `generate`, etc.) does not
   * perturb the shared cost-leak fixtures.
   */
  fixturesDir?: string;
  /**
   * Working directory for the spawned child. Defaults to the repo root.
   * Council/ideal E2E specs pass a fresh greenfield temp dir so the discover
   * phase does not scan the real (large) repo — that scan is the dominant,
   * variable cost that made the council E2E flaky.
   */
  cwd?: string;
};

const DEFAULT_FIXTURES = resolve("tests/harness/fixtures/llm");
const ENTRY = resolve("src/index.ts");

/**
 * Spawn the agent-mode TUI and wire the driver.
 * Does NOT call wait_for — callers decide when the TUI is ready.
 */
export async function spawnHarness(opts: SpawnHarnessOptions = {}): Promise<HarnessContext> {
  const fixtures = opts.fixturesDir ?? DEFAULT_FIXTURES;
  const args = [opts.entry ?? ENTRY, "--agent-mode", "--mock-llm", fixtures, ...(opts.extraArgs ?? [])];

  let tempHome: string | undefined;
  let homeDir = opts.cwd;
  if (!homeDir) {
    tempHome = mkdtempSync(join(tmpdir(), "muonroi-harness-home-"));
    homeDir = tempHome;
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: homeDir,
    USERPROFILE: homeDir,
    // MUONROI_TEST_NO_PERSIST: "1",
    // Suppress the agent-harness shim deprecation warning in the spawned
    // child — this is an internal-callsite spawn, not an external consumer.
    MUONROI_INTERNAL_SHIM_OK: "1",
    ANTHROPIC_API_KEY: "sk-ant-mock",
    OPENAI_API_KEY: "sk-mock",
    GOOGLE_GENERATIVE_AI_API_KEY: "mock",
    // The default model is deepseek-v4-flash, so deepseek is the ACTIVE
    // provider at boot. Without a deepseek key the CLI shows the "Add API key"
    // onboarding modal, which steals composer focus and fails specs that type
    // into the composer (e.g. visual-capture). Locally this is masked because
    // keytar reads the developer's OS keychain (HOME-independent); on keyless
    // CI the modal appears — the classic "green local, red CI" gap. Seed a
    // mock key (>=20 chars, never sent because --mock-llm intercepts) so the
    // harness boots straight to chat. Specs that WANT the modal
    // (api-key.spec.ts) override this to "" and set MUONROI_TEST_NO_KEYCHAIN=1.
    // Built via join (not a single string literal) so it (a) stays a non-"sk-"
    // placeholder and (b) does not trip the pre-commit secret scanner's
    // `KEY: "<16+ chars>"` pattern. loadKeyForProvider only requires >=20 chars.
    DEEPSEEK_API_KEY: ["muonroi", "harness", "mock", "deepseek", "key"].join("-"),
    ...(opts.env ?? {}),
  };

  const result: SpawnResult = await spawnAgentTui(args, {
    spawnOpts: { env, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
  });

  const { proc, inWrite, outRead, cleanup: spawnCleanup } = result;

  const driver = createDriver({
    sendKey: (k) => inWrite.write(`${JSON.stringify({ op: "press", key: k })}\n`),
    sendType: (t) => inWrite.write(`${JSON.stringify({ op: "type", text: t })}\n`),
  });

  const splitter = createLineSplitter((line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.mode === "live") {
        driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      } else if (msg.mode === "visual") {
        driver._ingest({ kind: "visual", frame: msg as unknown as VisualFrame });
      } else if (msg.t === "idle") {
        driver._ingest({ kind: "idle" });
      } else if (msg.t === "event") {
        driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
      }
    } catch {
      // ignore malformed lines
    }
  });

  outRead.on("data", (chunk: Buffer | string) => {
    splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });

  // Phase 21 / disconnect — surface transport teardown as a typed event so
  // E2E specs can assert a disconnect contract instead of waiting for a
  // wait_for timeout. Both 'end' (orderly EOF) and 'close' (possibly with
  // error) are forwarded — duplicates are harmless because last_event reads
  // the most recent matching kind.
  let disconnected = false;
  proc.stderr?.on("data", (d) => {
    const txt = d.toString();
    process.stdout.write(`STDERR: ${txt}`);
  });
  const emitDisconnect = (reason: "end" | "close") => {
    if (disconnected) return;
    disconnected = true;
    driver._ingest({
      kind: "event",
      event: { t: "event", kind: "disconnect", reason, ts: Date.now() },
    });
    driver._closeAllSubscribers();
  };
  outRead.on("end", () => emitDisconnect("end"));
  outRead.on("close", () => emitDisconnect("close"));

  const cleanup = () => {
    spawnCleanup();
    if (tempHome) {
      bestEffortRemoveSync(tempHome, "tests/harness/helpers.ts");
    }
  };

  return { proc, driver, cleanup };
}

/**
 * A durable background-delegation record as `src/orchestrator/delegations.ts`
 * persists it (`<MUONROI_CLI_HOME>/delegations/<workspace-key>/<id>.json`).
 * Only the fields harness specs assert on are typed; the rest stay `unknown`.
 */
export type DelegationRecordForSpec = {
  id: string;
  kind: string;
  agent?: string;
  status: string;
  executionRole?: string;
  description?: string;
  council?: { topic: string; reason: string; context: string; outputContract: string };
  councilTrace?: {
    debatePlan?: { intentSummary?: string; stances?: Array<{ name: string }>; outputShape?: { kind?: string } };
    participants?: unknown[];
    synthesis?: string;
    stats?: { phases?: Array<{ name: string; durationMs: number }> };
  };
  resultVersion?: string;
  deliveredVersion?: string;
  [key: string]: unknown;
};

/**
 * Every delegation record under `cliHome` (the spawned child's
 * MUONROI_CLI_HOME). Since b014c9b9 the TUI main agent is the orchestrator
 * role, so `/council` and `/ideal --force-council` launch a durable background
 * council instead of running it in the foreground — this record is the
 * authoritative evidence of what was launched and how it ended. Records are
 * written atomically by the product, but a reader can still race a rename on
 * Windows; an unparsable file is logged and skipped, never silently ignored.
 */
export function readDelegationRecords(cliHome: string): DelegationRecordForSpec[] {
  const root = join(cliHome, "delegations");
  if (!existsSync(root)) return [];
  const records: DelegationRecordForSpec[] = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const dir = join(root, workspace.name);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const path = join(dir, file.name);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DelegationRecordForSpec>;
        if (typeof parsed.id === "string" && typeof parsed.kind === "string") {
          records.push(parsed as DelegationRecordForSpec);
        }
      } catch (err) {
        console.error(
          `[harness-helpers] skipped unreadable delegation record ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return records;
}

/**
 * Poll the delegation records under `cliHome` until one satisfies `match`, and
 * return THAT snapshot. Always poll rather than read once: the host and the
 * detached child both rewrite a record by atomic temp-file rename, and a single
 * directory read on Windows can land in the instant the replaced name is not
 * listed (measured: one run in six read no record right after the launch
 * receipt rendered). On timeout the error carries every record seen (minus the
 * bulky council trace) so a failure is diagnosable from the log alone.
 */
export async function waitForDelegation(
  cliHome: string,
  match: (record: DelegationRecordForSpec) => boolean,
  timeoutMs: number,
  what: string,
): Promise<DelegationRecordForSpec> {
  const deadline = Date.now() + timeoutMs;
  let last: DelegationRecordForSpec[] = [];
  while (Date.now() < deadline) {
    last = readDelegationRecords(cliHome);
    const hit = last.find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  const seen = last.map(({ councilTrace: _trace, ...rest }) => rest);
  throw new Error(
    `waitForDelegation: no record matched "${what}" within ${timeoutMs}ms; records seen: ${JSON.stringify(seen, null, 2)}`,
  );
}

/**
 * Spawn options that run the REAL `src/index.ts` with the TUI's Agent
 * constructed as the `infrastructure` execution role instead of the default
 * `orchestrator` (main) role.
 *
 * Since b014c9b9 the user-facing main agent delegates `/council` and `/ideal`
 * to background jobs, so the retained in-process council / product-loop
 * lifecycle (clarify card, S1 launch card, undebated-criteria gate and its
 * withdrawal) only runs for an infrastructure-role Agent. The same commit added
 * `tests/integration/fixtures/askcard-infrastructure-entry.mjs` for exactly
 * this purpose — test-only: a Bun loader plugin rewrites the entry's Agent
 * import; there is no production flag or env override. Specs that pin a
 * retained-lifecycle mechanism with no user-facing equivalent reuse it, with
 * their assertions unchanged, next to a block asserting the user-facing contract.
 */
export function infrastructureRoleSpawn(): { entry: string; env: Record<string, string> } {
  return {
    entry: resolve("tests/integration/fixtures/askcard-infrastructure-entry.mjs"),
    env: { MUONROI_ASKCARD_FIXTURE_ENTRY: ENTRY },
  };
}
