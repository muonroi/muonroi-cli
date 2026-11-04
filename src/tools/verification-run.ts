import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolResult } from "../types/index.js";
import { killProcessTree } from "../utils/process-tree.js";

export const VERIFICATION_RUNNERS = ["auto", "vitest", "jest", "mocha", "node", "pytest"] as const;
export type VerificationRunner = (typeof VERIFICATION_RUNNERS)[number];

/** Bounded local tests, separate from arbitrary shell execution and code edits. */
export async function runVerificationTests(
  cwd: string,
  files: string[],
  timeoutMs = 60000,
  signal?: AbortSignal,
  requestedRunner: VerificationRunner = "auto",
): Promise<ToolResult> {
  if (!(VERIFICATION_RUNNERS as readonly string[]).includes(requestedRunner))
    return { success: false, output: `Unknown runner. Choose ${VERIFICATION_RUNNERS.join(", ")}.` };
  if (!Array.isArray(files) || files.length < 1 || files.length > 100) {
    return {
      success: false,
      output: "Supply 1-100 explicit test files. No shell command or whole-suite expansion is accepted.",
    };
  }
  const root = realpathSync(cwd);
  const pythonTests = files.every(
    (file) => typeof file === "string" && /(?:^|[/\\])(?:test_[^/\\]+|[^/\\]+_test)\.py$/.test(file),
  );
  const targets: string[] = [];
  for (const file of files) {
    if (
      typeof file !== "string" ||
      file.startsWith("-") ||
      /[\0\r\n*?[\]{}]/.test(file) ||
      !(pythonTests ? /\.py$/ : /\.(?:test|spec)\.[cm]?[jt]sx?$/).test(file)
    ) {
      return {
        success: false,
        output: `Invalid test file: ${String(file)}. Options, directories and shell commands are not accepted.`,
      };
    }
    const target = resolve(root, file);
    if (!existsSync(target) || !statSync(target).isFile())
      return { success: false, output: `Test file not found: ${file}` };
    const rel = relative(root, realpathSync(target));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
      return { success: false, output: `Test file is outside the requested workspace: ${file}` };
    }
    targets.push(realpathSync(target));
  }
  const local = {
    vitest: join(root, "node_modules", "vitest", "vitest.mjs"),
    jest: join(root, "node_modules", "jest", "bin", "jest.js"),
    mocha: join(root, "node_modules", "mocha", "bin", "mocha.js"),
  };
  let selected: Exclude<VerificationRunner, "auto">;
  if (requestedRunner === "auto") {
    const installed = (Object.keys(local) as (keyof typeof local)[]).filter((name) => existsSync(local[name]));
    if (pythonTests) selected = "pytest";
    else if (installed.length === 1) selected = installed[0]!;
    else
      return {
        success: false,
        output: installed.length
          ? `Multiple local runners: ${installed.join(", ")}. Select runner explicitly; no tests were launched.`
          : "No supported local runner installed. Select runner=node for JavaScript node:test files, or use the repo workflow. No dependencies were downloaded.",
      };
  } else selected = requestedRunner;
  if ((selected === "pytest") !== pythonTests)
    return {
      success: false,
      output:
        "Runner/file mismatch. Use explicit Python test_*.py/*_test.py files for pytest or JavaScript/TypeScript .test/.spec files for JS runners; do not mix languages.",
    };
  if (selected === "node" && files.some((file) => !/\.[cm]?js$/.test(file)))
    return {
      success: false,
      output: "runner=node accepts JavaScript node:test files only; select the installed TypeScript runner for TS/TSX.",
    };
  let executable = process.versions.bun ? "node" : process.execPath;
  let args: string[];
  if (selected === "pytest") {
    executable = join(root, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    if (!existsSync(executable))
      return {
        success: false,
        output:
          "No workspace .venv virtualenv interpreter. No dependencies were downloaded; use the repo workflow for other Python environments.",
      };
    args = ["-m", "pytest", "-v", "--", ...targets];
  } else if (selected === "node") args = ["--test", ...targets];
  else {
    if (!existsSync(local[selected]))
      return { success: false, output: `No local ${selected} installation. No dependencies were downloaded.` };
    args =
      selected === "vitest"
        ? [local[selected], "run", ...targets, "--reporter=verbose"]
        : selected === "jest"
          ? [local[selected], "--runTestsByPath", "--runInBand", ...targets]
          : [local[selected], "--reporter", "spec", "--", ...targets];
  }
  if (signal?.aborted) return { success: false, output: "Verification cancelled before launch." };
  const budget = Math.max(100, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 60000, 300000));
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn(executable, args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let interrupted = "";
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (data: Buffer) => {
      output = (output + data.toString("utf8")).slice(-48000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      signal?.removeEventListener("abort", abort);
      resolveResult({
        success: code === 0 && !interrupted && !error,
        output: `Local verification runner=${selected}: ${JSON.stringify(executable)} ${JSON.stringify(args)}\ncwd=${root}\nexit=${code} elapsedMs=${Date.now() - started}${interrupted ? ` ${interrupted}` : ""}${error ? ` error=${error}` : ""}\n${output}`,
      });
    };
    const stop = (reason: string) => {
      interrupted = reason;
      killProcessTree(child, "SIGKILL", "verification-run");
      // Windows tree termination is asynchronous. Prefer the actual close event
      // so callers do not race still-open fixture handles, with a bounded fallback.
      terminationTimer = setTimeout(() => finish(null), 1500);
      terminationTimer.unref();
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop(`timed out after ${budget}ms`), budget);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (err) => {
      console.error(`[verification-run] Failed to start local runner: ${err.message}`);
      finish(null, err.message);
    });
    child.once("close", (code) => finish(code));
  });
}
