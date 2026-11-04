import { createTwoFilesPatch } from "diff";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { LSP_DETAIL_MAX_ACK } from "../lsp/manager";
import { describeDiagnostics, syncFileWithLsp } from "../lsp/runtime";
import type { LspDiagnosticFile } from "../lsp/types";
import type { FileTracker } from "./file-tracker.js";
import type { WorkerWriteScope } from "./worker-write-scope.js";
import { blockWriteIfOutOfScope, normalizeMsysDrivePath } from "./write-scope.js";

export interface FileDiff {
  filePath: string;
  additions: number;
  removals: number;
  patch: string;
  isNew: boolean;
}

export interface FileResult {
  writeScopeVersion?: number;
  success: boolean;
  output: string;
  diff?: FileDiff;
  lspDiagnostics?: LspDiagnosticFile[];
  preview?: boolean;
}

/**
 * The one boundary every file tool routes its target through.
 *
 * The MSYS normalisation happens HERE, before containment, so `write-scope.ts`
 * and this module cannot disagree about what a path means. `write-scope.ts` owns
 * the function (it already owns `canonicalize`, i.e. "what does this path really
 * mean") and applies it inside `canonicalize` too — the same one-owner shape the
 * two guards already use for `getCommitRunRoot()`.
 *
 * Without it, `isAbsolute("/d/x")` is true on win32 and the path passed through
 * UNCHANGED: never joined to cwd, never corrected, and `path.resolve` downstream
 * prefixed the current drive (`D:\d\x`, which does not exist).
 */
function resolvePath(filePath: string, cwd: string): string {
  const spelled = normalizeMsysDrivePath(filePath);
  return isAbsolute(spelled) ? spelled : resolve(cwd, spelled);
}

function computeDiff(filePath: string, before: string, after: string): FileDiff {
  const patch = createTwoFilesPatch(filePath, filePath, before, after, "", "", {
    context: 3,
  });

  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { filePath, additions, removals, patch, isNew: before === "" };
}

function mtimeMsOf(absolutePath: string): number {
  try {
    return statSync(absolutePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function readFile(
  filePath: string,
  cwd: string,
  startLine?: number,
  endLine?: number,
  tracker?: FileTracker,
): FileResult {
  try {
    const full = resolvePath(filePath, cwd);
    if (!existsSync(full)) {
      return { success: false, output: `File not found: ${filePath}` };
    }
    const content = readFileSync(full, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    const start = Math.max(0, (startLine ?? 1) - 1);
    const end = Math.min(totalLines, endLine ?? totalLines);
    const slice = lines.slice(start, end);

    // Track FULL content (not just the slice) so partial reads still satisfy
    // the read-before-write guard against the on-disk file as a whole.
    tracker?.markRead(full, content, mtimeMsOf(full));

    const numbered = slice.map((line, i) => `${start + i + 1} | ${line}`).join("\n");
    const header = `[${filePath}: lines ${start + 1}-${end} of ${totalLines}]`;
    return { success: true, output: `${header}\n${numbered}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to read file: ${msg}` };
  }
}

/**
 * O1 — read MULTIPLE files in ONE tool call. This is the lossless batching
 * lever: a single `read_file` carrying N paths is ONE tool_call, so it is
 * NEVER split by `splitParallelToolCalls` (which only reshapes assistant turns
 * with >1 tool_calls) — the ≥50% fresh-input cut holds on every provider,
 * including the kimi/glm/deepseek-go sequential-split cohort.
 *
 * Quality gate (council regression vector "partial multi-path reads"): each
 * file is capped INDEPENDENTLY at `perFileCap` with an EXPLICIT truncation
 * marker, so no file is ever silently dropped by a downstream head/tail
 * whole-result cap. With `perFileCap = floor(MAX_TOOL_OUTPUT_CHARS / n)` the
 * concatenated total stays under the registry cap, making the outer
 * `truncateOutput` a no-op — every requested file is represented.
 */
export type FileReadRequest = string | { file_path: string; start_line?: number; end_line?: number };

export function readFiles(
  filePaths: FileReadRequest[],
  cwd: string,
  tracker?: FileTracker,
  perFileCap?: number,
): FileResult {
  if (filePaths.length === 0) {
    return { success: false, output: "read_file: no paths provided (file_path or file_paths required)" };
  }
  const parts: string[] = [];
  for (const request of filePaths) {
    if (!request || (typeof request !== "string" && typeof request.file_path !== "string"))
      return {
        success: false,
        output: "Invalid file request: supply a path string or {file_path,start_line,end_line}.",
      };
    const filePath = typeof request === "string" ? request : request.file_path;
    const start = typeof request === "string" ? undefined : request.start_line;
    const end = typeof request === "string" ? undefined : request.end_line;
    if (
      !filePath ||
      (start !== undefined && (!Number.isInteger(start) || start < 1)) ||
      (end !== undefined && (!Number.isInteger(end) || end < (start ?? 1)))
    ) {
      return { success: false, output: "Invalid file range: use a path and positive inclusive start_line/end_line." };
    }
    const r = readFile(filePath, cwd, start, end, tracker);
    let out = r.output;
    if (perFileCap && perFileCap > 0 && out.length > perFileCap) {
      // Head-truncate this ONE file with an explicit, self-describing marker.
      // Never silently elide: the model is told this file was cut and how to
      // get the rest (single read + line range).
      const cut = Math.max(0, out.lastIndexOf("\n", perFileCap));
      const kept = out.slice(0, cut);
      const range = out.match(/lines (\d+)-(\d+) of/);
      const nextLine = Number(range?.[1] ?? start ?? 1) + Math.max(0, kept.split("\n").length - 1);
      out = `${kept}\n... [${out.length - cut} chars of ${filePath} truncated in this read; Unreturned lines ${nextLine}-${range?.[2] ?? end ?? "end"}. Read that range to continue; use grep for excerpts if one line exceeds the budget.] ...`;
    }
    parts.push(out);
  }
  return { success: true, output: parts.join("\n\n") };
}

export async function writeFile(
  filePath: string,
  content: string,
  cwd: string,
  tracker?: FileTracker,
  workerScope?: WorkerWriteScope,
): Promise<FileResult> {
  try {
    const full = resolvePath(filePath, cwd);
    const workerBlock = workerScope?.refusal(filePath, cwd);
    if (workerBlock) return { success: false, output: workerBlock };
    // Containment BEFORE anything is created: `full` is the post-resolution
    // target, so this one check covers both a relative path riding a drifted
    // tool cwd and an absolute path that bypassed the cwd entirely.
    const scopeBlock = blockWriteIfOutOfScope(filePath, full);
    if (scopeBlock) return { success: false, output: scopeBlock };
    const exists = existsSync(full);
    const before = exists ? readFileSync(full, "utf-8") : "";

    // Safety: existing files must have been read first AND unchanged on disk
    // since that read. New files (no prior content) skip the guard.
    if (exists && tracker) {
      const violation = tracker.checkBeforeWrite(full, before);
      if (violation) {
        return { success: false, output: violation };
      }
    }

    const dir = dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, content, "utf-8");

    // Refresh tracker so subsequent edits in the same session don't refuse.
    tracker?.markRead(full, content, mtimeMsOf(full));
    tracker?.markWritten(full);

    const diff = computeDiff(filePath, before, content);
    const verb = before === "" ? "Created" : "Updated";
    const lspDiagnostics = workerScope
      ? []
      : await syncFileWithLsp(cwd, full, content, true, true).catch(() => [] as LspDiagnosticFile[]);
    // Name the diagnostics, don't just count them: the measured blind-edit loop
    // (/ideal run muc2joffe506) STARTED at an edit ack that said only
    // "6 LSP issues · 6 errors". Errors sort first, warnings are labelled.
    const lspSummary = describeDiagnostics(lspDiagnostics, { cwd, max: LSP_DETAIL_MAX_ACK });
    return {
      success: true,
      output: `${verb} ${filePath} (+${diff.additions} -${diff.removals})${lspSummary ? `\n${lspSummary}` : ""}`,
      diff,
      lspDiagnostics,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to write file: ${msg}` };
  }
}

export async function editFile(
  filePath: string,
  oldString: string,
  newString: string,
  cwd: string,
  tracker?: FileTracker,
  dryRun = false,
  workerScope?: WorkerWriteScope,
): Promise<FileResult> {
  try {
    const full = resolvePath(filePath, cwd);
    const workerBlock = workerScope?.refusal(filePath, cwd);
    if (workerBlock) return { success: false, output: workerBlock };
    // Containment first — refuse before disclosing whether the out-of-scope file
    // exists, and before any write. Covers relative-path cwd drift and absolute
    // paths alike (both have already collapsed into `full`).
    const scopeBlock = blockWriteIfOutOfScope(filePath, full);
    if (scopeBlock) return { success: false, output: scopeBlock };
    if (!existsSync(full)) {
      return { success: false, output: `File not found: ${filePath}` };
    }
    const before = readFileSync(full, "utf-8");

    // Safety: edit always requires a prior read of the current on-disk version.
    if (tracker) {
      const violation = tracker.checkBeforeWrite(full, before);
      if (violation) {
        return { success: false, output: violation };
      }
    }

    // Line-ending tolerant matching. LLMs emit old_string with `\n` line
    // breaks, but Windows-authored files (common in Angular/.NET repos) are
    // stored with `\r\n`. An exact substring search then never finds any
    // multi-line old_string, so every edit beyond a single line fails (live:
    // storyflow_ui A/B — both models failed 8-9/10 edits on CRLF templates).
    // First try the verbatim match; if that misses, re-match with both sides
    // EOL-normalized and rebuild old/new with the FILE's dominant EOL so the
    // replace lands on `before` and the file's line endings are preserved.
    let searchString = oldString;
    let replaceString = newString;
    let count = before.split(searchString).length - 1;
    if (count === 0 && (before.includes("\r\n") || /\r\n/.test(oldString))) {
      const fileEol = before.includes("\r\n") ? "\r\n" : "\n";
      const toFileEol = (s: string): string => s.replace(/\r\n/g, "\n").replace(/\n/g, fileEol);
      const normalizedOld = toFileEol(oldString);
      const normalizedCount = before.split(normalizedOld).length - 1;
      if (normalizedCount >= 1) {
        searchString = normalizedOld;
        replaceString = toFileEol(newString);
        count = normalizedCount;
      }
    }

    if (count === 0) {
      return {
        success: false,
        output: `old_string not found in ${filePath}. Re-read the file with read_file before retrying to get the current content.`,
      };
    }
    if (count > 1) {
      return {
        success: false,
        output: `old_string is not unique in ${filePath} (${count} occurrences). Include more surrounding context to make it unique.`,
      };
    }

    const after = before.replace(searchString, replaceString);
    const diff = computeDiff(filePath, before, after);
    if (dryRun)
      return {
        success: true,
        preview: true,
        diff,
        output: `Preview only: ${filePath} (+${diff.additions} -${diff.removals}); no file was changed. Revalidated when applied.`,
      };
    writeFileSync(full, after, "utf-8");

    // Refresh tracker so back-to-back edits keep working.
    tracker?.markRead(full, after, mtimeMsOf(full));
    tracker?.markWritten(full);

    const lspDiagnostics = workerScope
      ? []
      : await syncFileWithLsp(cwd, full, after, true, true).catch(() => [] as LspDiagnosticFile[]);
    const lspSummary = describeDiagnostics(lspDiagnostics, { cwd, max: LSP_DETAIL_MAX_ACK });
    return {
      success: true,
      output: `Edited ${filePath} (+${diff.additions} -${diff.removals})${lspSummary ? `\n${lspSummary}` : ""}`,
      diff,
      lspDiagnostics,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Failed to edit file: ${msg}` };
  }
}
