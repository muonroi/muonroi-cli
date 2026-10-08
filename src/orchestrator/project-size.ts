/**
 * src/orchestrator/project-size.ts
 *
 * "How much source code is in this working tree", as a ROUTING INPUT.
 *
 * NOT cosmetic. The bucket travels `Orchestrator._estimateProjectSize()` →
 * `message-processor.ts` (`projectSize: deps.estimateProjectSize()`) →
 * `decide(...)`'s `buildRouteContext` (`router/decide.ts`) → the EE router's
 * classify prompt as `project=<size>`, so it participates in model/tier selection
 * on every turn.
 *
 * ## The defect this module was extracted to fix
 *
 * The predicate was an inline `/\.(ts|tsx|js|jsx|py|go|rs)$/` in
 * `orchestrator.ts` — no `.cs`, no `.java`, no `.fs`/`.vb`. Measured on this
 * machine: `tcis-libraries/src` holds 1717 `.cs` files and that regex matched
 * exactly ONE, so a very large C# solution was reported `small` (the threshold is
 * `<= 20`) and the router was biased toward lighter handling on precisely the
 * repos being worked on. `muonroi-building-block/src` (2058 `.cs`) was identical.
 *
 * It is the third instance of one root cause. `language-registry.ts` is THE single
 * source of truth for "what does a source file look like", built expressly to end
 * this after `repo-audit.ts` lacked `.cs` and reported "Source files: 1" for a
 * 506-file C# repository. This was one of the two consumers its migration missed.
 * Asking `isCodeFile()` means a language added to `SOURCE_LANGUAGES` reaches the
 * router with no edit here.
 *
 * ## Why BUILD_OUTPUT_DIRS, not just node_modules/.git
 *
 * A .NET build regenerates `AssemblyInfo` / `GlobalUsings` `.cs` files under
 * `obj/`, and they are numerous: on `tcis-libraries/src` the same walk counts
 * 1718 code files including `obj/` and 947 excluding it — 771 generated files,
 * 45% of the total. Counting build output would size a repo by how recently it
 * was compiled. `bin` is deliberately NOT in that set (see the registry): it
 * holds no `.cs` there and is a legitimate source directory in Node and Python.
 *
 * ## Size counts source LANGUAGES only
 *
 * Project/solution manifests (`.sln`, `.csproj`, `.props`, `.targets`) are
 * legitimate EVIDENCE for a registration criterion — `reality-anchor.ts` accepts
 * them, from the same registry-plus-local-addition shape — but they are structure,
 * not volume. `tcis-libraries/src` carries 436 of them, enough on their own to
 * push a repo containing no logic at all past both thresholds. One source of truth
 * for the language set; the per-caller addition belongs only where it is true.
 */

import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_OUTPUT_DIRS, isCodeFile } from "../product-loop/language-registry.js";

export type ProjectSize = "small" | "medium" | "large";

/**
 * Bucket boundaries, inclusive upper bounds. Unchanged from the original inline
 * implementation — only the PREDICATE was wrong, not the thresholds.
 */
export const PROJECT_SIZE_SMALL_MAX = 20;
export const PROJECT_SIZE_MEDIUM_MAX = 100;

/**
 * Stop walking once the count can no longer change the bucket. `> MEDIUM_MAX`
 * already means `large`, so the extra headroom only bounds the walk on a huge
 * tree; it never alters the answer.
 */
const COUNT_CAP = 200;

/** Map a code-file count onto a bucket. Exported so a caller can reason about boundaries. */
export function bucketForCodeFileCount(count: number): ProjectSize {
  if (count <= PROJECT_SIZE_SMALL_MAX) return "small";
  if (count <= PROJECT_SIZE_MEDIUM_MAX) return "medium";
  return "large";
}

/**
 * Count recognised source files under `<cwd>/src` and bucket them.
 *
 * Returns null when there is no `src/` directory — an honest "no signal", which
 * `buildRouteContext` then omits rather than guessing. Throws only what
 * `readdirSync` throws; the caller in `orchestrator.ts` logs and degrades to null.
 */
export function estimateProjectSizeAt(cwd: string): ProjectSize | null {
  const srcDir = join(cwd, "src");
  let entries: Dirent[];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    // ENOENT/ENOTDIR is a legitimate state, not an error: there is no `src/`, so
    // there is nothing to size and null is the honest answer. It is deliberately
    // NOT logged — every greenfield cwd would emit a line on every turn.
    //
    // Anything else (EACCES, EMFILE, …) is a real failure and is RETHROWN rather
    // than folded into the same null, so it reaches `orchestrator.ts`'s handler
    // and gets logged there. Swallowing it here would make "no src/" and "src/ is
    // unreadable" indistinguishable, which is the No Silent Catch failure mode.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }

  let count = 0;
  const walk = (dir: string, dirEntries: Dirent[]): void => {
    for (const entry of dirEntries) {
      if (entry.name === ".git" || BUILD_OUTPUT_DIRS.has(entry.name.toLowerCase())) continue;
      if (entry.isDirectory()) {
        const child = join(dir, entry.name);
        walk(child, readdirSync(child, { withFileTypes: true }));
      } else if (isCodeFile(entry.name)) {
        count++;
      }
      if (count > COUNT_CAP) return;
    }
  };
  walk(srcDir, entries);

  return bucketForCodeFileCount(count);
}
