/**
 * src/product-loop/plan-target-paths.ts
 *
 * Shared target-path extraction for sprint plan text. Leaf module — imports
 * nothing from `sprint-runner.ts` or `sprint-plan-artifact.ts` — so both can
 * import from here with no circular dependency. It DOES import from
 * `language-registry.ts` (also a leaf module with no dependency on this file
 * or on `sprint-runner.ts`/`sprint-plan-artifact.ts`), so no cycle is created.
 *
 * `extractPlanTargetPaths` originally lived in `sprint-runner.ts` (moved here
 * verbatim, then re-exported from there so every existing import kept
 * working). Its ORIGINAL regex treated any short dotted last segment as a
 * file extension (`\.[a-z]{1,5}`), which meant a dotted DIRECTORY name — e.g.
 * a .NET test project `src/Acme.Widgets.Tests` — was misclassified as a FILE
 * (`Tests` matches `[a-z]{1,5}` case-insensitively) purely because it happened
 * to be short. That put it in `targetFiles` and excluded it from
 * `extractPlanTargetDirs` (which excludes anything already a file), so a
 * consumer asking "does this file exist" was really asking about a directory.
 *
 * The fix classifies by a KNOWN extension (`KNOWN_FILE_EXTENSIONS`, sourced
 * from `language-registry.ts`'s `CODE_EXTENSIONS` plus a small explicit list
 * of common non-code file types a plan names) instead of "any short dotted
 * suffix". Same prefix anchoring, same overall shape — only the trailing
 * extension check gained a whitelist instead of a bare length cap.
 *
 * `extractPlanTargetDirs` is new (S3a follow-up): a plan step routinely names
 * a bare directory ("src/Acme.Widgets") with no dotted extension, which
 * `extractPlanTargetPaths` — by design — never matches (it requires one). This
 * recovers those as directory targets without touching the file extractor.
 */

import { CODE_EXTENSIONS } from "./language-registry.js";

/**
 * Extensions for common non-code file types a plan step routinely names
 * (docs, CI/build config, project/solution manifests, shell scripts) that
 * are not "source languages" and so are not in `CODE_EXTENSIONS`. Kept as an
 * explicit, small list rather than folded into `language-registry.ts` — these
 * are config/doc surface, not a programming language.
 */
const NON_CODE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".props",
  ".targets",
  ".config",
  ".editorconfig",
  ".sln",
  ".slnx",
  ".csproj",
  ".fsproj",
  ".vbproj",
  ".sh",
  ".ps1",
]);

/**
 * Every extension that marks a plan-named token's last dotted segment as a
 * FILE rather than a directory candidate. Union of every known source-code
 * extension (`language-registry.ts`) plus the common non-code file types
 * above.
 */
const KNOWN_FILE_EXTENSIONS: ReadonlySet<string> = new Set([...CODE_EXTENSIONS, ...NON_CODE_FILE_EXTENSIONS]);

/**
 * Extract repo-relative target FILE paths a sprint plan names (src/…, packages/…,
 * tests/…). Deduped, capped. Never throws.
 *
 * Same prefix anchoring and bounds as the original regex; the trailing
 * extension is now validated against `KNOWN_FILE_EXTENSIONS` instead of
 * accepted on length alone (see the module doc for why).
 */
export function extractPlanTargetPaths(planSynthesis: string, cap = 40): string[] {
  try {
    const tokens = new Set<string>();
    const re = /\b((?:src|packages|tests|scripts|lib|app|apps)\/[\w./@-]+\.([A-Za-z0-9]{1,20}))\b/gi;
    let m: RegExpExecArray | null = re.exec(planSynthesis);
    while (m !== null) {
      const ext = `.${m[2]!.toLowerCase()}`;
      if (KNOWN_FILE_EXTENSIONS.has(ext)) {
        tokens.add(m[1]!.replace(/\\/g, "/"));
        if (tokens.size >= cap) break;
      }
      m = re.exec(planSynthesis);
    }
    return [...tokens];
  } catch (err) {
    console.error(`[sprint-runner] extractPlanTargetPaths failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Extract repo-relative target DIRECTORY paths a sprint plan step names — same
 * known top-level prefixes as `extractPlanTargetPaths`, but no dotted extension
 * required. Deduped, capped, excludes anything already captured as a FILE
 * (pass that list in as `excludeFiles`), strips trailing punctuation a sentence
 * boundary can glue onto the match (the permissive character class allows "."
 * and "/", so "src/Acme.Widgets." at a sentence's end would otherwise keep the
 * trailing period). Never throws.
 *
 * Uses a negative lookbehind instead of `extractPlanTargetPaths`'s `\b` at the
 * START of the match — `\b` alone treats the "/" in a URL path
 * ("https://host.com/src/foo") as a valid boundary and would false-positive on
 * it; `(?<![\w/])` additionally rejects a "/" immediately before the prefix.
 */
export function extractPlanTargetDirs(text: string, excludeFiles: readonly string[] = [], cap = 40): string[] {
  try {
    const exclude = new Set(excludeFiles);
    const dirs = new Set<string>();
    const re = /(?<![\w/])((?:src|packages|tests|scripts|lib|app|apps)\/[\w./@-]+)/gi;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      const raw = m[1]!.replace(/\\/g, "/");
      // Strip trailing "." / "/" glued on by prose punctuation or a redundant
      // trailing slash — not part of the real path.
      const candidate = raw.replace(/[./]+$/, "");
      // A candidate that stripped down to just the bare prefix word (no "/"
      // left) named no real path — e.g. a degenerate "src/." match.
      if (candidate?.includes("/") && !exclude.has(candidate)) {
        dirs.add(candidate);
        if (dirs.size >= cap) break;
      }
      m = re.exec(text);
    }
    return [...dirs];
  } catch (err) {
    console.error(`[plan-target-paths] extractPlanTargetDirs failed: ${(err as Error).message}`);
    return [];
  }
}
