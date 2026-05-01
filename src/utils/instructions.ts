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

function loadAgentsSegments(canonicalCwd: string): string[] {
  const segments: string[] = [];

  const globalAgents = readNonEmptyFile(path.join(os.homedir(), ".muonroi-cli", "AGENTS.md"));
  if (globalAgents) segments.push(globalAgents);

  const root = findGitRoot(canonicalCwd) ?? canonicalCwd;
  for (const dir of directoryChain(root, canonicalCwd)) {
    const overridePath = path.join(dir, "AGENTS.override.md");
    if (fs.existsSync(overridePath)) {
      const text = readNonEmptyFile(overridePath);
      if (text) segments.push(text);
      continue;
    }
    const text = readNonEmptyFile(path.join(dir, "AGENTS.md"));
    if (text) segments.push(text);
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
