/**
 * `run_gate` — a HOST-EXECUTED verification gate for file-scoped workers.
 *
 * Why it exists. A writeScope worker gets native file tools only (no shell), so
 * every "fix, then build" became two or three dispatches: the scoped worker
 * edits, then an UNSCOPED verify worker runs the build of the very files it just
 * edited (measured in session 4edc02516a92: fix→build split into 2–3 workers
 * repeatedly). That unscoped run has the same exposure this tool has — a build or
 * test runner executes project-controlled code (npm scripts, MSBuild targets,
 * conftest.py) — plus a round trip. So instead of a shell, the scoped worker gets
 * exactly the gates the project's verify recipe already names, selected by id.
 *
 * What it is NOT. It is not a sandbox and not a prevention boundary. The
 * reproduced escape still works: a package.json script or a csproj
 * WriteLinesToFile target the recipe runs can write `../../../OUTSIDE.txt`.
 * writeScope is an accident-prevention boundary (ORCHESTRATOR_CONTRACT: "never
 * describe either as sandboxed"), and this tool adds a DETECTIVE control on top:
 *
 *  - `git status --porcelain -z --untracked-files=all` of the enclosing repository
 *    is snapshotted before and after the run, with a content fingerprint per
 *    listed path (so a file already dirty before the run and modified again is
 *    still seen as changed);
 *  - every path whose status/fingerprint differs is classified against the
 *    worker's CURRENT writeScope ({@link WorkerWriteScope.covers});
 *  - any path outside it makes the call fail with the exact paths, is logged, and
 *    is reported to the owning orchestrator in the job result (`onViolation`).
 *
 * Detection limits (stated in the tool description too, so nobody over-reads it):
 *  - writes OUTSIDE the git repository are not detected (no repo-wide view);
 *  - writes to git-ignored paths (build outputs, node_modules, bin/obj) are not
 *    detected — `git status` does not list them;
 *  - it compares NET state: a change made and fully reverted during the run is
 *    not seen;
 *  - nothing is reverted — the change has already happened;
 *  - concurrent writers in the same repository (other workers in disjoint
 *    scopes, the main session) during the run window are attributed to the gate.
 *
 * Command source. Gates come ONLY from the verify recipe — the stored
 * `.muonroi-cli/environment.json` (or root `environment.json`) merged with the
 * live disk derivation by `inferVerifyProjectProfile` / `mergeStoredVerifyRecipe`,
 * the exact composition `prepareVerifyRun` uses. `buildCommands` → `build-N`,
 * `testCommands` → `test-N`. No per-ecosystem list lives here. The catalog is
 * resolved once when the worker's tools are built (dispatch time), so a worker
 * editing the manifest mid-job cannot add a gate to its own grant.
 *
 * Execution reuses `runFloorCommand` (verify floor): shell spawn in the worker
 * cwd, closed stdin, timeout and abort both TREE-kill the gate (5ad6e548).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp, realpathSync } from "node:fs";
import path from "node:path";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { type FloorCheck, getFloorTimeoutMs, isStyleGate, runFloorCommand } from "../product-loop/verify-floor.js";
import { logger } from "../utils/logger.js";
import { checkCatastrophicCommand } from "../utils/permission-mode.js";
import { loadVerifyEnvironment } from "../verify/environment.js";
import { inferVerifyProjectProfile } from "../verify/recipes.js";
import { workerProcessRefusal } from "./worker-process-boundary.js";
import type { WorkerWriteScope } from "./worker-write-scope.js";

export interface GateEntry {
  /** `build-N` / `test-N`, 1-based in recipe order. */
  id: string;
  kind: "build" | "test";
  command: string;
}

export interface GateCatalog {
  /** Manifest path, or the disk derivation when no manifest exists. */
  source: string;
  gates: GateEntry[];
  ecosystem?: string;
}

const DISK_DERIVATION = "disk derivation (inferVerifyProjectProfile; no environment.json)";

/** The verify recipe's build/test commands as selectable gates. Never throws. */
export function resolveGateCatalog(cwd: string): GateCatalog {
  try {
    const manifest = loadVerifyEnvironment(cwd);
    const profile = inferVerifyProjectProfile(cwd, manifest?.sandboxSettings ?? {}, manifest?.recipe ?? null);
    const seen = new Set<string>();
    const gates: GateEntry[] = [];
    for (const kind of ["build", "test"] as const) {
      const commands = kind === "build" ? profile.recipe.buildCommands : profile.recipe.testCommands;
      let n = 0;
      for (const raw of commands ?? []) {
        const command = typeof raw === "string" ? raw.trim() : "";
        if (!command || seen.has(command)) continue;
        seen.add(command);
        gates.push({ id: `${kind}-${++n}`, kind, command });
      }
    }
    return { source: manifest?.path ?? DISK_DERIVATION, gates, ecosystem: profile.recipe.ecosystem };
  } catch (err) {
    logger.error("orchestrator", `[run-gate] gate catalog resolution failed for cwd=${cwd}`, {
      operation: "resolveGateCatalog",
      cwd,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    return { source: "unavailable", gates: [] };
  }
}

const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, " ");

/** What a dispatch-time run directive asks for (see worker-dispatch-guard). */
export interface GateRequirement {
  kind: "command" | "tests";
  /** Explicit command text from the prompt (code span / `Run: <cmd>` / verify-with). */
  command?: string;
  /** The command noun the directive named ("build", "lint", ...), lowercased. */
  object?: string;
}

/**
 * The gate that serves a run directive, if any. An explicit command must equal a
 * gate command (whitespace-normalized) — anything else is free-form and refused.
 * Without an explicit command: tests → any test gate; build/compile → any build
 * gate; lint → a style gate; "gate" → any gate. Other nouns ("commands",
 * "script", "pack", ...) are not servable.
 */
export function findServingGate(requirement: GateRequirement, catalog: GateCatalog): GateEntry | undefined {
  if (requirement.command !== undefined) {
    const wanted = normalizeCommand(requirement.command);
    return catalog.gates.find((gate) => normalizeCommand(gate.command) === wanted);
  }
  if (requirement.kind === "tests") return catalog.gates.find((gate) => gate.kind === "test");
  switch (requirement.object) {
    case "build":
    case "compile":
      return catalog.gates.find((gate) => gate.kind === "build");
    case "lint":
      return catalog.gates.find((gate) => isStyleGate(gate.command));
    case "gate":
      return catalog.gates[0];
    default:
      return undefined;
  }
}

export function describeGateCatalog(catalog: GateCatalog): string {
  return catalog.gates.length
    ? catalog.gates.map((gate) => `${gate.id} \`${gate.command}\``).join("; ")
    : "none (the verify recipe has no build/test commands)";
}

// ── Detective control: git working-tree snapshot ─────────────────────────────

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Above this size a file is fingerprinted by size+mtime instead of content. */
const HASH_LIMIT_BYTES = 16 * 1024 * 1024;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${err.message} ${String(stderr).trim()}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * The repository root expressed in the SAME path namespace as
 * {@link WorkerWriteScope}'s binding (`realpathSync(cwd)`), so a changed path
 * `join(root, rel)` is classified against the scope by prefix, not by alias.
 *
 * `--show-toplevel` is NOT that namespace on Windows: git returns the long-name
 * form (`C:/Users/runneradmin/...`) while `realpathSync` keeps an 8.3 short
 * cwd as given (`C:\Users\RUNNER~1\...`, the GitHub windows runner's TEMP).
 * Every in-scope change then fell outside the scope (ci-matrix run 42131417821:
 * "1 path(s) changed OUTSIDE your writeScope ... src/generated.txt" with
 * writeScope ["src/"]). `--show-cdup` is relative, so resolving it against the
 * cwd's own realpath keeps the namespace by construction.
 */
export async function gitRepoRoot(cwd: string): Promise<string> {
  const cdup = (await git(["rev-parse", "--show-cdup"], cwd)).trim();
  return path.resolve(realpathSync(cwd), cdup);
}

async function fingerprint(absolute: string): Promise<string> {
  const info = await fsp.lstat(absolute).catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  });
  if (!info) return "absent";
  if (info.isSymbolicLink()) return `link:${await fsp.readlink(absolute)}`;
  if (info.isDirectory()) return "dir";
  if (info.size > HASH_LIMIT_BYTES) return `big:${info.size}:${info.mtimeMs}`;
  return `sha1:${createHash("sha1")
    .update(await fsp.readFile(absolute))
    .digest("hex")}`;
}

/**
 * Repo-relative path (forward slashes) → `XY|fingerprint` for every path
 * `git status` lists, untracked files expanded individually. Ignored paths are
 * not listed by git and therefore not covered.
 */
export async function snapshotWorkingTree(root: string): Promise<Map<string, string>> {
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  const tokens = out.split("\0");
  const entries: Array<{ rel: string; xy: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const xy = token.slice(0, 2);
    entries.push({ rel: token.slice(3), xy });
    // Renames/copies carry the source path as the next NUL-separated token.
    if (/[RC]/.test(xy) && tokens[i + 1]) entries.push({ rel: tokens[++i]!, xy: `${xy}<` });
  }
  const snapshot = new Map<string, string>();
  for (const { rel, xy } of entries) {
    const clean = rel.replace(/\/$/, "");
    snapshot.set(clean, `${xy}|${await fingerprint(path.join(root, clean))}`);
  }
  return snapshot;
}

export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [rel, value] of before) if (after.get(rel) !== value) changed.add(rel);
  for (const [rel, value] of after) if (before.get(rel) !== value) changed.add(rel);
  return [...changed].sort();
}

// ── Execution ────────────────────────────────────────────────────────────────

export interface RunGateOutcome {
  success: boolean;
  gate: GateEntry;
  check: FloorCheck;
  repoRoot: string;
  inScopeChanges: string[];
  outOfScopeChanges: string[];
  /** Set when the after-snapshot or scope read failed; the call then fails closed. */
  detectionError?: string;
}

export const RUN_GATE_DETECTION_LIMITS =
  "Detection only, not prevention: out-of-scope changes are found by diffing `git status` (incl. untracked) of the repository before/after and are NOT reverted. Writes outside the git repository, to git-ignored paths, or changed and reverted during the run are not detected; concurrent writes by other workers in the repository during the run are attributed to this gate.";

/**
 * Snapshot → run → snapshot → classify. The caller supplies the scope READER,
 * evaluated after the run, so an owner scope decision made while the gate ran is
 * honoured. No delegation lock is held while the command runs.
 */
export async function runScopedGate(opts: {
  gate: GateEntry;
  cwd: string;
  timeoutMs: number;
  currentScope: () => Promise<WorkerWriteScope>;
  ecosystem?: string;
  signal?: AbortSignal;
}): Promise<RunGateOutcome> {
  const repoRoot = await gitRepoRoot(opts.cwd);
  const before = await snapshotWorkingTree(repoRoot);
  const check = await runFloorCommand(
    opts.gate.kind,
    opts.gate.command,
    opts.cwd,
    opts.timeoutMs,
    opts.ecosystem,
    opts.signal,
  );
  let changed: string[] = [];
  let scope: WorkerWriteScope | undefined;
  let detectionError: string | undefined;
  try {
    changed = diffSnapshots(before, await snapshotWorkingTree(repoRoot));
    scope = await opts.currentScope();
  } catch (err) {
    detectionError = err instanceof Error ? err.message : String(err);
    logger.error("orchestrator", `[run-gate] post-run scope check failed for gate ${opts.gate.id}`, {
      operation: "runScopedGate",
      cwd: opts.cwd,
      gate: opts.gate.id,
      error: detectionError,
    });
  }
  const inScopeChanges: string[] = [];
  const outOfScopeChanges: string[] = [];
  for (const rel of changed) {
    if (scope?.covers(path.join(repoRoot, rel))) inScopeChanges.push(rel);
    else outOfScopeChanges.push(rel);
  }
  if (outOfScopeChanges.length)
    logger.file("warn", "orchestrator", "run_gate detected changes outside the worker writeScope", {
      gate: opts.gate.id,
      command: opts.gate.command,
      cwd: opts.cwd,
      repoRoot,
      writeScope: scope?.paths,
      outOfScopeChanges,
    });
  return {
    success: check.ok && !detectionError && outOfScopeChanges.length === 0,
    gate: opts.gate,
    check,
    repoRoot,
    inScopeChanges,
    outOfScopeChanges,
    detectionError,
  };
}

const MAX_LISTED_PATHS = 200;

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `  - ${p}`);
  if (paths.length > MAX_LISTED_PATHS) shown.push(`  - … ${paths.length - MAX_LISTED_PATHS} more`);
  return shown.join("\n");
}

export function formatRunGateOutcome(outcome: RunGateOutcome): string {
  const { check, gate } = outcome;
  const verdict = check.spawnError
    ? `did not complete (${check.spawnError})`
    : check.timedOut
      ? `timed out after ${check.elapsedMs}ms; process tree killed`
      : `${check.ok ? "passed" : "failed"} (exit ${String(check.exitCode)}, ${check.elapsedMs}ms)`;
  const lines = [`gate ${gate.id} \`${gate.command}\` ${verdict}`];
  if (check.noTests) lines.push(`zero tests executed (${check.noTests.kind}): ${check.noTests.evidence}`);
  if (check.couldNotRun) lines.push(`could not run (${check.couldNotRun.kind}): ${check.couldNotRun.evidence}`);
  if (outcome.detectionError)
    lines.push(`run_gate_detection_failed: ${outcome.detectionError}. Scope effects are UNKNOWN; reported to main.`);
  if (outcome.outOfScopeChanges.length)
    lines.push(
      `run_gate_scope_violation: ${outcome.outOfScopeChanges.length} path(s) changed OUTSIDE your writeScope during this gate (repository ${outcome.repoRoot}). Already written, not reverted; reported to main. Do not repair them yourself — ask main with worker_message.`,
      listPaths(outcome.outOfScopeChanges),
    );
  lines.push(
    `scope check: ${outcome.inScopeChanges.length + outcome.outOfScopeChanges.length} changed path(s), ${outcome.outOfScopeChanges.length} outside writeScope.`,
  );
  lines.push(RUN_GATE_DETECTION_LIMITS, "--- output tail ---", check.outputTail || "(no output)");
  return lines.join("\n");
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export interface RunGateToolOpts {
  cwd: string;
  catalog: GateCatalog;
  /** Bound scope used when no durable job record exists (in-process task). */
  boundScope: WorkerWriteScope;
  /** Current host scope (durable jobs: re-read from the job record). */
  currentScope?: () => Promise<WorkerWriteScope>;
  /** Host observation for the job result: violations and failed detection. */
  onViolation?: (observation: string) => void;
  timeoutMs?: number;
}

/** Register `run_gate` when the recipe has at least one gate. Returns whether it registered. */
export function registerRunGateTool(tools: ToolSet, opts: RunGateToolOpts): boolean {
  const { catalog } = opts;
  if (catalog.gates.length === 0) return false;
  let queue: Promise<unknown> = Promise.resolve();
  tools.run_gate = dynamicTool({
    description: `Run ONE host-defined verification gate from this project's verify recipe (source: ${catalog.source}). Gates: ${describeGateCatalog(catalog)}. Pass gate=<id> and command=<that gate's exact command>; any other command is refused — this is not a shell. Runs in your cwd with a timeout (the process tree is killed on expiry). ${RUN_GATE_DETECTION_LIMITS} Any change outside your writeScope fails the call and is reported to main.`,
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        gate: { type: "string", enum: catalog.gates.map((gate) => gate.id) },
        command: { type: "string", description: "The exact command listed for that gate (shown in approvals)." },
      },
      required: ["gate", "command"],
      additionalProperties: false,
    }),
    execute: async (input: any, context: any) => {
      const gate = catalog.gates.find((entry) => entry.id === input?.gate);
      if (
        !gate ||
        typeof input?.command !== "string" ||
        normalizeCommand(input.command) !== normalizeCommand(gate.command)
      )
        return `ERROR: run_gate_refused: unknown gate or command mismatch (got gate=${JSON.stringify(input?.gate)}, command=${JSON.stringify(input?.command)}). Only these recipe gates run: ${describeGateCatalog(catalog)}. No command executed.`;
      const policy = checkCatastrophicCommand(gate.command)?.reason ?? workerProcessRefusal(gate.command);
      if (policy) return `ERROR: run_gate_refused: ${policy}`;
      // One gate at a time per worker: overlapping runs would see each other's effects.
      const run = queue.then(async () => {
        try {
          return await runScopedGate({
            gate,
            cwd: opts.cwd,
            timeoutMs: opts.timeoutMs ?? getFloorTimeoutMs(),
            currentScope: opts.currentScope ?? (async () => opts.boundScope),
            ecosystem: catalog.ecosystem,
            signal: context?.abortSignal,
          });
        } catch (err) {
          // Pre-run failure (not a git repository / git missing): fail closed, nothing ran.
          const message = err instanceof Error ? err.message : String(err);
          logger.file("warn", "orchestrator", "run_gate could not establish scope detection", {
            gate: gate.id,
            cwd: opts.cwd,
            error: message,
          });
          return message;
        }
      });
      queue = run.catch((err) => {
        logger.file("warn", "orchestrator", "run_gate queue entry failed", { error: String(err) });
      });
      const outcome = await run;
      if (typeof outcome === "string")
        return `ERROR: run_gate_unavailable: could not establish out-of-scope detection, which needs a readable git repository containing ${opts.cwd} (${outcome}). No command executed. Ask main to run this gate through an execution-capable worker.`;
      const text = formatRunGateOutcome(outcome);
      if (outcome.outOfScopeChanges.length || outcome.detectionError)
        opts.onViolation?.(
          outcome.detectionError
            ? `run_gate ${gate.id} \`${gate.command}\`: post-run scope detection failed (${outcome.detectionError}); file effects unknown.`
            : `run_gate ${gate.id} \`${gate.command}\` changed ${outcome.outOfScopeChanges.length} path(s) outside writeScope (detected after the fact, not reverted): ${outcome.outOfScopeChanges.slice(0, 50).join(", ")}${outcome.outOfScopeChanges.length > 50 ? ", …" : ""}`,
        );
      return outcome.success ? text : `ERROR: ${text}`;
    },
  });
  return true;
}
