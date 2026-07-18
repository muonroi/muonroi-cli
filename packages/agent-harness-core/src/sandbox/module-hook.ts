// ---------------------------------------------------------------------------
// Module hook — sandbox-aware CJS require() interceptor
// ---------------------------------------------------------------------------
// Intercepts Node.js Module._resolveFilename to enforce sandbox path
// boundaries on every require() call. Without this hook, sandboxed code
// could bypass the gate by using require() to read files outside the
// allowlist. The hook is installed/uninstalled by the sandbox runtime.
// ---------------------------------------------------------------------------

import { realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { resolve as resolvePath } from "node:path";
import type { DenyObject, PhaseSignal } from "./types.js";

/**
 * Phase provider — a callback the orchestrator sets to emit phase
 * transitions. Called on every non-builtin require() resolution.
 */
export type PhaseProvider = () => PhaseSignal;

/**
 * Path allowlist check function. Return null to allow, or a DenyObject
 * to block the require() with a structured reason.
 */
export type PathChecker = (resolvedPath: string, phase: PhaseSignal) => DenyObject | null;

// ---------------------------------------------------------------------------
// Module-scoped mutable state (saved at install/uninstall time)
// ---------------------------------------------------------------------------

type ModuleResolveFn = (
  request: string,
  parent: { filename: string; paths: string[] } | undefined,
  isMain: boolean,
  options?: Record<string, unknown>,
) => string;

let originalResolveFilename: ModuleResolveFn | null = null;
let currentPhaseProvider: PhaseProvider | null = null;
let currentPathChecker: PathChecker | null = null;
let installed = false;

// ---------------------------------------------------------------------------
// Default path checker
// ---------------------------------------------------------------------------

/**
 * Default checker: verify the resolved path is within SANDBOX_ROOT.
 * Returns null if allowed, DenyObject on escape.
 */
function defaultPathChecker(resolvedPath: string, phase: PhaseSignal): DenyObject | null {
  let real: string;
  try {
    real = realpathSync(resolvedPath);
  } catch {
    real = resolvedPath;
  }

  const sandboxRoot = process.env.MUONROI_SANDBOX_ROOT
    ? resolvePath(process.env.MUONROI_SANDBOX_ROOT)
    : resolvePath("/");

  if (!real.startsWith(sandboxRoot)) {
    return {
      reason: `module path ${real} escapes sandbox root ${sandboxRoot}`,
      code: "PATH_NOT_ALLOWLISTED",
      retryable: false,
      phase,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

function createResolveHook(phaseProvider: PhaseProvider, pathChecker: PathChecker): ModuleResolveFn {
  return function resolveHook(
    this: unknown,
    request: string,
    parent: { filename: string; paths: string[] } | undefined,
    isMain: boolean,
    options?: Record<string, unknown>,
  ): string {
    // Built-in modules (fs, path, etc.) are always allowed — they don't
    // represent filesystem access the sandbox cares about.
    if (isBuiltin(request)) {
      return originalResolveFilename!(request, parent, isMain, options);
    }

    // Resolve through the original resolver first (so we know the real path).
    let resolved: string;
    try {
      resolved = originalResolveFilename!(request, parent, isMain, options);
    } catch (err) {
      // Module-not-found etc. — rethrow unchanged.
      throw err;
    }

    // Phase-driven path check.
    const phase = phaseProvider();
    const deny = pathChecker(resolved, phase);

    if (deny) {
      throw new Error(`sandbox denied require('${request}'): ${deny.reason} (code: ${deny.code})`);
    }

    return resolved;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install the module-resolution hook. Every subsequent require() call in
 * the same process is intercepted and checked against the current phase.
 *
 * @param phaseProvider  Callback that returns the current PhaseSignal.
 * @param pathChecker    Optional custom path checker (default: sandbox-root
 *                       containment check). Returns DenyObject to block.
 *
 * @throws {Error} If the hook is already installed.
 */
export function install(phaseProvider: PhaseProvider, pathChecker?: PathChecker): void {
  if (installed) {
    throw new Error("sandbox module hook: already installed");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("module") as { _resolveFilename: ModuleResolveFn };

  currentPhaseProvider = phaseProvider;
  currentPathChecker = pathChecker ?? defaultPathChecker;
  originalResolveFilename = Module._resolveFilename;

  Module._resolveFilename = createResolveHook(currentPhaseProvider, currentPathChecker) as ModuleResolveFn;

  installed = true;
}

/**
 * Uninstall the module-resolution hook and restore the original
 * Module._resolveFilename. Safe to call when not installed.
 */
export function uninstall(): void {
  if (!installed || !originalResolveFilename) return;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("module") as { _resolveFilename: ModuleResolveFn };

  Module._resolveFilename = originalResolveFilename;
  originalResolveFilename = null;
  currentPhaseProvider = null;
  currentPathChecker = null;
  installed = false;
}

/**
 * Check whether the hook is currently active.
 */
export function isInstalled(): boolean {
  return installed;
}
