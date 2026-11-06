/**
 * src/ee/noise-reason.ts
 *
 * Host-derived noise reason for ee_feedback. The noise-reason decision tree
 * (stale_rule → wrong_repo → wrong_language → wrong_task) used to live in prose
 * the model had to apply, and the choice decides whether the brain PRESERVES a
 * hint (wrong_repo / wrong_language narrow its scope) or eventually DELETES it
 * (wrong_task). The two scope reasons are facts the host can compute: the
 * hint's stored scope vs this session's project and language. The model only
 * says followed / ignored / noise (plus stale_rule, which only it can judge).
 *
 * Pure: callers supply the hint scope and the session identity.
 */

import type { NoiseReason } from "./search.js";
import type { EEHintStoredScope } from "./types.js";

export type { NoiseReason };

export interface HintScope {
  project?: string;
  /** Languages the hint is scoped to; empty/undefined = any. */
  langs?: string[];
}

export interface SessionIdentity {
  project?: string;
  lang?: string | null;
}

export interface DerivedNoiseReason {
  reason?: NoiseReason;
  /** True when the host picked or replaced the reason. */
  derived: boolean;
  /** Evidence for a derived reason ("hint project a ≠ session project b"). */
  basis?: string;
}

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  node: "javascript",
  cs: "csharp",
  "c#": "csharp",
  csharp: "csharp",
  dotnet: "csharp",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  java: "java",
  kotlin: "kotlin",
  kt: "kotlin",
};

const ANY_LANG = new Set(["any", "*", "all", "none", ""]);

export function normalizeLang(lang: string): string {
  const key = lang.trim().toLowerCase();
  return LANG_ALIASES[key] ?? key;
}

function normalizeProject(project: string): string {
  return project.trim().toLowerCase();
}

/** Read a hint's project / language scope from a recall entry's stored fields. */
export function hintScopeOf(entry: {
  projectSlug?: string | null;
  scope?: EEHintStoredScope | null;
}): HintScope | undefined {
  const project =
    (typeof entry.projectSlug === "string" && entry.projectSlug.trim()) ||
    (typeof entry.scope?.project_slug === "string" && entry.scope.project_slug.trim()) ||
    undefined;
  const rawLang = entry.scope?.lang;
  const langs = (Array.isArray(rawLang) ? rawLang : typeof rawLang === "string" ? [rawLang] : [])
    .filter((l): l is string => typeof l === "string" && !ANY_LANG.has(l.trim().toLowerCase()))
    .map(normalizeLang);
  if (!project && !langs.length) return undefined;
  return { ...(project ? { project } : {}), ...(langs.length ? { langs } : {}) };
}

/**
 * Resolve the reason sent with a noise verdict. The host replaces a missing
 * reason or a `wrong_task` (the deleting last resort) with `wrong_repo` /
 * `wrong_language` when the hint's stored scope contradicts this session's
 * project / language — the entry then survives for its own contexts. An
 * explicit stale_rule / wrong_repo / wrong_language is kept as given.
 */
export function deriveNoiseReason(
  requested: NoiseReason | undefined,
  hint: HintScope | undefined,
  session: SessionIdentity,
): DerivedNoiseReason {
  if (requested && requested !== "wrong_task") return { reason: requested, derived: false };
  if (hint?.project && session.project && normalizeProject(hint.project) !== normalizeProject(session.project))
    return {
      reason: "wrong_repo",
      derived: true,
      basis: `hint project ${hint.project} ≠ session project ${session.project}`,
    };
  if (hint?.langs?.length && session.lang) {
    const lang = normalizeLang(session.lang);
    if (!hint.langs.map(normalizeLang).includes(lang))
      return {
        reason: "wrong_language",
        derived: true,
        basis: `hint language ${hint.langs.join("/")} ≠ session language ${lang}`,
      };
  }
  return { reason: requested, derived: false };
}
