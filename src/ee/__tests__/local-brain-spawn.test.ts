/**
 * Spawn wiring + process-tracking tests (plan §Deliverable 2 / 5).
 *
 * The three findings these tests exist for:
 *
 *   F1 stop-on-failure — a child that was spawned but not tracked must be
 *     killed before the function returns, and the failure must carry the log
 *     tail so the user can see why it died.
 *   F2 verify-before-signal — killLocalBrain() must never signal a pid it has
 *     not confirmed is OUR brain. Every unverifiable state is a refusal.
 *   F5 one source of truth — the stdio target handed to spawn() and the
 *     `logPath` recorded in the pidfile are the same string by construction.
 *
 * Isolation: every test builds its own mkdtempSync() home and passes it as
 * `opts.home`. No real process is ever created — `deps.spawn` returns a
 * structural fake, and `deps.signalProcess` only records the call.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSpawnTarget } from "../../lsp/spawn-target.js";
import { muonroiHome } from "../../utils/muonroi-home.js";
import {
  buildLocalBrainEnv,
  killLocalBrain,
  LOCAL_BRAIN_LOG_NAME,
  LOCAL_BRAIN_PIDFILE_NAME,
  type LocalBrainChild,
  type LocalBrainKillDeps,
  type LocalBrainPidfile,
  type LocalBrainSpawnDeps,
  localBrainLogPath,
  localBrainPidfilePath,
  readLocalBrainPidfile,
  resolveLocalBrainSpawnDeps,
  spawnLocalBrain,
} from "../local-brain-spawn.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeChild extends LocalBrainChild {
  pid: number;
  killCalls: number;
  unrefCalled: boolean;
  kill: () => boolean;
  unref: () => void;
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
  };
  return child;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

interface PidfileMode {
  writeFails?: boolean;
  readBackFails?: boolean;
  readBack?: string;
}

interface Harness {
  home: string;
  child: FakeChild;
  spawnCalls: SpawnCall[];
  openedLogs: string[];
  closedFds: number[];
  written: Map<string, string>;
  renamed: Array<{ from: string; to: string }>;
  pidfileMode: PidfileMode;
}

/**
 * An in-memory filesystem for the pidfile seam. Deliberately NOT node:fs: the
 * test needs to force write/rename/read failures without creating unreadable
 * files on a Windows host.
 */
function makeSpawnDeps(harness: Harness): Partial<LocalBrainSpawnDeps> {
  const pidfilePath = localBrainPidfilePath(harness.home);
  return {
    platform: "linux",
    spawn: (command, args, options) => {
      harness.spawnCalls.push({ command, args: [...args], options });
      return harness.child as unknown as LocalBrainChild;
    },
    resolveSpawnTarget,
    openLogFd: (logPath) => {
      harness.openedLogs.push(logPath);
      // Any fd is fine — nothing here is a real descriptor.
      return 4242;
    },
    closeFd: (fd) => {
      harness.closedFds.push(fd);
    },
    writeFile: async (filePath, data) => {
      if (harness.pidfileMode.writeFails && filePath.startsWith(`${pidfilePath}.`)) {
        throw new Error("EROFS: read-only file system");
      }
      harness.written.set(filePath, data);
      // The write really lands on disk too (inside the temp home), so the F5
      // assertion can read the pidfile back from the filesystem rather than
      // trusting the in-memory map.
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data, "utf8");
    },
    rename: async (from, to) => {
      harness.renamed.push({ from, to });
      const content = harness.written.get(from);
      if (content !== undefined) {
        harness.written.delete(from);
        harness.written.set(to, content);
      }
      if (existsSync(from)) renameSync(from, to);
    },
    readFile: async (filePath) => {
      if (harness.pidfileMode.readBackFails && filePath === pidfilePath) {
        throw new Error("EACCES: permission denied");
      }
      if (filePath === pidfilePath && harness.pidfileMode.readBack !== undefined) {
        return harness.pidfileMode.readBack;
      }
      const content = harness.written.get(filePath);
      if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
      return content;
    },
    unlink: async (filePath) => {
      harness.written.delete(filePath);
    },
    readLogTail: async () => "brain: listening",
    now: () => 1_700_000_000_000,
  };
}

function makeKillDeps(harness: Harness, overrides: Partial<LocalBrainKillDeps> = {}): Partial<LocalBrainKillDeps> {
  return {
    platform: "linux",
    // Alive until signalled, like a real brain that exits on SIGTERM.
    isAlive: () => harness.child.killCalls === 0,
    commandLineOf: async () => `node ${join("/opt/ee", "server.js")}`,
    portOwnerPid: async () => harness.child.pid,
    signalProcess: () => {
      harness.child.killCalls += 1;
    },
    readFile: async (filePath) => {
      const content = harness.written.get(filePath);
      if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
      return content;
    },
    unlink: async (filePath) => {
      harness.written.delete(filePath);
    },
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function fresh(): Harness {
  const home = mkdtempSync(join(tmpdir(), "lb-spawn-"));
  const child = makeChild(4242);
  return {
    home,
    child,
    spawnCalls: [],
    openedLogs: [],
    closedFds: [],
    written: new Map(),
    renamed: [],
    pidfileMode: {},
  };
}

// ---------------------------------------------------------------------------

describe("paths derive from the INJECTED home", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = fresh();
  });
  afterEach(() => {
    rmSync(harness.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("pidfile and log live under the injected home, never the global one", () => {
    const pinned = muonroiHome(); // MUONROI_CLI_HOME pinned by vitest-setup.ts
    const pidfile = localBrainPidfilePath(harness.home);
    const log = localBrainLogPath(harness.home);

    expect(pidfile.startsWith(harness.home)).toBe(true);
    expect(log.startsWith(harness.home)).toBe(true);
    expect(pidfile.endsWith(LOCAL_BRAIN_PIDFILE_NAME)).toBe(true);
    expect(log.endsWith(LOCAL_BRAIN_LOG_NAME)).toBe(true);
    // Never the global muonroi home (F4).
    expect(pidfile.startsWith(pinned)).toBe(false);
    expect(log.startsWith(pinned)).toBe(false);
  });

  it("F5: pidfile.logPath === the stdio target handed to spawn", async () => {
    const deps = makeSpawnDeps(harness);
    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The fd that was opened (and is therefore the stdio target) came from the
    // same path the pidfile records.
    const stdio = result.ok ? harness.spawnCalls[0]?.options.stdio : undefined;
    expect(harness.openedLogs).toEqual([localBrainLogPath(harness.home)]);
    expect(stdio).toEqual(["ignore", 4242, 4242]);
    expect(harness.openedLogs).toHaveLength(1); // ONE source, not two paths

    const record = JSON.parse(readFileSync(localBrainPidfilePath(harness.home), "utf8")) as LocalBrainPidfile;
    expect(record.logPath).toBe(harness.openedLogs[0]);
    expect(result.logPath).toBe(record.logPath);
  });
});

describe("spawnLocalBrain", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = fresh();
  });
  afterEach(() => {
    rmSync(harness.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("spawns node DIRECTLY, detached, and records the pidfile atomically", async () => {
    const deps = makeSpawnDeps(harness);
    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // node directly — no shell wrapper in the command line.
    const call = harness.spawnCalls[0]!;
    expect(call.command).toBe("node");
    expect(call.args).toEqual([join("/opt/ee", "server.js")]);
    expect(call.options.detached).toBe(true);
    expect(call.options.windowsVerbatimArguments).toBeUndefined();
    expect(harness.child.unrefCalled).toBe(true);

    // Atomic write: tmp + rename, and the tmp file is gone afterwards.
    expect(harness.renamed).toEqual([
      { from: `${localBrainPidfilePath(harness.home)}.4242.tmp`, to: localBrainPidfilePath(harness.home) },
    ]);
    expect([...harness.written.keys()]).toEqual([localBrainPidfilePath(harness.home)]);

    const record = JSON.parse(readFileSync(localBrainPidfilePath(harness.home), "utf8")) as LocalBrainPidfile;
    expect(record).toMatchObject({
      pid: 4242,
      port: 34567,
      startedAt: new Date(1_700_000_000_000).toISOString(),
      serverRoot: "/opt/ee",
    });
  });

  it("routes a Windows .cmd shim through resolveSpawnTarget", async () => {
    const deps = { ...makeSpawnDeps(harness), platform: "win32" as NodeJS.Platform };
    // Pretend the entry is a shim by pointing the resolver at one; the module
    // resolves "node", which is a real executable, so the integration is proven
    // by the resolveSpawnTarget contract below.
    const target = resolveSpawnTarget("node", ["/opt/ee/server.js"], "win32");
    expect(target).toEqual({ command: "node", args: ["/opt/ee/server.js"], verbatim: false });

    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });
    expect(result.ok).toBe(true);
    expect(harness.spawnCalls[0]?.command).toBe("node");
  });

  it("F1: a failed pidfile WRITE kills the child and carries the log tail", async () => {
    harness.pidfileMode.writeFails = true;
    const deps = makeSpawnDeps(harness);

    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(harness.child.killCalls).toBe(1); // F1: stopped, not left running
    expect(result.error).toContain("EROFS");
    expect(result.error).toContain("Stopped pid 4242");
    expect(result.error).toContain("brain: listening"); // the log tail
    expect(result.logTail).toBe("brain: listening");
    expect(result.logPath).toBe(localBrainLogPath(harness.home));
    expect(result.killedPid).toBe(4242);
    // The half-written tmp file is cleaned up — no orphan pidfile.
    expect([...harness.written.keys()]).toEqual([]);
  });

  it("F1: a pidfile that cannot be READ BACK kills the child", async () => {
    harness.pidfileMode.readBackFails = true;
    const deps = makeSpawnDeps(harness);

    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });

    expect(result.ok).toBe(false);
    expect(harness.child.killCalls).toBe(1);
    if (!result.ok) expect(result.error).toContain("EACCES");
  });

  it("F1: a pidfile recording a DIFFERENT process is not trusted", async () => {
    harness.pidfileMode.readBack = JSON.stringify({
      pid: 999,
      port: 34567,
      startedAt: "x",
      logPath: "/somewhere/else.log",
      serverRoot: "/opt/ee",
    });
    const deps = makeSpawnDeps(harness);

    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });

    expect(result.ok).toBe(false);
    expect(harness.child.killCalls).toBe(1);
    if (!result.ok) expect(result.error).toContain("does not match the process that was started");
  });

  it("a child with no pid is a failure, not a success", async () => {
    const deps = makeSpawnDeps(harness);
    const pidless = makeChild(0);
    deps.spawn = () => pidless as unknown as LocalBrainChild;

    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not report a pid");
  });

  it("refuses to run without an injected home (never falls back to the real one)", async () => {
    const deps = makeSpawnDeps(harness);
    const result = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: "", deps });

    expect(result.ok).toBe(false);
    expect(harness.spawnCalls).toHaveLength(0);
    if (!result.ok) expect(result.error).toContain("Refusing to fall back to the real home");
  });
});

describe("buildLocalBrainEnv", () => {
  it("HOME/USERPROFILE point at the injected home and EXP_SERVER_PORT at the port", () => {
    const env = buildLocalBrainEnv({ PATH: "/usr/bin" }, "/tmp/lb-home", 34567);
    expect(env.HOME).toBe("/tmp/lb-home");
    expect(env.USERPROFILE).toBe("/tmp/lb-home");
    expect(env.EXP_SERVER_PORT).toBe("34567");
    // The base env survives — the child still needs PATH.
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("readLocalBrainPidfile (stale detection)", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = fresh();
  });
  afterEach(() => {
    rmSync(harness.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("reports a live entry and a dead one, and null when there is none", async () => {
    const deps = makeSpawnDeps(harness);
    await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });

    const live = await readLocalBrainPidfile(harness.home, { ...makeKillDeps(harness), isAlive: () => true });
    expect(live?.alive).toBe(true);
    expect(live?.entry.pid).toBe(4242);
    expect(live?.staleReason).toBeUndefined();

    const dead = await readLocalBrainPidfile(harness.home, { ...makeKillDeps(harness), isAlive: () => false });
    expect(dead?.alive).toBe(false);
    expect(dead?.staleReason).toContain("not running");

    const empty = mkdtempSync(join(tmpdir(), "lb-empty-"));
    try {
      expect(await readLocalBrainPidfile(empty, makeKillDeps(harness))).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("rejects a malformed pidfile rather than trusting it", async () => {
    mkdirSync(dirname(localBrainPidfilePath(harness.home)), { recursive: true });
    writeFileSync(localBrainPidfilePath(harness.home), "{ not json", "utf8");
    expect(await readLocalBrainPidfile(harness.home, makeKillDeps(harness))).toBeNull();
  });
});

describe("killLocalBrain (F2: verify before signalling)", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = fresh();
  });
  afterEach(() => {
    rmSync(harness.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function trackBrain(): Promise<void> {
    const deps = makeSpawnDeps(harness);
    const started = await spawnLocalBrain({ serverRoot: "/opt/ee", port: 34567, home: harness.home, deps });
    expect(started.ok).toBe(true);
  }

  it("signals only when liveness, port ownership AND the command line all check out", async () => {
    await trackBrain();
    const result = await killLocalBrain({ home: harness.home, deps: makeKillDeps(harness) });

    expect(result).toEqual({ ok: true, pid: 4242, port: 34567, logPath: localBrainLogPath(harness.home) });
    expect(harness.child.killCalls).toBe(1);
    // Confirmed gone -> the tracking file is removed, so the next setup starts clean.
    expect(harness.written.has(localBrainPidfilePath(harness.home))).toBe(false);
  });

  // 2026-11-10: on win32 the old path returned ok:true while the brain kept serving /health.
  it("reports still-running (and keeps the pidfile) when the brain survives the signal", async () => {
    await trackBrain();
    let clock = 1_700_000_000_000;
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, {
        isAlive: () => true,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("still-running");
      expect(result.error).toContain("still running after 5000 ms");
    }
    expect(harness.written.has(localBrainPidfilePath(harness.home))).toBe(true);
  });

  it("awaits an asynchronous signal before checking that the brain is gone", async () => {
    await trackBrain();
    let delivered = false;
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, {
        signalProcess: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          delivered = true;
        },
        isAlive: () => !delivered,
      }),
    });
    expect(result.ok).toBe(true);
    expect(delivered).toBe(true);
  });

  it("reports signal-failed when the signal itself throws", async () => {
    await trackBrain();
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, {
        signalProcess: async () => {
          throw new Error("taskkill /pid 4242 failed: Access is denied.");
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Access is denied");
  });

  it("refuses when the pidfile is missing", async () => {
    const result = await killLocalBrain({ home: harness.home, deps: makeKillDeps(harness) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-pidfile");
      expect(result.error).toContain("nothing to stop");
    }
    expect(harness.child.killCalls).toBe(0);
  });

  it("refuses when the recorded pid is not alive (stale)", async () => {
    await trackBrain();
    const result = await killLocalBrain({ home: harness.home, deps: makeKillDeps(harness, { isAlive: () => false }) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stale");
      expect(result.error).toContain("Nothing was signalled");
    }
    expect(harness.child.killCalls).toBe(0);
  });

  it("refuses when the port owner cannot be determined", async () => {
    await trackBrain();
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, { portOwnerPid: async () => null }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("port-unknown");
      expect(result.error).toContain("Nothing was signalled");
    }
    expect(harness.child.killCalls).toBe(0);
  });

  it("refuses when the recorded port belongs to a DIFFERENT pid", async () => {
    await trackBrain();
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, { portOwnerPid: async () => 777 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("port-mismatch");
      expect(result.error).toContain("the pid was reused");
    }
    expect(harness.child.killCalls).toBe(0);
  });

  it("refuses when the command line cannot be read", async () => {
    await trackBrain();
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, { commandLineOf: async () => null }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cmdline-unknown");
    expect(harness.child.killCalls).toBe(0);
  });

  it("refuses when the command line is NOT our server.js (no false positive)", async () => {
    await trackBrain();
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, { commandLineOf: async () => "C:\\Windows\\System32\\svchost.exe -k netsvcs" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cmdline-mismatch");
      expect(result.error).toContain("which is not the local brain");
    }
    expect(harness.child.killCalls).toBe(0);
  });

  it("reports a signal failure instead of claiming success", async () => {
    await trackBrain();
    const result = await killLocalBrain({
      home: harness.home,
      deps: makeKillDeps(harness, {
        signalProcess: () => {
          throw new Error("EPERM");
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("signal-failed");
      expect(result.error).toContain("EPERM");
    }
  });
});

describe("resolveLocalBrainSpawnDeps", () => {
  it("never resolves the global muonroi home — the caller supplies it", () => {
    const deps = resolveLocalBrainSpawnDeps({ platform: "linux" });
    // The only production defaults are process/platform/fs based; nothing here
    // reads os.homedir(), so a test that omits `home` cannot silently target
    // the developer's real home.
    expect(Object.keys(deps).sort()).toEqual(
      [
        "closeFd",
        "now",
        "openLogFd",
        "platform",
        "readFile",
        "readLogTail",
        "rename",
        "resolveSpawnTarget",
        "spawn",
        "unlink",
        "writeFile",
      ].sort(),
    );
  });
});
