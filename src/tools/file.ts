import { createTwoFilesPatch } from "diff";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { summarizeDiagnostics, syncFileWithLsp } from "../lsp/runtime";
import type { LspDiagnosticFile } from "../lsp/types";
import type { FileTracker } from "./file-tracker.js";

export interface FileDiff {
  filePath: string;
  additions: number;
  removals: number;
  patch: string;
  isNew: boolean;
}

export interface FileResult {
  success: boolean;
  output: string;
  diff?: FileDiff;
  lspDiagnostics?: LspDiagnosticFile[];
}

function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
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

export async function writeFile(
  filePath: string,
  content: string,
  cwd: string,
  tracker?: FileTracker,
): Promise<FileResult> {
  try {
    const full = resolvePath(filePath, cwd);
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

    const diff = computeDiff(filePath, before, content);
    const verb = before === "" ? "Created" : "Updated";
    const lspDiagnostics = await syncFileWithLsp(cwd, full, content, true, true).catch(() => [] as LspDiagnosticFile[]);
    const lspSummary = summarizeDiagnostics(lspDiagnostics);
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
): Promise<FileResult> {
  try {
    const full = resolvePath(filePath, cwd);
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

    const count = before.split(oldString).length - 1;

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

    const after = before.replace(oldString, newString);
    writeFileSync(full, after, "utf-8");

    // Refresh tracker so back-to-back edits keep working.
    tracker?.markRead(full, after, mtimeMsOf(full));

    const diff = computeDiff(filePath, before, after);
    const lspDiagnostics = await syncFileWithLsp(cwd, full, after, true, true).catch(() => [] as LspDiagnosticFile[]);
    const lspSummary = summarizeDiagnostics(lspDiagnostics);
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
