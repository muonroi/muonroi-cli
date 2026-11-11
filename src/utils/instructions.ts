import * as fs from "fs";
import * as path from "path";
import { executeEventHooks } from "../hooks/index";
import type { InstructionsLoadedHookInput } from "../hooks/types";
import { findGitRoot } from "./git-root";
import { logger } from "./logger.js";
import { muonroiHome } from "./muonroi-home.js";
import { getProjectDocFallbackFilenames, getProjectDocMaxBytes } from "./settings.js";

/**
 * Project instruction loading — Codex AGENTS.md parity.
 *
 * Owner decision: the rule context injected into every orchestrator / worker
 * system prompt was far too large (AGENTS.md + CLAUDE.md + GEMINI.md +
 * DEEPSEEK.md + COPILOT.md + CURSOR.md per directory, plus every ancestor
 * directory above the git root). Read ONE file per directory, like Codex.
 *
 * Rules mirror openai/codex `codex-rs/core/src/agents_md.rs` +
 * `codex-rs/codex-home/src/instructions/mod.rs`:
 *   1. Global: the muonroi home's first NON-EMPTY file of
 *      `AGENTS.override.md`, `AGENTS.md`. Not counted in the project budget.
 *   2. Project root = nearest ancestor of cwd holding `.git`; no root → cwd only.
 *      Nothing ABOVE the project root is read.
 *   3. Each directory from the root down to cwd contributes AT MOST one file:
 *      the first that exists of `AGENTS.override.md`, `AGENTS.md`, then the
 *      opt-in `projectDocFallbackFilenames` user setting (default empty). An
 *      empty selected file is skipped (no retry with the next name).
 *   4. Concatenated root → cwd with blank lines; a total project byte budget
 *      (`projectDocMaxBytes`, default 32 KiB) truncates the file that crosses it
 *      and drops everything after. A budget of 0 disables project instructions.
 */

const instructionsHookFiredFor = new Set<string>();

// --- Instructions cache ---
const _instructionsCache = new Map<string, { content: string | null; hash: string; cachedAt: number }>();
const INSTRUCTIONS_CACHE_TTL_MS = 60_000; // 1 minute TTL — files rarely change mid-session

export const DEFAULT_INSTRUCTIONS_FILENAME = "AGENTS.md";
export const OVERRIDE_INSTRUCTIONS_FILENAME = "AGENTS.override.md";

function computeHash(parts: string[]): string {
  const joined = parts.join("|");
  return `${joined.length}:${joined.slice(0, 50)}:${joined.slice(-50)}`;
}

/** Clear the instructions cache (for tests). */
export function resetInstructionsCache(): void {
  _instructionsCache.clear();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT / ENOTDIR are the normal "no such instruction file" answer.
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      logger.file("warn", "orchestrator", `[instructions] stat failed for ${filePath}: ${errMessage(err)}`);
    }
    return false;
  }
}

function readFileBytes(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    logger.file("warn", "orchestrator", `[instructions] read failed for ${filePath}: ${errMessage(err)}`);
    return null;
  }
}

function directoryChain(fromRoot: string, toCwd: string): string[] {
  const rel = path.relative(fromRoot, toCwd);
  if (rel === "") return [fromRoot];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [toCwd];

  const segments = rel.split(path.sep).filter(Boolean);
  const chain: string[] = [];
  let acc = fromRoot;
  chain.push(acc);
  for (const segment of segments) {
    acc = path.join(acc, segment);
    chain.push(acc);
  }
  return chain;
}

/**
 * Accept only a bare filename (Codex rejects `.`, `..`, and anything with path
 * syntax before probing the filesystem). Returns the de-duplicated candidate
 * list for a project directory: override, AGENTS.md, then the opt-in names.
 */
export function projectCandidateFilenames(fallbacks: readonly string[]): string[] {
  const names: string[] = [OVERRIDE_INSTRUCTIONS_FILENAME, DEFAULT_INSTRUCTIONS_FILENAME];
  for (const raw of fallbacks) {
    const name = raw.trim();
    if (name === "") continue;
    if (name === "." || name === ".." || /[\\/:\0]/.test(name)) {
      logger.file(
        "warn",
        "orchestrator",
        `[instructions] ignoring projectDocFallbackFilenames entry that is not a filename: ${JSON.stringify(raw)}`,
      );
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Fallback files are labelled so the model can tell which tool's file it is reading. */
function labelSegment(filename: string, label: string, text: string): string {
  if (filename === DEFAULT_INSTRUCTIONS_FILENAME || filename === OVERRIDE_INSTRUCTIONS_FILENAME) return text;
  return `<!-- ${label} -->\n${text}`;
}

/** Global instructions: first non-empty of AGENTS.override.md, AGENTS.md. */
function loadGlobalSegment(): string | null {
  const homeDir = muonroiHome();
  for (const fname of [OVERRIDE_INSTRUCTIONS_FILENAME, DEFAULT_INSTRUCTIONS_FILENAME]) {
    const fp = path.join(homeDir, fname);
    if (!isFile(fp)) continue;
    const data = readFileBytes(fp);
    if (!data) continue;
    const text = data.toString("utf-8").trim();
    if (text.length > 0) return text;
  }
  return null;
}

function loadProjectSegments(canonicalCwd: string): string[] {
  const maxBytes = getProjectDocMaxBytes();
  if (maxBytes === 0) return [];

  // `findGitRoot` walks up from the CANONICAL cwd, so root and cwd share one
  // spelling (macOS /var → /private/var, Windows 8.3 short names) and
  // `path.relative` between them never starts with `..` for a real descendant.
  const root = findGitRoot(canonicalCwd) ?? canonicalCwd;
  const candidates = projectCandidateFilenames(getProjectDocFallbackFilenames());

  const segments: string[] = [];
  let remaining = maxBytes;
  for (const dir of directoryChain(root, canonicalCwd)) {
    const fname = candidates.find((name) => isFile(path.join(dir, name)));
    if (!fname) continue;
    const fp = path.join(dir, fname);
    if (remaining === 0) {
      logger.file(
        "warn",
        "orchestrator",
        `[instructions] skipped ${fp} and later project instructions: ${maxBytes}-byte projectDocMaxBytes budget exhausted`,
      );
      break;
    }
    let data = readFileBytes(fp);
    if (!data) continue;
    if (data.length > remaining) {
      logger.file(
        "warn",
        "orchestrator",
        `[instructions] loaded only ${remaining} of ${data.length} bytes from ${fp} under the ${maxBytes}-byte projectDocMaxBytes budget — trim the file or raise projectDocMaxBytes`,
      );
      data = data.subarray(0, remaining);
    }
    const text = data.toString("utf-8").trim();
    if (text.length === 0) continue; // empty selected file: skipped, no retry with the next name (Codex parity)
    const rel = path.relative(canonicalCwd, dir);
    segments.push(labelSegment(fname, rel === "" ? fname : path.join(rel, fname), text));
    remaining -= data.length;
  }
  return segments;
}

function loadAgentsSegments(canonicalCwd: string): string[] {
  const segments: string[] = [];
  const global = loadGlobalSegment();
  if (global) segments.push(global);
  segments.push(...loadProjectSegments(canonicalCwd));
  return segments;
}

/**
 * The one spelling the OS reports for a path: symlinks resolved, Windows 8.3
 * short names expanded, drive-letter case normalised. Falls back to
 * `path.resolve` for a path that does not exist (or cannot be stat'd), so the
 * loader never throws on it.
 */
function canonicalizePath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    logger.file(
      "debug",
      "orchestrator",
      `[instructions] realpath failed for ${p}, using path.resolve: ${errMessage(err)}`,
    );
    return path.resolve(p);
  }
}

function fireInstructionsLoadedHook(canonical: string, filesLoaded: number): void {
  if (instructionsHookFiredFor.has(canonical)) return;
  instructionsHookFiredFor.add(canonical);
  const hookInput: InstructionsLoadedHookInput = {
    hook_event_name: "InstructionsLoaded",
    files_loaded: filesLoaded,
    cwd: canonical,
  };
  executeEventHooks(hookInput, canonical).catch((err: unknown) => {
    logger.file("warn", "orchestrator", `[instructions] InstructionsLoaded hook failed: ${errMessage(err)}`);
  });
}

export function loadCustomInstructions(cwd: string): string | null {
  const canonical = canonicalizePath(cwd);

  // Check cache first
  const now = Date.now();
  const cached = _instructionsCache.get(canonical);
  if (cached && now - cached.cachedAt < INSTRUCTIONS_CACHE_TTL_MS) {
    // Still fire hook on first call even when returning cached content
    if (cached.content !== null) fireInstructionsLoadedHook(canonical, cached.content.split("\n\n").length);
    return cached.content;
  }

  const parts: string[] = loadAgentsSegments(canonical);

  if (parts.length === 0) {
    _instructionsCache.set(canonical, { content: null, hash: "", cachedAt: now });
    return null;
  }

  fireInstructionsLoadedHook(canonical, parts.length);

  const content = parts.join("\n\n");
  _instructionsCache.set(canonical, { content, hash: computeHash(parts), cachedAt: now });
  return content;
}
