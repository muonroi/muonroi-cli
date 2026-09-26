import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { executeEventHooks } from "../hooks/index";
import type { InstructionsLoadedHookInput } from "../hooks/types";
import { findGitRoot } from "./git-root";

const instructionsHookFiredFor = new Set<string>();

// --- Instructions cache ---
const _instructionsCache = new Map<string, { content: string | null; hash: string; cachedAt: number }>();
const INSTRUCTIONS_CACHE_TTL_MS = 60_000; // 1 minute TTL — files rarely change mid-session

function computeHash(parts: string[]): string {
  const joined = parts.join("|");
  return `${joined.length}:${joined.slice(0, 50)}:${joined.slice(-50)}`;
}

/** Clear the instructions cache (for tests). */
export function resetInstructionsCache(): void {
  _instructionsCache.clear();
}

function readNonEmptyFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Parity fix (G4): Claude Code also loads parent-directory CLAUDE.md files
 * ABOVE the project's own root, up to $HOME (and `~/.claude/CLAUDE.md`) —
 * this loader previously reached only from the git root DOWN to `cwd`.
 * Measured (FINDINGS.md G4): a Vietnamese request got an all-English reply
 * because the "reply in the user's own language" rule lives in
 * `~/Personal/Core/CLAUDE.md`, one directory above the git root
 * `~/Personal/Core/shipd-challenges` — a file this loader never reached.
 *
 * Ceiling on the total bytes loaded from ancestor directories, independent
 * of the (uncapped, pre-existing) git-root-down and muonroi-home segments —
 * an ancestor chain can be many levels deep on some machines and this is
 * new, previously-untested surface, so it gets its own explicit budget
 * rather than silently inflating every turn's system prompt.
 */
export const MAX_ANCESTOR_INSTRUCTIONS_BYTES = 32 * 1024;

/**
 * Directories from `home` down to (but EXCLUDING) `gitRoot` itself — the
 * git root's own instruction files are already the first entry of the
 * `directoryChain(root, canonicalCwd)` loop below, so including it here
 * would double-load it.
 *
 * Returns `[]` when `gitRoot` is not inside `home` at all (a repo checked
 * out somewhere like /tmp or /opt has no meaningful "ancestors up to
 * $HOME" to walk) or IS `home` itself (nothing sits between them).
 */
export function ancestorDirsAboveGitRoot(home: string, gitRoot: string): string[] {
  const rel = path.relative(home, gitRoot);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const parent = path.dirname(gitRoot);
  return directoryChain(home, parent);
}

function directoryChain(fromRoot: string, toCwd: string): string[] {
  const rel = path.relative(fromRoot, toCwd);
  if (rel === "") return [fromRoot];
  if (rel.startsWith("..")) return [toCwd];

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
 * Filenames the loader treats as agent-instructions, in the order they are
 * concatenated for a given directory. AGENTS.md stays first as the canonical
 * source; the rest exist so projects already maintaining tool-specific
 * instructions (CLAUDE.md, GEMINI.md, DEEPSEEK.md, COPILOT.md) get auto-loaded
 * without duplicating content into AGENTS.md.
 *
 * AGENTS.override.md remains a wholesale replacement that short-circuits the
 * rest of the per-directory loop.
 */
const INSTRUCTION_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "DEEPSEEK.md",
  "COPILOT.md",
  "CURSOR.md",
] as const;

function readSegmentWithHeader(dir: string, filename: string, label?: string): string | null {
  const text = readNonEmptyFile(path.join(dir, filename));
  if (!text) return null;
  if (filename === "AGENTS.md") return text; // keep AGENTS.md unannotated for backcompat
  return `<!-- ${label ?? filename} -->\n${text}`;
}

/**
 * Root of the muonroi home.
 *
 * Priority: MUONROI_CLI_HOME env → os.homedir()/.muonroi-cli — the same
 * `muonroiHome()` convention already used by src/storage/config.ts,
 * src/usage/ledger.ts, src/chat/channel-manager.ts et al.
 *
 * Resolved LAZILY on every call, never as a module-level `const`: a const is
 * evaluated once at import, so a test importing this module normally could
 * never redirect it (`src/lsp/npm-cache.ts:20-28` records what that cost).
 * Reading the env var per call is what lets the suite-wide pin in
 * `src/__test-stubs__/vitest-setup.ts` reach this loader, instead of it reading
 * the developer's real `~/.muonroi-cli/AGENTS.md` into every test's prompt.
 */
function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function loadAgentsSegments(canonicalCwd: string): string[] {
  const segments: string[] = [];

  const homeDir = muonroiHome();
  for (const fname of INSTRUCTION_FILENAMES) {
    const seg = readSegmentWithHeader(homeDir, fname, `~/.muonroi-cli/${fname}`);
    if (seg) segments.push(seg);
  }

  const root = findGitRoot(canonicalCwd) ?? canonicalCwd;

  // Parity fix (G4): see `ancestorDirsAboveGitRoot`'s doc comment. Loaded
  // BEFORE the git-root-down loop so priority mirrors distance from the
  // project: most general (closest to $HOME) first, most specific
  // (the project's own root and cwd) last — same ordering logic as the
  // muonroi-home segment above already using.
  const home = os.homedir();
  let _ancestorBytesLoaded = 0;
  ancestorLoop: for (const dir of ancestorDirsAboveGitRoot(home, root)) {
    for (const fname of INSTRUCTION_FILENAMES) {
      const rel = path.relative(home, dir);
      const label = rel === "" ? path.join("~", fname) : path.join("~", rel, fname);
      const seg = readSegmentWithHeader(dir, fname, label);
      if (!seg) continue;
      const segBytes = Buffer.byteLength(seg, "utf-8");
      if (_ancestorBytesLoaded + segBytes > MAX_ANCESTOR_INSTRUCTIONS_BYTES) break ancestorLoop;
      segments.push(seg);
      _ancestorBytesLoaded += segBytes;
    }
  }

  for (const dir of directoryChain(root, canonicalCwd)) {
    const overridePath = path.join(dir, "AGENTS.override.md");
    if (fs.existsSync(overridePath)) {
      const text = readNonEmptyFile(overridePath);
      if (text) segments.push(text);
      continue;
    }
    for (const fname of INSTRUCTION_FILENAMES) {
      const rel = path.relative(canonicalCwd, dir);
      const label = rel === "" ? fname : path.join(rel, fname);
      const seg = readSegmentWithHeader(dir, fname, label);
      if (seg) segments.push(seg);
    }
  }

  return segments;
}

export function loadCustomInstructions(cwd: string): string | null {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }

  // Check cache first
  const now = Date.now();
  const cached = _instructionsCache.get(canonical);
  if (cached && now - cached.cachedAt < INSTRUCTIONS_CACHE_TTL_MS) {
    // Still fire hook on first call even when returning cached content
    if (cached.content !== null && !instructionsHookFiredFor.has(canonical)) {
      instructionsHookFiredFor.add(canonical);
      const hookInput: InstructionsLoadedHookInput = {
        hook_event_name: "InstructionsLoaded",
        files_loaded: cached.content.split("\n\n").length,
        cwd: canonical,
      };
      executeEventHooks(hookInput, canonical).catch(() => {});
    }
    return cached.content;
  }

  const parts: string[] = [...loadAgentsSegments(canonical)];

  if (parts.length === 0) {
    _instructionsCache.set(canonical, { content: null, hash: "", cachedAt: now });
    return null;
  }

  if (!instructionsHookFiredFor.has(canonical)) {
    instructionsHookFiredFor.add(canonical);
    const hookInput: InstructionsLoadedHookInput = {
      hook_event_name: "InstructionsLoaded",
      files_loaded: parts.length,
      cwd: canonical,
    };
    executeEventHooks(hookInput, canonical).catch(() => {});
  }

  const content = parts.join("\n\n");
  _instructionsCache.set(canonical, { content, hash: computeHash(parts), cachedAt: now });
  return content;
}
