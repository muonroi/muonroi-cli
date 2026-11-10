/**
 * F3 home-binding proof — NON-VACUOUS (plan §Deliverable 5).
 *
 * The council's standing worry about a `writeConfig` seam is that it is easy to
 * assert a home was "passed" while the production call still writes somewhere
 * else. This file refuses that shape: it drives the REAL
 * `writeExperienceConfig` from `src/ee/auth.ts` with a temp home, reads the file
 * back off disk, and separately asserts that the REAL `~/.experience` was not
 * created. If `local-brain.ts` ever dropped the `{ home }` argument, the config
 * would land in the developer's real home and the "nowhere else" assertions
 * below would fail rather than pass vacuously.
 *
 * Hard constraint 1: nothing here reads or writes the real `~/.experience` or
 * the real `~/.muonroi-cli`. Every home is an `mkdtempSync()` temp dir, and the
 * suite-wide `MUONROI_CLI_HOME` pin (`src/__test-stubs__/vitest-setup.ts:143`)
 * is re-asserted locally so a regression in that pin cannot silently route a
 * write to the real home.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExperienceConfig, writeExperienceConfig } from "../auth.js";
import {
  defaultLocalBrainDeps,
  type LocalBrainDeps,
  type SetupLocalBrainOptions,
  setupLocalBrain,
} from "../local-brain.js";
import {
  LOCAL_BRAIN_PACKAGE_SPEC,
  type LocalBrainChild,
  type LocalBrainSpawnDeps,
  localBrainLogPath,
  localBrainPidfilePath,
} from "../local-brain-spawn.js";

const REAL_HOME = process.env.USERPROFILE || process.env.HOME || "";
const REAL_EE_DIR = join(REAL_HOME, ".experience");

interface FakeChild {
  pid: number;
  killCalls: number;
  unrefCalled: boolean;
  kill: () => boolean;
  unref: () => void;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

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
  spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }>;
  probes: string[];
  storeDirs: string[];
  writeConfigCalls: Array<{ patch: Partial<ExperienceConfig>; home: string }>;
  reloadedHomes: string[];
  recordedConnected: number;
  logLines: string[];
  openedLogs: string[];
  written: Map<string, string>;
}

function makeHarness(home: string): { harness: Harness; deps: LocalBrainDeps } {
  const harness: Harness = {
    home,
    child: makeChild(4242),
    spawnCalls: [],
    probes: [],
    storeDirs: [],
    writeConfigCalls: [],
    reloadedHomes: [],
    recordedConnected: 0,
    logLines: ["brain: listening"],
    openedLogs: [],
    written: new Map(),
  };
  const spawnDeps: Partial<LocalBrainSpawnDeps> = {
    platform: "linux",
    spawn: (command, args, options) => {
      harness.spawnCalls.push({ command, args: [...args], options: { ...options } });
      return harness.child as unknown as LocalBrainChild;
    },
    resolveSpawnTarget: (command, args) => ({ command, args: [...args], verbatim: false }),
    openLogFd: (logPath) => {
      harness.openedLogs.push(logPath);
      return 4242;
    },
    closeFd: () => {},
    writeFile: async (filePath, data) => {
      // spawnLocalBrain writes the record to `<pidfile>.<pid>.tmp` first and
      // then renames it into place, so `filePath` is NEVER the pidfile itself.
      harness.written.set(filePath, data);
    },
    rename: async (from, to) => {
      // Atomic-promote semantics: the temp record's content moves to its final
      // path, which is what makes the read-back below see a real record.
      const content = harness.written.get(from);
      if (content !== undefined) {
        harness.written.delete(from);
        harness.written.set(to, content);
      }
    },
    readFile: async (filePath) => {
      // Read back whatever `rename` promoted to this path. Looking the record up
      // by a path `writeFile` was never called with would return "{}" and fail
      // isPidfileShape(), so the promotion map is the source of truth here.
      const content = harness.written.get(filePath);
      if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
      return content;
    },
    unlink: async (filePath) => {
      harness.written.delete(filePath);
    },
    readLogTail: async () => harness.logLines.join("\n"),
    now: () => 1_700_000_000_000,
  };
  const deps: LocalBrainDeps = {
    platform: "linux",
    env: () => undefined,
    resolveUserHome: () => home,
    requireResolve: () => null,
    npmGlobalRoot: async () => null,
    pathExists: async (candidate) => candidate === join("/opt", "ee-global", LOCAL_BRAIN_PACKAGE_SPEC),
    globalPackageRoots: () => [join("/opt", "ee-global")],
    localUrl: "http://127.0.0.1:9999",
    probeHealth: async (baseUrl) => {
      harness.probes.push(baseUrl);
      return { ok: false, detail: "ECONNREFUSED" };
    },
    ensureStoreDir: async (dir) => {
      harness.storeDirs.push(dir);
    },
    findFreePort: async () => 34567,
    writeConfig: async (patch, opts) => {
      harness.writeConfigCalls.push({ patch, home: opts.home });
    },
    reloadAuth: async (authHome) => {
      harness.reloadedHomes.push(authHome);
      return null;
    },
    recordConnected: () => {
      harness.recordedConnected += 1;
    },
    sleep: async () => {},
    now: () => 0,
    killChild: (c) => c.kill(),
    spawn: spawnDeps,
  };
  return { harness, deps };
}

function optionsFor(harness: Harness, extra: Partial<SetupLocalBrainOptions> = {}): SetupLocalBrainOptions {
  return { home: harness.home, timeoutMs: 1000, pollMs: 0, ...extra };
}

// ---------------------------------------------------------------------------
// The direct, non-vacuous binding
// ---------------------------------------------------------------------------

describe("F3 home binding — the REAL writeExperienceConfig", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ee-home-binding-"));
    // Belt and braces: the suite pin is what keeps a regression from reaching
    // the real home, so assert it is in place before writing anything.
    expect(process.env.MUONROI_CLI_HOME).toBeTruthy();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("lands in the temp home and NOWHERE ELSE (real ~/.experience untouched)", async () => {
    const realExistedBefore = existsSync(REAL_EE_DIR);

    await writeExperienceConfig({ serverBaseUrl: "http://127.0.0.1:34567" }, { home });

    // It DID land in the injected home — the assertion the plan demands.
    const written = join(home, ".experience", "config.json");
    expect(existsSync(written)).toBe(true);
    const cfg = JSON.parse(readFileSync(written, "utf8")) as ExperienceConfig;
    expect(cfg.serverBaseUrl).toBe("http://127.0.0.1:34567");

    // And NOWHERE else: not the cwd (where a missing `{ home }` would have
    // written a RELATIVE `.experience/`), and not the real home.
    expect(existsSync(join(process.cwd(), ".experience", "config.json"))).toBe(false);
    if (realExistedBefore) {
      // The real config pre-dates this run; it must not have been rewritten.
      const real = JSON.parse(readFileSync(join(REAL_EE_DIR, "config.json"), "utf8")) as ExperienceConfig;
      expect(real.serverBaseUrl).not.toBe("http://127.0.0.1:34567");
    } else {
      expect(existsSync(REAL_EE_DIR)).toBe(false);
    }
  });

  it("writeExperienceConfig has no env override — only the {home} arg relocates it", async () => {
    // A home dir that does not exist yet is created (0o700) rather than falling
    // back to the real home. This is what makes the injected seam meaningful.
    const nested = join(home, "nested", "user");
    await writeExperienceConfig({ serverAuthToken: "tok" }, { home: nested });
    expect(existsSync(join(nested, ".experience", "config.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(nested, ".experience")).mode & 0o777).toBe(0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// The pipeline binding: setupLocalBrain must pass the SAME home through
// ---------------------------------------------------------------------------

describe("F3 home binding — setupLocalBrain threads one home everywhere", () => {
  const createdHomes: string[] = [];

  function fresh(): { harness: Harness; deps: LocalBrainDeps } {
    const home = mkdtempSync(join(tmpdir(), "ee-home-binding-"));
    createdHomes.push(home);
    return makeHarness(home);
  }

  afterEach(() => {
    for (const dir of createdHomes) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    createdHomes.length = 0;
  });

  it("passes the injected home to writeConfig AND to reloadAuth (never the real one)", async () => {
    const { harness, deps } = fresh();
    // Make the spawned brain healthy immediately.
    deps.probeHealth = async (baseUrl) => {
      harness.probes.push(baseUrl);
      return baseUrl.startsWith("http://127.0.0.1:34567")
        ? { ok: true, detail: "HTTP 200" }
        : { ok: false, detail: "ECONNREFUSED" };
    };

    const result = await setupLocalBrain(deps, optionsFor(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(harness.writeConfigCalls).toHaveLength(1);
    expect(harness.writeConfigCalls[0]?.home).toBe(harness.home);
    expect(harness.reloadedHomes).toEqual([harness.home]);
    // The home written to the config is the SAME home written into the child
    // env — the plan's step-4/step-6 invariant.
    const env = harness.spawnCalls[0]?.options.env as NodeJS.ProcessEnv | undefined;
    expect(env?.HOME).toBe(harness.home);
    expect(env?.USERPROFILE).toBe(harness.home);
  });

  it("with the REAL writeConfig wired in, the config file lands in the temp home only", async () => {
    // Whether the real home already has an EE dir is a property of the DEVELOPER
    // BOX, not of this code. On a box that already has one, "the dir does not
    // exist" is unsatisfiable and would fail for reasons unrelated to the
    // binding under test — so capture it first and assert the STRONGER property
    // instead: whatever was there, the real config was NOT rewritten with this
    // run's temp URL. Mirrors the sibling case above (realExistedBefore).
    const realExistedBefore = existsSync(REAL_EE_DIR);
    const { harness, deps } = fresh();
    // Deliberately NOT injecting writeConfig: defaultLocalBrainDeps()'s
    // writeExperienceConfig runs for real, so the file must appear under the
    // temp home. This is the end-to-end version of the F3 proof.
    //
    // Built from the PRODUCTION defaults (never a mock) with this file's fake
    // seams layered on top; the three config seams are then REMOVED so the REAL
    // writeExperienceConfig / loadEEAuthToken / recordEeConnected execute. The
    // proof below reads the file off disk, so nothing here can pass vacuously.
    // `resolveUserHome` is overridden by the seam below, but the write itself
    // only relocates through the `{ home }` argument — writeExperienceConfig has
    // no env override, so the real home is unreachable from here.
    const realDeps: LocalBrainDeps = { ...defaultLocalBrainDeps(), ...deps };
    delete realDeps.writeConfig;
    delete realDeps.reloadAuth;
    delete realDeps.recordConnected;
    realDeps.probeHealth = async (baseUrl) => {
      harness.probes.push(baseUrl);
      return baseUrl.startsWith("http://127.0.0.1:34567")
        ? { ok: true, detail: "HTTP 200" }
        : { ok: false, detail: "ECONNREFUSED" };
    };

    const result = await setupLocalBrain(realDeps, optionsFor(harness));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = join(harness.home, ".experience", "config.json");
    expect(existsSync(written)).toBe(true);
    const cfg = JSON.parse(readFileSync(written, "utf8")) as ExperienceConfig;
    expect(cfg.serverBaseUrl).toBe("http://127.0.0.1:34567");
    // Nowhere else: the REAL ~/.experience was not created, or — if it already
    // existed on this box — was not rewritten with this run's temp URL. This is
    // the assertion that makes the test non-vacuous: if local-brain.ts dropped
    // the `{ home }` argument, the REAL config would now hold 34567 and fail.
    const realConfig = join(REAL_EE_DIR, "config.json");
    if (realExistedBefore) {
      const real = JSON.parse(readFileSync(realConfig, "utf8")) as ExperienceConfig;
      expect(real.serverBaseUrl).not.toBe("http://127.0.0.1:34567");
    } else {
      expect(existsSync(REAL_EE_DIR)).toBe(false);
    }
  });

  it("the log and the pidfile live under the injected home, not the global one", () => {
    const { harness } = fresh();
    expect(localBrainLogPath(harness.home).startsWith(harness.home)).toBe(true);
    expect(localBrainPidfilePath(harness.home).startsWith(harness.home)).toBe(true);
    // And NOT under the suite-pinned global home (which is itself a temp dir).
    const pinned = process.env.MUONROI_CLI_HOME ?? "";
    expect(localBrainLogPath(harness.home).startsWith(pinned)).toBe(false);
  });
});
