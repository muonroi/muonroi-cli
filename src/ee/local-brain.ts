/**
 * src/ee/local-brain.ts
 *
 * Provision a LOCAL Experience Engine brain on a machine that has none.
 *
 * The pipeline, in order, and why each step is where it is:
 *
 *   1. probe EE_LOCAL_URL first. A brain that is already running is the common
 *      case on a dev box; spawning a second one would fight over the store.
 *   2. resolve the package root. When the package is absent the error names the
 *      exact `npm i -g @muonroi/experience-engine` command — "no local brain"
 *      with no way forward is the failure this replaces.
 *   3. pre-create `<home>/.experience/store/default`, because /health reports
 *      `degraded` until the FileStore directory exists (proven against
 *      experience-engine/server.js).
 *   4. pick a FREE port (8082 collides — measured) and spawn `node server.js`
 *      directly, with HOME/USERPROFILE pointed at the resolved home so the
 *      child writes its store there and nowhere else.
 *   5. poll /health until ok, then write the config, reload the auth cache and
 *      record the connection. On timeout the child is killed and the error
 *      carries the log tail.
 *
 * NEVER throws: every failure comes back as `{ ok: false, error }`, because this
 * runs from a UI action whose worst outcome is a message, not a crash.
 *
 * FULL DI (F3/F4): every input — env lookup, home resolution, candidate roots,
 * the `npm root -g` call, the spawn itself — arrives through `deps`. Nothing
 * here reads `os.homedir()` or `child_process` on its own, which is what makes
 * the whole pipeline unit-testable inside a mkdtempSync() directory and keeps
 * the real `~/.experience` untouched. `defaultLocalBrainDeps()` is the only
 * place the production (os.homedir()-backed) wiring lives.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { ExperienceConfig } from "./auth.js";
import { probeEEHealth, writeExperienceConfig } from "./auth.js";
import { EE_LOCAL_URL, recordEeConnected } from "./ee-connect.js";
import {
  LOCAL_BRAIN_PACKAGE_SPEC,
  type LocalBrainChild,
  type LocalBrainSpawnDeps,
  localBrainLogPath,
  localBrainPidfilePath,
  readLocalBrainLogTail,
  spawnLocalBrain,
} from "./local-brain-spawn.js";

/** Ceiling for the whole spawn → healthy handshake. */
export const LOCAL_BRAIN_SETUP_TIMEOUT_MS = 45_000;

/** Interval between /health polls once the child is up. */
export const LOCAL_BRAIN_HEALTH_POLL_MS = 500;

/**
 * Env knob that pins the package root, skipping every other lookup. Useful when
 * the brain lives outside the global node_modules (a checkout, a bundled build).
 */
export const LOCAL_BRAIN_ROOT_ENV = "MUONROI_EE_PACKAGE_ROOT";

/** The one install command every "package missing" error must name. */
export const LOCAL_BRAIN_INSTALL_COMMAND = "npm i -g @muonroi/experience-engine";

/**
 * Structurally identical to `EeConnectResult` in src/ui/ee-connect-controller.ts
 * (declared here rather than imported so src/ee does not depend on src/ui). The
 * card assigns it straight across.
 */
export type LocalBrainSetupResult = { ok: true; detail: string } | { ok: false; error: string };

/**
 * Everything the pipeline consults. Every field is optional so a caller can
 * inject only the seams it cares about, but the three that would otherwise reach
 * the host — `env`, `resolveUserHome`, `pathExists` — are always injected by
 * tests, and `npmGlobalRoot`/`requireResolve`/`spawn` are injected whenever a
 * real process or a real resolution must not happen.
 */
export interface LocalBrainDeps {
  /** Base URL probed before anything is spawned. Defaults to EE_LOCAL_URL. */
  localUrl?: string;
  /** Health probe. Defaults to probeEEHealth(url, undefined, { quiet: true }). */
  probeHealth?: (baseUrl: string, token?: string) => Promise<{ ok: boolean; detail: string }>;
  /** Env lookup — injected so a test never reads the developer's environment. */
  env?: (name: string) => string | undefined;
  /**
   * Home the brain will use. Injected on purpose: the production default is
   * os.homedir(), and a unit test that does not inject this must fail loudly
   * rather than silently address the real home.
   */
  resolveUserHome?: () => string;
  /** Extra global package roots, tried after the platform-aware built-ins. */
  globalPackageRoots?: () => string[];
  /** createRequire(import.meta.url).resolve — injected so no real resolution runs. */
  requireResolve?: (spec: string) => string | null;
  /** `npm root -g` — injected so no real child process runs. */
  npmGlobalRoot?: () => string | null | Promise<string | null>;
  /** Existence check for a candidate root. */
  pathExists?: (candidate: string) => boolean | Promise<boolean>;
  /** Platform for the platform-aware candidate roots. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** mkdir -p for `<home>/.experience/store/default`. */
  ensureStoreDir?: (storeDir: string) => Promise<void>;
  /** Free-port picker. Defaults to a bind-then-release on 127.0.0.1:0. */
  findFreePort?: () => Promise<number>;
  /** Spawn seams, forwarded to spawnLocalBrain (F1/F5). */
  spawn?: Partial<LocalBrainSpawnDeps>;
  /**
   * Config write. The `{ home }` it receives is ALWAYS the same home that was
   * written into the child env — writeExperienceConfig has no env override
   * (src/ee/auth.ts:20-24), so omitting it would write the real ~/.experience.
   */
  writeConfig?: (patch: Partial<ExperienceConfig>, opts: { home: string }) => Promise<void>;
  /** Auth-cache reload. Receives the SAME home the config was written to. */
  reloadAuth?: (home: string) => Promise<unknown>;
  recordConnected?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop a spawned child (timeout path). Defaults to child.kill(). */
  killChild?: (child: LocalBrainChild) => void;
}

export interface SetupLocalBrainOptions {
  /**
   * Home for the brain: the child's HOME/USERPROFILE, the store directory, the
   * pidfile, the log, and the `{ home }` handed to writeExperienceConfig.
   * When omitted it comes from `deps.resolveUserHome()` — production wiring
   * only; a unit test always passes a temp dir.
   */
  home?: string;
  /** Overrides deps.localUrl / EE_LOCAL_URL for the "already running" probe. */
  localUrl?: string;
  /** Extra spawn seams (tests inject their fakes here). */
  spawn?: Partial<LocalBrainSpawnDeps>;
  timeoutMs?: number;
  pollMs?: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function defaultEnsureStoreDir(storeDir: string): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true });
}

/**
 * Bind-then-release on 127.0.0.1:0.
 *
 * 8082 is NOT assumed free — the pre-implementation probe measured a collision
 * on a machine that already had a brain bound to it, and a second brain fighting
 * over one port fails in a way that looks like a broken install.
 */
export async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    const done = (err?: Error): void => {
      server.close(() => (err ? reject(err) : resolve(port)));
    };
    let port = 0;
    server.once("error", (err: Error) => done(err));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      if (port <= 0) {
        done(new Error("the OS did not assign a port"));
        return;
      }
      done();
    });
  });
}

/**
 * Production dependency wiring. The ONLY place in this module that may touch the
 * real machine: `resolveUserHome` is os.homedir() and the spawn/exec defaults are
 * the real ones. Tests inject their own instead.
 */
export function defaultLocalBrainDeps(): LocalBrainDeps {
  return {
    localUrl: EE_LOCAL_URL,
    probeHealth: (baseUrl, token) => probeEEHealth(baseUrl, token, { quiet: true }),
    env: (name) => process.env[name],
    resolveUserHome: () => os.homedir(),
    requireResolve: (spec) => {
      try {
        return createRequire(import.meta.url).resolve(spec);
      } catch {
        return null;
      }
    },
    npmGlobalRoot: async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      try {
        const { stdout } = await promisify(execFile)("npm", ["root", "-g"], {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 1 << 20,
        });
        const root = String(stdout).trim();
        return root.length > 0 ? root : null;
      } catch {
        return null;
      }
    },
    pathExists: async (candidate) => {
      try {
        await fs.access(path.join(candidate, "server.js"));
        return true;
      } catch {
        return false;
      }
    },
    platform: process.platform,
    ensureStoreDir: defaultEnsureStoreDir,
    findFreePort,
    writeConfig: (patch, opts) => writeExperienceConfig(patch, opts),
    reloadAuth: async (home) => {
      const { loadEEAuthToken } = await import("./auth.js");
      return await loadEEAuthToken({ home });
    },
    recordConnected: recordEeConnected,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/**
 * Candidate global roots, platform-aware, with every input arriving through
 * `deps` (F3): APPDATA from `env`, the bun global root from `resolveUserHome`.
 * When a seam is absent the candidate is SKIPPED rather than resolved from the
 * host — an un-injected test must degrade, not touch the real machine.
 */
function globalCandidateRoots(deps: LocalBrainDeps): string[] {
  const roots: string[] = [];
  const platform = deps.platform ?? process.platform;
  const env = deps.env;
  const appData = env?.("APPDATA");
  if (appData) {
    roots.push(path.join(appData, "npm", "node_modules"));
  }
  if (platform !== "win32") {
    roots.push(path.join("/usr", "local", "lib", "node_modules"));
  }
  const home = deps.resolveUserHome?.();
  if (home) {
    roots.push(path.join(home, ".bun", "install", "global", "node_modules"));
  }
  return roots;
}

async function rootHasEntry(deps: LocalBrainDeps, candidate: string | null | undefined): Promise<string | null> {
  if (!candidate) return null;
  const exists = deps.pathExists ?? (async () => false);
  return (await exists(candidate)) ? candidate : null;
}

/**
 * Where the local brain package lives, or null when it is not installed.
 *
 * Search order (plan §Deliverable 1):
 *   MUONROI_EE_PACKAGE_ROOT → createRequire(import.meta.url).resolve() →
 *   global roots → `npm root -g`.
 *
 * Every input — env, home, candidate roots, the npm invocation — arrives through
 * `deps`, so a unit test that does not inject them can never reach the host's
 * os.homedir() or spawn a real process.
 */
export async function resolveLocalBrainPackageRoot(deps: LocalBrainDeps = {}): Promise<string | null> {
  const envRoot = deps.env?.(LOCAL_BRAIN_ROOT_ENV);
  const fromEnv = await rootHasEntry(deps, envRoot);
  if (fromEnv) return fromEnv;

  try {
    const resolved = deps.requireResolve?.(`${LOCAL_BRAIN_PACKAGE_SPEC}/server.js`);
    const fromRequire = await rootHasEntry(deps, resolved ? path.dirname(resolved) : null);
    if (fromRequire) return fromRequire;
  } catch {
    // A resolver that throws is "not installed", not a crash.
  }

  const candidates = [...globalCandidateRoots(deps), ...(deps.globalPackageRoots?.() ?? [])];
  for (const root of candidates) {
    const found = await rootHasEntry(deps, path.join(root, LOCAL_BRAIN_PACKAGE_SPEC));
    if (found) return found;
  }

  const npmRoot = (await deps.npmGlobalRoot?.()) ?? null;
  const fromNpm = await rootHasEntry(deps, npmRoot ? path.join(npmRoot, LOCAL_BRAIN_PACKAGE_SPEC) : null);
  if (fromNpm) return fromNpm;

  return null;
}

/** Store directory the child's /health check needs to exist before it starts. */
function brainStoreDir(home: string): string {
  return path.join(home, ".experience", "store", "default");
}

/**
 * Write the config, reload the auth cache and record the connection.
 *
 * `home` is a REQUIRED parameter and is the same value that was written into the
 * child's HOME/USERPROFILE. It is never derived here, and never defaults to the
 * real home: writeExperienceConfig has no env override, so a missing `{ home }`
 * would silently write the developer's real ~/.experience/config.json.
 */
async function connectBrain(
  deps: LocalBrainDeps,
  home: string,
  serverBaseUrl: string,
  detail: string,
): Promise<LocalBrainSetupResult> {
  const writeConfig = deps.writeConfig ?? ((patch, opts) => writeExperienceConfig(patch, opts));
  try {
    await writeConfig({ serverBaseUrl }, { home });
  } catch (err) {
    return { ok: false, error: `Could not write EE config: ${errText(err)}` };
  }
  try {
    await (deps.reloadAuth ?? (async () => undefined))(home);
  } catch (err) {
    // The config is already on disk; a stale in-memory cache is recoverable by
    // the next /ee reload, so this is reported, not fatal.
    console.error(`[ee/local-brain] config written but the auth cache could not be reloaded: ${errText(err)}`);
  }
  try {
    (deps.recordConnected ?? recordEeConnected)();
  } catch (err) {
    console.error(`[ee/local-brain] connected, but the EE connect state could not be recorded: ${errText(err)}`);
  }
  return { ok: true, detail };
}

/**
 * Provision a local brain, or connect to one that is already running.
 * Never throws.
 */
export async function setupLocalBrain(
  deps: LocalBrainDeps,
  opts: SetupLocalBrainOptions = {},
): Promise<LocalBrainSetupResult> {
  const localUrl = opts.localUrl ?? deps.localUrl ?? EE_LOCAL_URL;
  const probeHealth = deps.probeHealth ?? ((baseUrl, token) => probeEEHealth(baseUrl, token, { quiet: true }));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? LOCAL_BRAIN_SETUP_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? LOCAL_BRAIN_HEALTH_POLL_MS;

  try {
    // The home is resolved BEFORE anything else happens so that every later
    // step — the child's HOME/USERPROFILE, the store dir, the pidfile, the log
    // and the `{ home }` handed to writeExperienceConfig — addresses one and the
    // same directory. An empty home is a hard error, never a silent fallback:
    // writeExperienceConfig would otherwise write a RELATIVE `.experience/`
    // into the cwd.
    const home = opts.home ?? deps.resolveUserHome?.() ?? "";
    if (!home) {
      return {
        ok: false,
        error:
          "No home directory was supplied for the local brain. Pass `home` explicitly (production wiring " +
          "resolves it from os.homedir()); this build refuses to fall back to the real home on its own.",
      };
    }

    // ── 1. Already running? Connect without spawning. ────────────────────────
    const existing = await probeHealth(localUrl);
    if (existing.ok) {
      return await connectBrain(
        deps,
        home,
        localUrl,
        `A local brain is already running at ${localUrl} (${existing.detail}) — connected without starting another one.`,
      );
    }

    // ── 2. Resolve the package root. ────────────────────────────────────────
    const serverRoot = await resolveLocalBrainPackageRoot(deps);
    if (!serverRoot) {
      return {
        ok: false,
        error:
          `No local Experience Engine package found on this machine. Install it with:\n` +
          `  ${LOCAL_BRAIN_INSTALL_COMMAND}\n` +
          `then run this again — or set ${LOCAL_BRAIN_ROOT_ENV} to the directory that contains its server.js.`,
      };
    }

    // ── 3. Pre-create the store so /health is not `degraded`. ────────────────
    const storeDir = brainStoreDir(home);
    const ensureStoreDir = deps.ensureStoreDir ?? defaultEnsureStoreDir;
    try {
      await ensureStoreDir(storeDir);
    } catch (err) {
      return { ok: false, error: `Could not create the local brain store ${storeDir}: ${errText(err)}` };
    }

    // ── 4. Free port + spawn. ───────────────────────────────────────────────
    const findFree = deps.findFreePort ?? findFreePort;
    const port = await findFree();
    if (!Number.isInteger(port) || port <= 0) {
      return { ok: false, error: `Could not find a free port for the local brain (got ${String(port)}).` };
    }

    const started = await spawnLocalBrain({ serverRoot, port, home, deps: opts.spawn ?? deps.spawn });
    if (!started.ok) {
      // F1: spawnLocalBrain already stopped the child and attached the log tail.
      return { ok: false, error: `Could not start the local brain. ${started.error}` };
    }

    // ── 5. Poll /health until ok, or stop the child and report the log. ──────
    const brainUrl = `http://127.0.0.1:${port}`;
    const deadline = now() + timeoutMs;
    let lastDetail = "not probed yet";
    for (;;) {
      const health = await probeHealth(brainUrl);
      lastDetail = health.detail;
      if (health.ok) break;
      if (now() >= deadline) {
        const killChild = deps.killChild ?? ((child) => child.kill());
        let killed = "";
        try {
          killChild(started.child);
          killed = ` Stopped pid ${started.pid}.`;
        } catch (err) {
          console.error(
            `[ee/local-brain] the local brain never became healthy and pid ${started.pid} could not be ` +
              `stopped — it may still be running: ${errText(err)}`,
          );
        }
        const spawnDeps = opts.spawn ?? deps.spawn;
        const tail = spawnDeps?.readLogTail
          ? await spawnDeps.readLogTail(started.logPath)
          : await readLocalBrainLogTail(started.logPath);
        return {
          ok: false,
          error:
            `The local brain did not answer ${brainUrl}/health within ${timeoutMs}ms (${lastDetail}).${killed} ` +
            `Last output from ${started.logPath}:\n${tail}`,
        };
      }
      await sleep(pollMs);
    }

    // ── 6. Write the config for THIS home, reload, record. ───────────────────
    return await connectBrain(
      deps,
      home,
      brainUrl,
      `Started a local brain on ${brainUrl} (pid ${started.pid}, log ${started.logPath}, tracking ` +
        `${localBrainPidfilePath(home)}) and connected.`,
    );
  } catch (err) {
    return { ok: false, error: `Local brain setup failed: ${errText(err)}` };
  }
}

/** Re-exported so callers do not need to import the spawn module for one path. */
export { localBrainLogPath, localBrainPidfilePath, readLocalBrainLogTail };
