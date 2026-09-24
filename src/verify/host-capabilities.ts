/**
 * src/verify/host-capabilities.ts
 *
 * Does the HOST actually have the tool the verify prompt is about to demand?
 *
 * MEASURED DEFECT, run `muc2joffe506` sprint 2. `buildVerifyTaskPrompt` told the
 * stage "agent-browser commands run on the HOST. They WILL work. Do not skip
 * them." and `buildBrowserGuidance` added "Do not skip it or assume it is
 * unavailable." Measured on that same host:
 *
 *     $ which agent-browser
 *     which: no agent-browser in (/mingw64/bin:/usr/bin:...)
 *     $ agent-browser --version
 *     /usr/bin/bash: line 1: agent-browser: command not found
 *
 * The stage obeyed: it tried the documented script, then hunted for substitutes
 * across six minutes of tool calls, then asked a human. A prompt may only assert
 * what it has checked.
 *
 * SYNC and spawn-free on purpose: `buildVerifyTaskPrompt` is a synchronous pure-ish
 * prompt builder, and spawning a probe per prompt build would be both slow and
 * non-deterministic in tests. A PATH scan is exactly what a shell does.
 *
 * NOTE this is deliberately a HOST probe even in shuru mode — the prompt's own
 * claim is that these commands run on the host, not in the sandbox, so the host is
 * the right thing to look at.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface HostExecutableProbeOptions {
  /** Defaults to `process.env.PATH`. */
  pathValue?: string;
  /** Defaults to `process.env.PATHEXT`; only consulted on win32. */
  pathExt?: string;
  /** Defaults to `process.platform`. */
  platform?: string;
}

/** Windows' default when PATHEXT is unset, lowercased for comparison. */
const DEFAULT_PATHEXT = ".com;.exe;.bat;.cmd";

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    // A PATH entry can be an unreadable or torn-down directory; an EACCES/EPERM on
    // one candidate must not decide the answer for the rest. Not logged: this runs
    // once per PATH entry per prompt build, and "cannot stat this one path" is not
    // diagnostic information — the boolean result is what callers act on.
    return false;
  }
}

/**
 * Is `name` resolvable as an executable on the host's PATH?
 *
 * Never throws: a malformed or absent PATH answers `false` (the conservative
 * answer — the prompt then stops claiming the tool will work).
 */
export function hasHostExecutable(name: string, opts: HostExecutableProbeOptions = {}): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;

  const platform = opts.platform ?? process.platform;
  const pathValue = opts.pathValue ?? process.env.PATH ?? process.env.Path ?? "";
  if (pathValue.length === 0) return false;

  const exts =
    platform === "win32"
      ? ["", ...(opts.pathExt ?? process.env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter((e) => e.length > 0)]
      : [""];

  // An explicit path is not a PATH lookup — answer about the file itself.
  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return exts.some((ext) => isFile(`${trimmed}${ext}`));
  }

  for (const dir of pathValue.split(delimiter)) {
    const entry = dir.trim().replace(/^"|"$/g, "");
    if (entry.length === 0) continue;
    for (const ext of exts) {
      if (isFile(join(entry, `${trimmed}${ext}`))) return true;
    }
  }
  return false;
}

/** The browser-automation binary the verify prompt's Phase 4 is written around. */
export const BROWSER_TOOL_NAME = "agent-browser";

/** Dependency seam so prompt builders can be tested against both answers. */
export interface VerifyHostCapabilityDeps {
  hasHostExecutable?: (name: string) => boolean;
}

/**
 * Memoised answer for the default (real-PATH) probe.
 *
 * Every prompt build asks the same question, and a PATH scan on Windows is
 * ~60 entries x 4 extensions of `statSync`. Keyed on the PATH itself so a process
 * whose PATH changes is not answered from a stale entry. Not used when a caller
 * injects its own probe.
 */
const defaultProbeCache = new Map<string, boolean>();

function cachedHasHostExecutable(name: string): boolean {
  const key = `${process.env.PATH ?? process.env.Path ?? ""}\u0000${name}`;
  const hit = defaultProbeCache.get(key);
  if (hit !== undefined) return hit;
  const answer = hasHostExecutable(name);
  defaultProbeCache.set(key, answer);
  return answer;
}

export function resolveBrowserToolAvailable(deps?: VerifyHostCapabilityDeps): boolean {
  const probe = deps?.hasHostExecutable ?? cachedHasHostExecutable;
  try {
    return probe(BROWSER_TOOL_NAME);
  } catch (err) {
    console.error(
      `[verify/host-capabilities] probing for ${BROWSER_TOOL_NAME} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
