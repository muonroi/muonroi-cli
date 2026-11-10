/**
 * src/ee/local-brain-spawn.ts
 *
 * Spawn + process-tracking wiring for the LOCAL Experience Engine brain.
 *
 * Two failure modes this module exists to prevent, both of them measured:
 *
 *   F1 — an UNTRACKED CHILD. `node server.js` is spawned DETACHED, so when the
 *        parent exits the child is reparented and survives. If anything fails
 *        between the spawn and a VERIFIED pidfile write, the brain keeps
 *        running with nothing able to stop it. Every early return on that path
 *        therefore kills the child first and hands back the log tail.
 *
 *   F2 — a FALSE-POSITIVE KILL. A pidfile is a pid NUMBER, and pids are reused
 *        by the OS. Signalling "whatever the file says" can terminate an
 *        unrelated process. killLocalBrain() verifies PID liveness, ownership
 *        of the recorded port, AND the recorded command line before it signals,
 *        and refuses — with the reason — whenever a check cannot be performed.
 *
 * DI seam (F4): NOTHING in here resolves a home. `home` is an argument on every
 * entry point, the pidfile and the log are derived from it, and the module never
 * imports muonroiHome(). The caller decides which home a brain belongs to, which
 * is what keeps `src/utils/__tests__/muonroi-home-guard.test.ts` green and lets
 * a unit test run entirely inside a mkdtempSync() directory.
 *
 * F5: `logPath` is computed ONCE per spawn and used both as the stdio
 * redirection target handed to spawn() and as the pidfile's `logPath` field, so
 * `pidfile.logPath === spawn stdio target` holds by construction rather than by
 * two independent derivations that can drift.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, promises as fs, mkdirSync, openSync } from "node:fs";
import * as path from "node:path";
import { resolveSpawnTarget } from "../lsp/spawn-target.js";

/**
 * The one resolvable package spec the local brain is looked up under. It is the
 * only place the EE package name appears in product code — everywhere else goes
 * through the root this module (or resolveLocalBrainPackageRoot) resolves.
 */
export const LOCAL_BRAIN_PACKAGE_SPEC = "@muonroi/experience-engine";

/** Entry file inside that package (`node <root>/server.js`). */
export const LOCAL_BRAIN_ENTRY = "server.js";

/** Basename of the tracking file written under the injected home. */
export const LOCAL_BRAIN_PIDFILE_NAME = "local-brain.json";

/** Basename of the brain's stdout/stderr log, written under the injected home. */
export const LOCAL_BRAIN_LOG_NAME = "local-brain.log";

/**
 * The slice of `child_process.ChildProcess` this module uses. Declared
 * structurally (rather than importing the class) so a test can hand in a fake
 * without a real process: the happy path, the F1 stop-on-failure path and the
 * F2 refusal path all run against injected objects.
 */
export interface LocalBrainChild {
  readonly pid?: number | undefined;
  readonly killed?: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  unref: () => void;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/** Everything spawnLocalBrain() needs from the outside world. All injectable. */
export interface LocalBrainSpawnDeps {
  platform: NodeJS.Platform;
  spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => LocalBrainChild;
  resolveSpawnTarget: (
    command: string,
    args: readonly string[],
    platform?: NodeJS.Platform,
    comspec?: string,
  ) => { command: string; args: string[]; verbatim: boolean };
  /**
   * Opens (creating/appending) the log file and returns the fd that becomes the
   * spawn stdio target. F5 depends on this being the SAME path the pidfile
   * records, so the caller passes `logPath` and nothing else derives a path.
   */
  openLogFd: (logPath: string) => number;
  closeFd: (fd: number) => void;
  writeFile: (filePath: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  readFile: (filePath: string) => Promise<string>;
  unlink: (filePath: string) => Promise<void>;
  readLogTail: (logPath: string, maxChars?: number) => Promise<string>;
  now: () => number;
}

/** Record written to `<injected home>/local-brain.json`. */
export interface LocalBrainPidfile {
  pid: number;
  port: number;
  /** ISO timestamp of the spawn. */
  startedAt: string;
  /** MUST equal the fd target handed to spawn() — see F5. */
  logPath: string;
  /** Directory that contained the server.js we launched. */
  serverRoot: string;
}

export interface SpawnLocalBrainOptions {
  /** Directory that contains server.js. */
  serverRoot: string;
  /** Port handed to the child as EXP_SERVER_PORT. */
  port: number;
  /**
   * Home for the pidfile + log AND the child's HOME/USERPROFILE. Required on
   * purpose: there is no default, because a default would have to come from
   * os.homedir() and would break the temp-dir isolation every caller relies on.
   */
  home: string;
  /** Overrides localBrainLogPath(home). Tests only. */
  logPath?: string;
  /** Base environment for the child. Defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  deps?: Partial<LocalBrainSpawnDeps>;
}

export interface LocalBrainSpawnSuccess {
  ok: true;
  child: LocalBrainChild;
  pid: number;
  port: number;
  logPath: string;
  pidfilePath: string;
  entry: string;
  /** True when the command had to be routed through an explicit cmd.exe call. */
  verbatim: boolean;
}

export interface LocalBrainSpawnFailure {
  ok: false;
  /** Human-facing reason, always carrying the log tail. */
  error: string;
  logTail: string;
  logPath: string;
  pidfilePath: string;
  /** Set when a child had to be killed to honour F1 (null = nothing to kill). */
  killedPid: number | null;
}

export type SpawnLocalBrainResult = LocalBrainSpawnSuccess | LocalBrainSpawnFailure;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultOpenLogFd(logPath: string): number {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return openSync(logPath, "a");
}

/**
 * Tail of the brain's log. Never throws and never returns an empty string: an
 * unreadable or empty log is itself the reason the caller needs ("no output
 * yet" is a different diagnosis from a stack trace).
 */
export async function readLocalBrainLogTail(logPath: string, maxChars = 4000): Promise<string> {
  try {
    const text = (await fs.readFile(logPath, "utf8")).trim();
    if (!text) return `(no output yet in ${logPath})`;
    return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
  } catch (err) {
    return `(could not read ${logPath}: ${errText(err)})`;
  }
}

/** Production defaults. Only reached through defaultLocalBrainSpawnDeps(). */
export function defaultLocalBrainSpawnDeps(): LocalBrainSpawnDeps {
  return {
    platform: process.platform,
    spawn: (command, args, options) => nodeSpawn(command, [...args], options as never) as unknown as LocalBrainChild,
    resolveSpawnTarget,
    openLogFd: defaultOpenLogFd,
    closeFd: (fd) => {
      try {
        // Best-effort: the fd is only a redirection target, and a close failure
        // must not turn a successfully started brain into an error.
        closeSync(fd);
      } catch (err) {
        // The child already exited and closed it, or the fd was never valid.
        console.error(`[ee/local-brain-spawn] could not close the brain log fd ${fd}: ${errText(err)}`);
      }
    },
    writeFile: async (filePath, data) => {
      await fs.writeFile(filePath, data, "utf8");
    },
    rename: async (from, to) => {
      await fs.rename(from, to);
    },
    readFile: async (filePath) => await fs.readFile(filePath, "utf8"),
    unlink: async (filePath) => {
      await fs.unlink(filePath);
    },
    readLogTail: readLocalBrainLogTail,
    now: () => Date.now(),
  };
}

/**
 * Merge injected deps over the production defaults. A Partial that omits a seam
 * gets the real implementation — which is why every unit test that must not
 * touch the host injects the seams it cares about explicitly.
 */
export function resolveLocalBrainSpawnDeps(partial?: Partial<LocalBrainSpawnDeps>): LocalBrainSpawnDeps {
  return { ...defaultLocalBrainSpawnDeps(), ...(partial ?? {}) };
}

/** Log file for a brain whose home is `home`. Derived, never guessed. */
export function localBrainLogPath(home: string): string {
  return path.join(home, LOCAL_BRAIN_LOG_NAME);
}

/** Tracking file for a brain whose home is `home`. Derived, never guessed. */
export function localBrainPidfilePath(home: string): string {
  return path.join(home, LOCAL_BRAIN_PIDFILE_NAME);
}

/**
 * Child environment for the brain.
 *
 * server.js and config.js read `os.homedir()` directly (proven: the sandbox
 * probe returned `fileStore.path` inside the temp dir only because BOTH of
 * these were overridden), and EXP_SERVER_PORT is the port knob that beats the
 * 8082 default in server.js.
 */
export function buildLocalBrainEnv(baseEnv: NodeJS.ProcessEnv, home: string, port: number): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    EXP_SERVER_PORT: String(port),
  };
}

function isPidfileShape(value: unknown): value is LocalBrainPidfile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.port === "number" &&
    Number.isInteger(v.port) &&
    v.port > 0 &&
    typeof v.logPath === "string" &&
    typeof v.serverRoot === "string"
  );
}

/**
 * Spawn `node <serverRoot>/server.js` DIRECTLY (resolveSpawnTarget only wraps a
 * Windows .cmd shim, and `node` is a real executable, so in practice nothing is
 * wrapped — there is never a shell in between), then record and VERIFY the
 * pidfile before returning success.
 */
export async function spawnLocalBrain(opts: SpawnLocalBrainOptions): Promise<SpawnLocalBrainResult> {
  const deps = resolveLocalBrainSpawnDeps(opts.deps);
  const home = typeof opts.home === "string" ? opts.home.trim() : "";
  const serverRoot = opts.serverRoot;
  const entry = path.join(serverRoot, LOCAL_BRAIN_ENTRY);
  const logPath = opts.logPath ?? (home ? localBrainLogPath(home) : "");
  const pidfilePath = home ? localBrainPidfilePath(home) : "";

  // F1: nothing has been spawned yet, so this is a pure argument error.
  if (!home) {
    return {
      ok: false,
      error:
        "Local brain setup needs an explicit home directory (it becomes the child's HOME/USERPROFILE and " +
        "roots the pidfile + log). Refusing to fall back to the real home.",
      logTail: "",
      logPath,
      pidfilePath,
      killedPid: null,
    };
  }

  let openFd: number | null = null;
  let child: LocalBrainChild | null = null;
  let spawnError: string | null = null;

  /** F1: stop the child, then report WITH the log tail. */
  const fail = async (reason: string): Promise<LocalBrainSpawnFailure> => {
    let killedPid: number | null = null;
    if (child && typeof child.pid === "number" && child.pid > 0) {
      try {
        child.kill();
        killedPid = child.pid;
      } catch (err) {
        console.error(
          `[ee/local-brain-spawn] could not stop pid ${child.pid} after a failed setup — it may still be running: ` +
            `${errText(err)}`,
        );
      }
    }
    if (openFd !== null) deps.closeFd(openFd);
    const logTail = await deps.readLogTail(logPath);
    const stopped = killedPid === null ? "" : ` Stopped pid ${killedPid}.`;
    return {
      ok: false,
      error: `${reason}.${stopped} Last output from ${logPath}:\n${logTail}`,
      logTail,
      logPath,
      pidfilePath,
      killedPid,
    };
  };

  try {
    openFd = deps.openLogFd(logPath);
  } catch (err) {
    return await fail(`Could not open the local brain log ${logPath}: ${errText(err)}`);
  }

  const target = deps.resolveSpawnTarget("node", [entry], deps.platform);
  const env = buildLocalBrainEnv(opts.baseEnv ?? process.env, home, opts.port);

  try {
    child = deps.spawn(target.command, target.args, {
      cwd: serverRoot,
      // Detached + unref so the brain outlives the CLI that started it; the
      // pidfile (and killLocalBrain) is what makes that survivable rather than
      // an orphan.
      detached: true,
      windowsHide: true,
      env,
      stdio: ["ignore", openFd, openFd],
      ...(target.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    return await fail(`Could not start node for ${entry}: ${errText(err)}`);
  }

  const pid = child?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return await fail(`node for ${entry} did not report a pid`);
  }

  try {
    child.unref();
  } catch (err) {
    // unref() is a liveness nicety, not a correctness requirement — the brain is
    // already running and tracked. Reported, not swallowed.
    console.error(`[ee/local-brain-spawn] could not unref pid ${pid}: ${errText(err)}`);
  }

  if (typeof child.once === "function") {
    child.once("error", (err: unknown) => {
      spawnError = errText(err);
    });
  }

  const record: LocalBrainPidfile = {
    pid,
    port: opts.port,
    startedAt: new Date(deps.now()).toISOString(),
    logPath,
    serverRoot,
  };
  const tmpPath = `${pidfilePath}.${pid}.tmp`;

  try {
    await deps.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`);
    await deps.rename(tmpPath, pidfilePath);
  } catch (err) {
    await deps.unlink(tmpPath).catch((unlinkErr: unknown) => {
      console.error(`[ee/local-brain-spawn] left the temp pidfile ${tmpPath} behind: ${errText(unlinkErr)}`);
    });
    return await fail(`Could not record the pidfile ${pidfilePath}: ${errText(err)}`);
  }

  // Verification, not optimism: a write that "succeeded" against a path we
  // cannot read back is exactly the untracked-child case F1 exists for.
  let readBack: unknown;
  try {
    readBack = JSON.parse(await deps.readFile(pidfilePath));
  } catch (err) {
    return await fail(`Could not read back the pidfile ${pidfilePath}: ${errText(err)}`);
  }
  if (!isPidfileShape(readBack)) {
    return await fail(`The pidfile ${pidfilePath} is not a usable brain record`);
  }
  if (readBack.pid !== pid || readBack.port !== opts.port || readBack.logPath !== logPath) {
    return await fail(
      `The pidfile ${pidfilePath} does not match the process that was started ` +
        `(expected pid ${pid}/port ${opts.port}/log ${logPath}, read pid ${readBack.pid}/port ${readBack.port}/` +
        `log ${readBack.logPath})`,
    );
  }
  if (spawnError) {
    return await fail(`The brain process failed during setup: ${spawnError}`);
  }

  return {
    ok: true,
    child,
    pid,
    port: opts.port,
    logPath,
    pidfilePath,
    entry,
    verbatim: target.verbatim,
  };
}

// ---------------------------------------------------------------------------
// Stop path (F2)
// ---------------------------------------------------------------------------

/** Everything the stop path needs from the outside world. All injectable. */
export interface LocalBrainKillDeps {
  platform: NodeJS.Platform;
  /** Liveness only — a probe that cannot kill. */
  isAlive: (pid: number) => boolean;
  /** Command line of a pid, or null when the host will not tell us. */
  commandLineOf: (pid: number) => Promise<string | null>;
  /** Pid currently LISTENING on `port`, or null when the host will not tell us. */
  portOwnerPid: (port: number) => Promise<number | null>;
  /** Actually signal. Only ever called after verification passes. */
  signalProcess: (pid: number) => void;
  readFile: (filePath: string) => Promise<string>;
  now: () => number;
}

export type LocalBrainKillRefusal =
  | "no-pidfile"
  | "unreadable-pidfile"
  | "stale"
  | "port-unknown"
  | "port-mismatch"
  | "cmdline-unknown"
  | "cmdline-mismatch"
  | "signal-failed";

export type KillLocalBrainResult =
  | { ok: true; pid: number; port: number; logPath: string }
  | { ok: false; error: string; reason: LocalBrainKillRefusal; pid?: number };

export interface LocalBrainPidfileStatus {
  entry: LocalBrainPidfile;
  path: string;
  alive: boolean;
  /** Why the entry is stale, when it is. */
  staleReason?: string;
}

function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

async function execText(command: string, args: string[]): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 1 << 20 });
    return String(stdout);
  } catch {
    return null;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 is a pure existence probe — it never terminates anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true; // exists, owned by someone else
    return false;
  }
}

function defaultCommandLineOf(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    return execText("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"]).then((out) => {
      if (out === null) return null;
      const match = /CommandLine=(.*)/.exec(out.replace(/\r/g, ""));
      const value = match?.[1]?.trim();
      return value ? value : null;
    });
  }
  return fs
    .readFile(`/proc/${pid}/cmdline`, "utf8")
    .then((raw) => raw.replace(/\0/g, " ").trim() || null)
    .catch(() => null);
}

function defaultPortOwnerPid(port: number): Promise<number | null> {
  if (process.platform === "win32") {
    return execText("netstat", ["-ano"]).then((out) => {
      if (out === null) return null;
      for (const line of out.split(/\r?\n/)) {
        // "  TCP    127.0.0.1:8082    0.0.0.0:0    LISTENING    12345"
        const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    });
  }
  return execText("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"]).then((out) => {
    const first = out?.trim().split(/\s+/)[0];
    return first && /^\d+$/.test(first) ? Number(first) : null;
  });
}

function defaultSignalProcess(pid: number): void {
  if (process.platform === "win32") {
    // Same shape as src/hooks/command-runner.ts: /T takes the detached tree,
    // /F because a process holding a listening socket ignores a gentle request.
    nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    return;
  }
  process.kill(pid, "SIGTERM");
}

export function defaultLocalBrainKillDeps(): LocalBrainKillDeps {
  return {
    platform: process.platform,
    isAlive: defaultIsAlive,
    commandLineOf: defaultCommandLineOf,
    portOwnerPid: defaultPortOwnerPid,
    signalProcess: defaultSignalProcess,
    readFile: async (filePath) => await fs.readFile(filePath, "utf8"),
    now: () => Date.now(),
  };
}

export function resolveLocalBrainKillDeps(partial?: Partial<LocalBrainKillDeps>): LocalBrainKillDeps {
  return { ...defaultLocalBrainKillDeps(), ...(partial ?? {}) };
}

/**
 * Read the tracking file for `home`, with a liveness check so a stale entry
 * (brain already dead, pid reused) is reported rather than acted on.
 * Returns null when there is no usable record at all.
 */
export async function readLocalBrainPidfile(
  home: string,
  deps?: Partial<LocalBrainKillDeps>,
): Promise<LocalBrainPidfileStatus | null> {
  const resolved = resolveLocalBrainKillDeps(deps);
  const filePath = localBrainPidfilePath(home);
  let raw: string;
  try {
    raw = await resolved.readFile(filePath);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPidfileShape(parsed)) return null;
  const alive = resolved.isAlive(parsed.pid);
  return {
    entry: parsed,
    path: filePath,
    alive,
    ...(alive ? {} : { staleReason: `pid ${parsed.pid} is not running` }),
  };
}

/**
 * Stop a brain started by spawnLocalBrain().
 *
 * Verifies BEFORE it signals (F2): the pidfile must exist and be readable, the
 * recorded pid must be alive, the recorded port must still be owned by THAT pid,
 * and the command line of that pid must be the brain's own server.js. Any check
 * that cannot be performed, or that fails, is a refusal — never a signal onto an
 * innocent pid.
 */
export async function killLocalBrain(opts: {
  home: string;
  /** Overrides the serverRoot recorded in the pidfile. */
  serverRoot?: string;
  deps?: Partial<LocalBrainKillDeps>;
}): Promise<KillLocalBrainResult> {
  const deps = resolveLocalBrainKillDeps(opts.deps);
  const status = await readLocalBrainPidfile(opts.home, deps);
  if (!status) {
    return {
      ok: false,
      reason: "no-pidfile",
      error:
        `No local brain is tracked at ${localBrainPidfilePath(opts.home)} — nothing to stop. ` +
        `(A brain started outside muonroi-cli, or one whose tracking file was removed, has to be stopped by hand.)`,
    };
  }
  const { entry, path: pidfilePath } = status;
  if (!status.alive) {
    return {
      ok: false,
      reason: "stale",
      pid: entry.pid,
      error:
        `The tracked local brain (pid ${entry.pid}, port ${entry.port}) is not running — ` +
        `${status.staleReason ?? "stale entry"}. Nothing was signalled; remove ${pidfilePath} if this keeps recurring.`,
    };
  }

  const owner = await deps.portOwnerPid(entry.port);
  if (owner === null) {
    return {
      ok: false,
      reason: "port-unknown",
      pid: entry.pid,
      error:
        `Could not determine which process owns port ${entry.port} on this host, so pid ${entry.pid} cannot be ` +
        `confirmed as the local brain. Nothing was signalled — stop it by hand if you are sure.`,
    };
  }
  if (owner !== entry.pid) {
    return {
      ok: false,
      reason: "port-mismatch",
      pid: entry.pid,
      error:
        `Port ${entry.port} is owned by pid ${owner}, not by the recorded pid ${entry.pid} — the pid was reused by ` +
        `another process. Nothing was signalled.`,
    };
  }

  const serverRoot = opts.serverRoot ?? entry.serverRoot;
  const expectedEntry = normalizeForCompare(path.join(serverRoot, LOCAL_BRAIN_ENTRY));
  const rootBase = normalizeForCompare(path.basename(serverRoot));
  const cmdline = await deps.commandLineOf(entry.pid);
  if (cmdline === null) {
    return {
      ok: false,
      reason: "cmdline-unknown",
      pid: entry.pid,
      error:
        `Could not read the command line of pid ${entry.pid} on this host, so it cannot be confirmed as the local ` +
        `brain. Nothing was signalled.`,
    };
  }
  const normalizedCmd = normalizeForCompare(cmdline);
  if (
    !normalizedCmd.includes(LOCAL_BRAIN_ENTRY) ||
    !(normalizedCmd.includes(expectedEntry) || normalizedCmd.includes(rootBase))
  ) {
    return {
      ok: false,
      reason: "cmdline-mismatch",
      pid: entry.pid,
      error:
        `Pid ${entry.pid} is running "${cmdline.trim().slice(0, 200)}", which is not the local brain ` +
        `(${expectedEntry}). Nothing was signalled.`,
    };
  }

  try {
    deps.signalProcess(entry.pid);
  } catch (err) {
    return {
      ok: false,
      reason: "signal-failed",
      pid: entry.pid,
      error: `Verified pid ${entry.pid} as the local brain but could not signal it: ${errText(err)}`,
    };
  }
  return { ok: true, pid: entry.pid, port: entry.port, logPath: entry.logPath };
}
