// ---------------------------------------------------------------------------
// Sandbox gate — Sprint 1 in-process boundary
// ---------------------------------------------------------------------------
// Stateless evaluation of agent tool requests against capability masks + allowlists.
// Fail-safe default: Read-only from allowlisted paths; everything else is DENY.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveMask } from "./capability-mask.js";
import { execCommandAllowlist, execProfile, readProfile, writeProfile } from "./profiles/index.js";
import type {
  CapabilityMask,
  DenyObject,
  GateResult,
  PathPattern,
  PhaseSignal,
  SandboxProfile,
  ToolRequest,
} from "./types.js";

// Sandbox root used to detect realpath escape. Defaults to "/" so the profile
// allowlist is the primary boundary. Deployments should set MUONROI_SANDBOX_ROOT
// to the workspace directory for stricter containment.
const SANDBOX_ROOT = process.env.MUONROI_SANDBOX_ROOT ? resolve(process.env.MUONROI_SANDBOX_ROOT) : resolve("/");

// Profiles ordered so most-permissive is evaluated last; match is exact by phase.
const PROFILES: SandboxProfile[] = [readProfile, writeProfile, execProfile];

interface NormalizedPath {
  requested: string;
  real?: string;
  error?: DenyObject;
}

/**
 * Normalize and optionally resolve the real path for a request. If realpath fails
 * we still allow the gate to decide on the requested path (e.g. path does not exist
 * yet for a write request), but we never allow realpath to escape SANDBOX_ROOT.
 */
async function normalizePath(requestedPath: string): Promise<NormalizedPath> {
  const requested = resolve(requestedPath);
  if (!isUnderRoot(requested, SANDBOX_ROOT)) {
    return {
      requested,
      error: makeDeny("PATH_NOT_ALLOWLISTED", `resolved path ${requested} escapes sandbox root ${SANDBOX_ROOT}`),
    };
  }
  try {
    const real = await realpath(requested);
    if (!isUnderRoot(real, SANDBOX_ROOT)) {
      return {
        requested,
        real,
        error: makeDeny("PATH_NOT_ALLOWLISTED", `realpath ${real} escapes sandbox root ${SANDBOX_ROOT}`),
      };
    }
    return { requested, real };
  } catch (err) {
    // realpath may fail for non-existent files (common for write targets). Fall back
    // to requested resolved path; allowlist will decide.
    return { requested };
  }
}

function isUnderRoot(p: string, root: string): boolean {
  const rel = relativeAfterResolve(p, root);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

function relativeAfterResolve(p: string, root: string): string {
  // Simple relative path check: ensure root is a prefix of p with separator.
  if (p === root) return ".";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  return "..";
}

function matchPattern(path: string, pattern: PathPattern): boolean {
  if (pattern.exact) return path === pattern.prefix;
  const prefix = pattern.prefix.endsWith("/") ? pattern.prefix : `${pattern.prefix}/`;
  return path === pattern.prefix || path.startsWith(prefix);
}

function isAllowed(path: string, profile: SandboxProfile): boolean {
  if (profile.deniedPaths.some((p) => matchPattern(path, p))) return false;
  if (profile.allowlist.length === 0) return false;
  return profile.allowlist.some((p) => matchPattern(path, p));
}

function makeDeny(code: DenyObject["code"], reason: string, phase?: PhaseSignal, retryable = false): DenyObject {
  return {
    code,
    reason,
    retryable,
    phase: phase ?? {
      value: "Read",
      source: "orchestrator-ssot",
      turnId: "fallback",
    },
  };
}

function buildDeny(phase: PhaseSignal, code: DenyObject["code"], reason: string, retryable = false): GateResult {
  return { outcome: "DENY", deny: makeDeny(code, reason, phase, retryable) };
}

function findProfile(phase: PhaseSignal): SandboxProfile | undefined {
  return PROFILES.find((p) => p.match(phase));
}

function getOp(req: ToolRequest): "read" | "write" | "spawn" | null {
  if (req.kind === "exec") return "spawn";
  if (req.kind === "fs") {
    // Tool request itself is a simple descriptor; the phase determines whether the
    // read or write capability is exercised. The gate only sees "fs" operations.
    // We rely on the capability mask to allow the operation.
    return "read";
  }
  return null;
}

async function evaluateFs(phase: PhaseSignal, mask: CapabilityMask, req: ToolRequest): Promise<GateResult> {
  const path = req.path;
  if (!path) {
    return buildDeny(phase, "OP_NOT_PERMITTED", "fs request missing path");
  }

  const normalized = await normalizePath(path);
  if (normalized.error) {
    return { outcome: "DENY", deny: normalized.error };
  }

  const profile = findProfile(phase);
  if (!profile) {
    return buildDeny(phase, "PHASE_MISMATCH", `no profile for phase ${phase.value}`);
  }

  const checkPath = normalized.real ?? normalized.requested;
  if (!isAllowed(checkPath, profile)) {
    return buildDeny(phase, "PATH_NOT_ALLOWLISTED", `${checkPath} is not in the allowlist for phase ${phase.value}`);
  }

  const op = getOp(req);
  if (op === null || !mask.allowedOps.has(op)) {
    return buildDeny(phase, "OP_NOT_PERMITTED", `operation ${op ?? "unknown"} not permitted in phase ${phase.value}`);
  }

  // Distinguish read vs write via the capability mask. The phase signal is the SSOT.
  const canWrite = mask.allowedOps.has("write");

  if (req.content !== undefined && !canWrite) {
    return buildDeny(phase, "OP_NOT_PERMITTED", `write content not permitted in phase ${phase.value}`);
  }

  if (canWrite) {
    // Write content is supplied as `req.content` when present; otherwise the gate allows an
    // empty write (e.g. creating a file) and the orchestrator performs the content write.
    // For Sprint 1 we write the content here if provided.
    if (req.content !== undefined) {
      try {
        await writeFile(checkPath, req.content, "utf8");
      } catch (err) {
        return buildDeny(
          phase,
          "PATH_NOT_ALLOWLISTED",
          `write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { outcome: "ALLOW" };
  }

  try {
    const content = await readFile(checkPath, "utf8");
    return { outcome: "ALLOW", result: { content } };
  } catch (err) {
    return buildDeny(phase, "PATH_NOT_ALLOWLISTED", `read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function evaluateExec(phase: PhaseSignal, mask: CapabilityMask, req: ToolRequest): Promise<GateResult> {
  if (!mask.allowedOps.has("spawn")) {
    return buildDeny(phase, "OP_NOT_PERMITTED", `exec/spawn not permitted in phase ${phase.value}`);
  }

  const profile = findProfile(phase);
  if (!profile || profile.type !== "Exec" || !profile.execOptions) {
    return buildDeny(phase, "PHASE_MISMATCH", `exec phase requires an Exec profile`);
  }

  // Non-root enforcement
  if (profile.execOptions.runAsNonRoot && process.getuid && process.getuid() === 0) {
    return buildDeny(phase, "ROOT_FORBIDDEN", "exec refused: running as root violates the non-root contract");
  }

  const command = req.command;
  if (!command || command.length === 0) {
    return buildDeny(phase, "OP_NOT_PERMITTED", "exec request missing command");
  }

  const [cmd, ...args] = command;
  if (!cmd) {
    return buildDeny(phase, "OP_NOT_PERMITTED", "exec command empty");
  }

  // Command allowlist check: only known-safe command basenames may be spawned.
  const basename = cmd.replace(/\\/g, "/").split("/").pop() || cmd;
  if (!execCommandAllowlist.has(basename)) {
    return buildDeny(phase, "OP_NOT_PERMITTED", `command ${basename} not in exec allowlist`);
  }

  // Build scrubbed env. Disallowed keys are stripped; the spawn proceeds with the
  // minimal allowlisted environment.
  const env = scrubEnv(req.env ?? {}, profile.execOptions);

  try {
    const { stdout, stderr } = await spawnOnce(cmd, args, env);
    return {
      outcome: "ALLOW",
      result: {
        stdout,
        stderr,
      },
    };
  } catch (err) {
    return buildDeny(phase, "OP_NOT_PERMITTED", `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Scrub environment for exec. By default we strip all variables and re-add a minimal
 * allowlist (PATH, HOME, TMPDIR, LOGNAME, USER) plus any keys in envAllow. If envAllow
 * is provided, we also permit those variables from the input env.
 */
function scrubEnv(
  input: Record<string, string>,
  options: { envScrub: string[]; envAllow?: string[] },
): Record<string, string> {
  const minimal = new Set<string>([
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "LOGNAME",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    ...(options.envAllow ?? []),
  ]);

  const output: Record<string, string> = {};
  const keepKeys = minimal;

  for (const key of keepKeys) {
    const value = input[key] ?? process.env[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }

  // Deny-by-default: any caller-supplied key not in the minimal list is silently
  // stripped rather than causing a hard failure. This matches the Sprint 1 env-scrub
  // acceptance criterion: dangerous vars are removed and the spawn proceeds.
  for (const key of Object.keys(input)) {
    if (!keepKeys.has(key)) {
      continue;
    }
    output[key] = input[key];
  }

  // Explicit scrub list: remove any variables marked for scrubbing.
  for (const scrubKey of options.envScrub) {
    delete output[scrubKey];
  }

  return output;
}

function spawnOnce(
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: false,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => reject(err));
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

/**
 * Evaluate a tool request against the current phase signal.
 * Stateless: every decision is derived from the provided phase + request.
 */
export async function evaluate(phase: PhaseSignal, req: ToolRequest): Promise<GateResult> {
  const mask = resolveMask(phase);

  switch (req.kind) {
    case "fs":
      return evaluateFs(phase, mask, req);
    case "exec":
      return evaluateExec(phase, mask, req);
    default:
      return buildDeny(phase, "OP_NOT_PERMITTED", `unknown tool request kind: ${(req as any).kind}`);
  }
}

export { resolveMask } from "./capability-mask.js";
export { execProfile, readProfile, writeProfile } from "./profiles/index.js";
export type { CapabilityMask, DenyObject, GateResult, PhaseSignal, ToolRequest } from "./types.js";
