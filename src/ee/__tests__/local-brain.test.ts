/**
 * Provisioning pipeline tests (plan §Deliverable 5).
 *
 * Two isolation rules, both non-negotiable (plan §Hard constraints):
 *
 *  1. Every test builds its own `mkdtempSync()` home and passes it as
 *     `opts.home`. No test reaches the real `~/.experience` or
 *     `~/.muonroi-cli`. The pidfile, the log and the child's HOME/USERPROFILE
 *     all land inside the temp dir, and the tests assert that.
 *  2. Nothing here spawns a real node server and nothing reaches the
 *     experience-engine reference checkout. Every seam (spawn, health probe,
 *     npm root -g, createRequire, port picker) is an injected fake.
 *
 * The suite pins `MUONROI_CLI_HOME` to a temp dir itself (mirroring
 * `src/__test-stubs__/vitest-setup.ts:143`) so that even a code path that
 * ignored the injected home would still not write to the developer's real home.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LocalBrainDeps, type SetupLocalBrainOptions, setupLocalBrain } from "../local-brain.js";
import {
  LOCAL_BRAIN_PACKAGE_SPEC,
  type LocalBrainChild,
  type LocalBrainSpawnDeps,
  localBrainLogPath,
  localBrainPidfilePath,
} from "../local-brain-spawn.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Structural stand-in for ChildProcess — spawnLocalBrain() only ever calls
 * pid/kill/unref/once, so no real process is created and the "already running"
 * EINVAL/EACCES families never happen on a Windows host.
 */
interface FakeChild {
  pid: number;
  killCalls: number;
  unrefCalled: boolean;
  kill: () => boolean;
  unref: () => void;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/**
 * Virtual clock. The setup timeout is measured through `deps.now`, so a timeout
 * test advances it instead of sleeping 45 real seconds.
 */
let fakeNow = 0;

function makeChild(pid: number): FakeChild {
  const child: FakeChild = {
    pid,
    killCalls: 0,
    unrefCalled: false,
    kill() {
      child.killCalls += 1;
      return true;
    },
    unref() {
      child.unrefCalled = true;
    },
    once: () => child,
  };
  return child;
}

interface Harness {
  home: string;
  child: FakeChild;
  spawnCalls: { command: string; args: string[]; options: Record<string, unknown> }[];
  openedLogs: string[];
  probes: string[];
  writeConfigCalls: { patch: unknown; home: string }[];
  storeDirs: string[];
  reloadedHomes: string[];
  recordedConnected: number;
  pidfileReads: number;
  pidfileVerification: "ok" | "write-fails" | "readback-fails" | "mismatch";
  logLines: string[];
}

/** Which mode the fake pidfile backend is in. */
type PidfileMode = "ok" | "write-fails" | "readback-fails" | "mismatch";

function makeHarness(overrides: Partial<LocalBrainDeps> = {}): { harness: Harness; deps: LocalBrainDeps } {
  const home = mkdtempSync(join(tmpdir(), "local-brain-"));
  const child = makeChild(4242);
  const spawnCalls: Harness["spawnCalls"] = [];
  const openedLogs: string[] = [];
  const probes: string[] = [];
  const writeConfigCalls: Harness["writeConfigCalls"] = [];
  const storeDirs: string[] = [];
  const reloadedHomes: string[] = [];
  const logLines: string[] = ["brain: listening"];
  const pidfileWrites: string[] = [];
  let pidfileReads = 0;
  let mode: PidfileMode = "ok";

  const spawnDeps: Partial<LocalBrainSpawnDeps> = {
    platform: "linux",
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args: [...args], options });
      return child as unknown as LocalBrainChild;
    },
    openLogFd: (logPath) => {
      openedLogs.push(logPath);
      return 7;
    },
    closeFd: () => {},
    writeFile: async (filePath, data) => {
      if (mode === "write-fails") throw new Error("EACCES: pidfile directory is read-only");
      if (filePath.endsWith(".tmp")) pidfileWrites.push(data);
      logLines.push(data);
    },
    rename: async (_from, to) => {
      if (mode === "write-fails") throw new Error("EACCES: rename denied");
      pidfileWrites.push(`renamed:${to}`);
    },
    readFile: async (filePath) => {
      if (filePath === localBrainPidfilePath(home)) {
        pidfileReads += 1;
        if (mode === "readback-fails") throw new Error("EIO: pidfile vanished");
        if (mode === "mismatch") {
          return JSON.stringify({
            pid: 9999,
            port: 1,
            startedAt: new Date(0).toISOString(),
            logPath: localBrainLogPath(home),
            serverRoot: "/elsewhere",
          });
        }
        const written = pidfileWrites.find((line) => line.includes('"pid"'));
        return written ?? "{}";
      }
      return "";
    },
    unlink: async () => {},
    readLogTail: async () => logLines.join("\n"),
    now: () => 1_700_000_000_000,
  };

  const deps: LocalBrainDeps = {
    platform: "linux",
    env: () => undefined,
    resolveUserHome: () => home,
    requireResolve: () => null,
    npmGlobalRoot: async () => null,
    // The resolved root is `<global root>/@muonroi/experience-engine` — the
    // global root itself is only the PARENT of the package directory.
    pathExists: async (candidate) => candidate === join("/opt", "ee-global", LOCAL_BRAIN_PACKAGE_SPEC),
    globalPackageRoots: () => ["/opt/ee-global"],
    localUrl: "http://127.0.0.1:9999",
    probeHealth: async (baseUrl) => {
      probes.push(baseUrl);
      // `localUrl` (9999) is NOT the spawned brain's port, so the
      // already-running branch is decided by `healthyUrls` alone — the test
      // opts in by adding it, instead of the fake hardcoding a failure.
      return healthGate(baseUrl);
    },
    ensureStoreDir: async (dir) => {
      storeDirs.push(dir);
    },
    findFreePort: async () => 34567,
    writeConfig: async (patch, opts) => {
      writeConfigCalls.push({ patch, home: opts.home });
    },
    reloadAuth: async (authHome) => {
      reloadedHomes.push(authHome);
      return null;
    },
    recordConnected: () => {
      harness.recordedConnected += 1;
    },
    sleep: async () => {},
    // A clock that only advances when a test asks it to: with a frozen clock the
    // timeout branch would be measured in wall time (17s per case).
    now: () => fakeNow,
    killChild: (c) => c.kill(),
    ...overrides,
  };

  const harness: Harness = {
    home,
    child,
    spawnCalls,
    openedLogs,
    probes,
    writeConfigCalls,
    storeDirs,
    reloadedHomes,
    recordedConnected: 0,
    pidfileReads,
    pidfileVerification: "ok",
    logLines,
  };
  Object.defineProperty(harness, "pidfileReads", { get: () => pidfileReads });
  Object.defineProperty(harness, "pidfileVerification", {
    get: () => mode,
    set: (next: PidfileMode) => {
      mode = next;
    },
  });

  return { harness, deps: { ...deps, spawn: spawnDeps } };
}

/** Which brain URLs answer /health as healthy. Empty ⇒ never healthy. */
let healthyUrls: Set<string> = new Set();
function healthGate(baseUrl: string): { ok: boolean; detail: string } {
  return healthyUrls.has(baseUrl) ? { ok: true, detail: "HTTP 200" } : { ok: false, detail: "ECONNREFUSED" };
}

function optionsFor(harness: Harness, extra: Partial<SetupLocalBrainOptions> = {}): SetupLocalBrainOptions {
  return { home: harness.home, timeoutMs: 1000, pollMs: 0, ...extra };
}

// ---------------------------------------------------------------------------

describe("setupLocalBrain", () => {
  beforeEach(() => {
    healthyUrls = new Set();
    fakeNow = 0;
  });
  afterEach(() => {
    // Harness homes are created per test; drop them so no temp home leaks.
    for (const dir of createdHomes) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    createdHomes.length = 0;
  });

  const createdHomes: string[] = [];
  const originalMakeHarness = makeHarness;
  function fresh(): { harness: Harness; deps: LocalBrainDeps } {
    const made = originalMakeHarness();
    createdHomes.push(made.harness.home);
    return made;
  }

  it("connects WITHOUT spawning when a brain is already running", async () => {
    const { harness, deps } = fresh();
    healthyUrls = new Set(["http://127.0.0.1:9999"]);

    const result = await setupLocalBrain(deps, optionsFor(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail).toContain("already running");
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.writeConfigCalls).toHaveLength(1);
    expect(harness.writeConfigCalls[0]?.home).toBe(harness.home);
    expect(harness.reloadedHomes).toEqual([harness.home]);
    expect(harness.recordedConnected).toBe(1);
  });

  it("names the exact install command when the package is missing", async () => {
    const { harness, deps } = fresh();
    // Every lookup fails: no env root, no require resolve, no global root, no npm root.
    const result = await setupLocalBrain(
      { ...deps, pathExists: async () => false, globalPackageRoots: () => [] },
      optionsFor(harness),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("npm i -g @muonroi/experience-engine");
    expect(result.error).toContain("MUONROI_EE_PACKAGE_ROOT");
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.writeConfigCalls).toHaveLength(0);
  });

  it("spawns → polls → connects on the happy path", async () => {
    const { harness, deps } = fresh();
    healthyUrls = new Set(["http://127.0.0.1:34567"]);

    const result = await setupLocalBrain(deps, optionsFor(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly one spawn, node directly (no shell wrapper), detached.
    expect(harness.spawnCalls).toHaveLength(1);
    const call = harness.spawnCalls[0]!;
    expect(call.command).toBe("node");
    expect(call.args).toEqual([join("/opt/ee-global", LOCAL_BRAIN_PACKAGE_SPEC, "server.js")]);
    expect(call.options.detached).toBe(true);
    expect(harness.child.unrefCalled).toBe(true);
    // The free port was actually used and is reported in the detail.
    expect(result.detail).toContain("http://127.0.0.1:34567");
    expect(call.options.env).toMatchObject({ EXP_SERVER_PORT: "34567" });
    // Config + reload + record all happened, against THIS home.
    expect(harness.writeConfigCalls).toEqual([
      { patch: { serverBaseUrl: "http://127.0.0.1:34567" }, home: harness.home },
    ]);
    expect(harness.reloadedHomes).toEqual([harness.home]);
    expect(harness.recordedConnected).toBe(1);
  });

  it("kills the child and reports the log when /health never becomes ok", async () => {
    const { harness, deps } = fresh();
    const unlinked: string[] = [];
    // healthyUrls stays empty ⇒ every probe fails. `sleep` advances the injected
    // clock so the loop reaches the deadline without sleeping in wall time.
    const result = await setupLocalBrain(
      {
        ...deps,
        spawn: {
          ...deps.spawn,
          unlink: async (p: string) => {
            unlinked.push(p);
          },
        },
        sleep: async () => {
          fakeNow += 200;
        },
      },
      optionsFor(harness),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(harness.child.killCalls).toBe(1);
    // The stopped child's tracking file is removed, so the next setup/stop is not handed a stale entry.
    expect(unlinked).toContain(localBrainPidfilePath(harness.home));
    expect(result.error).toContain("brain: listening");
    expect(result.error).toContain(localBrainLogPath(harness.home));
    expect(harness.writeConfigCalls).toHaveLength(0);
    expect(harness.recordedConnected).toBe(0);
  });

  it("F1: a failed pidfile write kills the child and carries the log tail", async () => {
    const { harness, deps } = fresh();
    healthyUrls = new Set(["http://127.0.0.1:34567"]);
    harness.pidfileVerification = "write-fails";

    const result = await setupLocalBrain(deps, optionsFor(harness));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Stop-on-failure: no untracked child left behind.
    expect(harness.child.killCalls).toBe(1);
    expect(result.error).toContain("EACCES");
    expect(result.error).toContain("brain: listening");
    expect(harness.writeConfigCalls).toHaveLength(0);
  });

  it("F1: a pidfile that cannot be read back also kills the child", async () => {
    const { harness, deps } = fresh();
    healthyUrls = new Set(["http://127.0.0.1:34567"]);
    harness.pidfileVerification = "readback-fails";

    const result = await setupLocalBrain(deps, optionsFor(harness));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(harness.child.killCalls).toBe(1);
    expect(result.error).toContain("EIO");
    expect(harness.writeConfigCalls).toHaveLength(0);
  });

  it("F1: a pidfile recording a DIFFERENT process is not trusted", async () => {
    const { harness, deps } = fresh();
    healthyUrls = new Set(["http://127.0.0.1:34567"]);
    harness.pidfileVerification = "mismatch";

    const result = await setupLocalBrain(deps, optionsFor(harness));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(harness.child.killCalls).toBe(1);
    expect(result.error).toContain("does not match the process that was started");
    expect(harness.writeConfigCalls).toBeInstanceOf(Array);
    expect(harness.writeConfigCalls).toHaveLength(0);
  });

  it("sandbox isolation: the child env carries the TEMP home and the store is created there", async () => {
    const { harness, deps } = fresh();
    healthyUrls = new Set(["http://127.0.0.1:34567"]);
    const result = await setupLocalBrain(deps, optionsFor(harness));
    expect(result.ok).toBe(true);

    // HOME + USERPROFILE point at the temp home — never the real one.
    const env = harness.spawnCalls[0]!.options.env as Record<string, string>;
    expect(env.HOME).toBe(harness.home);
    expect(env.USERPROFILE).toBe(harness.home);
    expect(existsSync(harness.home)).toBe(true);

    // Store dir pre-created under the injected home.
    expect(harness.storeDirs).toEqual([join(harness.home, ".experience", "store", "default")]);

    // Pidfile + log both live under the injected home.
    expect(localBrainPidfilePath(harness.home).startsWith(harness.home)).toBe(true);
    expect(localBrainLogPath(harness.home).startsWith(harness.home)).toBe(true);
    // The stdio target the child got IS that log path (F5).
    expect(harness.openedLogs).toEqual([localBrainLogPath(harness.home)]);
  });

  it("refuses to run without a home rather than falling back to the real one", async () => {
    const { deps } = fresh();
    const result = await setupLocalBrain({ ...deps, resolveUserHome: () => "" }, { timeoutMs: 100, pollMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("refuses to fall back to the real home");
  });

  it("never throws, even when a seam blows up", async () => {
    const { harness } = fresh();
    const exploding: LocalBrainDeps = {
      platform: "linux",
      localUrl: "http://127.0.0.1:9999",
      probeHealth: async () => {
        throw new Error("boom");
      },
      env: () => undefined,
      resolveUserHome: () => harness.home,
      requireResolve: () => {
        throw new Error("cannot resolve");
      },
      npmGlobalRoot: async () => {
        throw new Error("npm not found");
      },
      pathExists: async () => false,
      ensureStoreDir: async () => {},
      findFreePort: async () => 1,
    };
    const result = await setupLocalBrain(exploding, optionsFor(harness));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("boom");
  });

  it("surfaces a config-write failure as an error", async () => {
    const { harness, deps } = fresh();
    healthyUrls = new Set(["http://127.0.0.1:9999"]);
    const result = await setupLocalBrain(
      {
        ...deps,
        writeConfig: async () => {
          throw new Error("EACCES");
        },
      },
      optionsFor(harness),
    );
    expect(result).toEqual({ ok: false, error: "Could not write EE config: EACCES" });
    expect(harness.recordedConnected).toBe(0);
  });
});
