/**
 * src/product-loop/plan-target-paths.ts
 *
 * Shared target-path extraction for sprint plan text. Leaf module — imports
 * nothing from `sprint-runner.ts` or `sprint-plan-artifact.ts` — so both can
 * import from here with no circular dependency.
 *
 * `extractPlanTargetPaths` is moved here VERBATIM from `sprint-runner.ts`
 * (originally ~line 1218, the same regex/cap/dedup/error-handling); that file
 * now re-exports it so every existing import (`from "../sprint-runner.js"`)
 * keeps working unchanged, and behaviour is byte-identical.
 *
 * `extractPlanTargetDirs` is new (S3a follow-up): a plan step routinely names
 * a bare directory ("src/Acme.Widgets") with no dotted extension, which
 * `extractPlanTargetPaths` — by design — never matches (it requires one). This
 * recovers those as directory targets without touching the file extractor.
 */

/**
 * Extract repo-relative target FILE paths a sprint plan names (src/…, packages/…,
 * tests/…). Deduped, capped. Never throws.
 *
 * Copied VERBATIM (same regex literal, same variable names, same log prefix)
 * from its pre-move form in sprint-runner.ts — moving the code must not change
 * its behaviour or its diagnostic output.
 */
export function extractPlanTargetPaths(planSynthesis: string, cap = 40): string[] {
  try {
    const tokens = new Set<string>();
    const re = /\b((?:src|packages|tests|scripts|lib|app|apps)\/[\w./@-]+\.[a-z]{1,5})\b/gi;
    let m: RegExpExecArray | null = re.exec(planSynthesis);
    while (m !== null) {
      tokens.add(m[1]!.replace(/\\/g, "/"));
      if (tokens.size >= cap) break;
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
