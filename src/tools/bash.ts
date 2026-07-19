import { type ChildProcess, exec, spawn } from "child_process";
import { createReadStream, createWriteStream, existsSync } from "fs";
import { mkdtemp, rm, stat, unlink } from "fs/promises";
import os from "os";
import path from "path";
import { executeEventHooks } from "../hooks/index";
import type { CwdChangedHookInput } from "../hooks/types";
import type { ToolResult } from "../types/index";
import { checkCatastrophicCommand, type SafetyBlockResult } from "../utils/permission-mode.js";
import type { SandboxMode, SandboxSettings } from "../utils/settings.js";
import { posixToNative, type ResolvedShell, resolveShell, type ShellSettings } from "../utils/shell";
import { nextBashRunId, recordBashRun, stripAnsi } from "./bash-output-cache.js";

const MAX_TAIL_BYTES = 8_192;
const MAX_BACKGROUND_PROCESSES = 8;

export interface BackgroundProcess {
  id: number;
  command: string;
  pid: number;
  cwd: string;
  startedAt: Date;
  child: ChildProcess;
  logPath: string;
  alive: boolean;
  exitCode: number | null;
}

interface BashToolOptions {
  /**
   * Accepted for backward compatibility with callers that pass sandboxMode.
   * Sandbox has been removed; this value is ignored — mode is always "off".
   * Will be repurposed when the new sandbox is implemented.
   * @deprecated
   */
  sandboxMode?: string;
  sandboxSettings?: SandboxSettings;
  shellSettings?: ShellSettings;
}

let nextBgId = 1;

export class BashTool {
  private cwd: string;
  private bgProcesses = new Map<number, BackgroundProcess>();
  private tmpDir: string | null = null;
  private shellSettings: ShellSettings;
  private resolvedShell: ResolvedShell;
  private sandboxSettings: SandboxSettings = {};

  constructor(initialCwd = process.cwd(), options: BashToolOptions = {}) {
    this.cwd = initialCwd;
    this.shellSettings = options.shellSettings ?? {};
    this.resolvedShell = resolveShell(this.shellSettings);
    this.sandboxSettings = options.sandboxSettings ?? {};
  }

  /**
   * Sandbox has been removed. Always returns "off".
   * Kept for backward compatibility with orchestrator / stream-runner callers.
   */
  getSandboxMode(): SandboxMode {
    return "off";
  }

  getSandboxSettings(): SandboxSettings {
    return this.sandboxSettings;
  }

  setSandboxSettings(settings: SandboxSettings): void {
    this.sandboxSettings = settings;
  }

  private async ensureTmpDir(): Promise<string> {
    if (!this.tmpDir) {
      this.tmpDir = await mkdtemp(path.join(os.tmpdir(), "muonroi-bg-"));
    }
    return this.tmpDir;
  }

  async execute(command: string, timeout = 30_000, abortSignal?: AbortSignal): Promise<ToolResult> {
    try {
      if (command.startsWith("cd ")) {
        const afterCd = command
          .substring(3)
          .trim()
          .replace(/^\/[a-zA-Z](?=\s)/, "")
          .trim();
        const parsed = afterCd.match(/^("[^"]+"|'[^']+'|[^\s&|;<>]+)(?:\s*(&&|\|\||;)\s*([\s\S]+))?$/);

        const rawDir = parsed?.[1] ?? afterCd;
        const chainOp = parsed?.[2];
        const remainder = parsed?.[3]?.trim() || null;

        const dir = rawDir.replace(/^["']|["']$/g, "").replace(process.platform === "win32" ? /\\$/ : /(?!x)x/, "");
        let cdSucceeded = false;
        let cdError: ToolResult | null = null;
        try {
          const translated = this.resolvedShell.isPosix ? posixToNative(dir) : dir;
          const nextCwd = path.resolve(this.cwd, translated);
          const info = await stat(nextCwd);
          if (!info.isDirectory()) {
            cdError = { success: false, error: `Cannot change directory: ${nextCwd} is not a directory` };
          } else {
            const oldCwd = this.cwd;
            this.cwd = nextCwd;
            cdSucceeded = true;

            const cwdInput: CwdChangedHookInput = {
              hook_event_name: "CwdChanged",
              old_cwd: oldCwd,
              new_cwd: nextCwd,
              cwd: nextCwd,
            };
            executeEventHooks(cwdInput, nextCwd).catch(() => {});
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          cdError = { success: false, error: `Cannot change directory: ${msg}` };
        }

        if (!remainder) {
          return cdSucceeded ? { success: true, output: `Changed directory to: ${this.cwd}` } : cdError!;
        }

        const shouldRunRemainder =
          chainOp === ";" || (chainOp === "&&" && cdSucceeded) || (chainOp === "||" && !cdSucceeded);

        if (!shouldRunRemainder) {
          return cdSucceeded ? { success: true, output: `Changed directory to: ${this.cwd}` } : cdError!;
        }

        return await this.execute(remainder, timeout, abortSignal);
      }

      if (abortSignal?.aborted) {
        return { success: false, error: "[Cancelled]" };
      }

      const prepared = this.prepareCommand(command);
      if (!prepared.ok) {
        return { success: false, error: prepared.error };
      }

      const runId = nextBashRunId();
      const startedAt = Date.now();
      return await new Promise<ToolResult>((resolve) => {
        let settled = false;
        let aborted = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          if (forceKillTimer) clearTimeout(forceKillTimer);
          abortSignal?.removeEventListener("abort", onAbort);
          resolve(result);
        };

        const child = exec(
          prepared.command,
          {
            cwd: this.cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: "0" },
            ...(this.resolvedShell.binary ? { shell: this.resolvedShell.binary } : {}),
          },
          (err, stdoutRaw, stderrRaw) => {
            if (aborted || abortSignal?.aborted) {
              finish({ success: false, error: "[Cancelled]" });
              return;
            }

            const stdout = stripAnsi(stdoutRaw);
            const stderr = stripAnsi(stderrRaw);
            // exec discards signal/timeout into a bare `err`. Recover them so we
            // never record `exitCode:1` for a signal death and can annotate why.
            const execErr = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
            const timedOut = Boolean(execErr?.killed);
            const signal = execErr?.signal ?? undefined;
            const exitCode = err && typeof err.code === "number" ? err.code : err ? (signal ? 128 : 1) : 0;
            recordBashRun({
              id: runId,
              command,
              stdout,
              stderr,
              exitCode,
              durationMs: Date.now() - startedAt,
            });
            const totalChars = stdout.length + stderr.length;
            const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
            if (err) {
              // Exit 141 = 128 + SIGPIPE: the pipe reader (`| head`, `| grep -q`)
              // closed after getting what it needed. With real stdout present this
              // is the requested answer, not a failure — a build/test that fails on
              // its own merits never dies of SIGPIPE. Only reachable via pipefail or
              // a direct SIGPIPE death, which safety-conscious models trigger with
              // `set -o pipefail; … | head`. Do NOT flip a genuine crash: require
              // stdout and no timeout kill.
              if (!timedOut && (exitCode === 141 || signal === "SIGPIPE") && stdout.trim()) {
                finish({
                  success: true,
                  output: `${output.trim()}\n[exit 141 (SIGPIPE): output truncated by a pipe reader such as | head — benign]`,
                  bashRunId: runId,
                  bashTotalChars: totalChars,
                });
                return;
              }
              // Every other non-zero stays a failure, but the model finally sees
              // WHY: it can then read `[exit code 1]` on a `grep`/`diff`/`test`
              // probe as a normal boolean answer, not a broken command, while a
              // failing build/test (exit 1/2 + output) still reads as ✗.
              const annotation = timedOut
                ? `[command timed out after ${timeout}ms and was killed${signal ? ` (${signal})` : ""}]`
                : signal
                  ? `[terminated by signal ${signal}]`
                  : `[exit code ${exitCode}]`;
              if (output.trim()) {
                finish({
                  success: false,
                  error: `${output.trim()}\n${annotation}`,
                  bashRunId: runId,
                  bashTotalChars: totalChars,
                });
                return;
              }
              finish({
                success: false,
                error: `${annotation} (no output): ${err.message.replace(/^Command failed: /, "")}`,
                bashRunId: runId,
                bashTotalChars: totalChars,
              });
              return;
            }

            finish({
              success: true,
              output: output.trim() || "Command executed successfully (no output)",
              bashRunId: runId,
              bashTotalChars: totalChars,
            });
          },
        );

        const onAbort = () => {
          aborted = true;
          try {
            child.kill("SIGTERM");
          } catch {
            finish({ success: false, error: "[Cancelled]" });
            return;
          }

          forceKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already exited */
            }
          }, 1_000);
        };

        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err) {
        const execErr = err as { stdout?: string; stderr?: string; message: string };
        const output = (execErr.stdout || "") + (execErr.stderr ? `\nSTDERR: ${execErr.stderr}` : "");
        if (output.trim()) {
          return { success: false, error: output.trim() };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Command failed: ${msg}` };
    }
  }

  async startBackground(command: string): Promise<ToolResult> {
    const alive = [...this.bgProcesses.values()].filter((p) => p.alive);
    if (alive.length >= MAX_BACKGROUND_PROCESSES) {
      return {
        success: false,
        output: `Too many background processes (${alive.length}/${MAX_BACKGROUND_PROCESSES}). Stop one first with process_stop.`,
      };
    }

    try {
      const prepared = this.prepareCommand(command);
      if (!prepared.ok) {
        return { success: false, output: prepared.error };
      }
      const tmpDir = await this.ensureTmpDir();
      const id = nextBgId++;
      const logPath = path.join(tmpDir, `bg-${id}.log`);
      const logStream = createWriteStream(logPath, { flags: "a" });

      const { binary, args } = this.spawnInvocation(prepared.command);
      const child = spawn(binary, args, {
        cwd: this.cwd,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
        windowsHide: true,
      });

      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);

      const entry: BackgroundProcess = {
        id,
        command,
        pid: child.pid ?? 0,
        cwd: this.cwd,
        startedAt: new Date(),
        child,
        logPath,
        alive: true,
        exitCode: null,
      };

      child.on("exit", (code) => {
        entry.alive = false;
        entry.exitCode = code;
        logStream.end();
      });

      child.on("error", () => {
        entry.alive = false;
        logStream.end();
      });

      this.bgProcesses.set(id, entry);

      return {
        success: true,
        output: [
          `Background process started (id: ${id}, pid: ${entry.pid})`,
          `Command: ${truncCmd(command, 80)}`,
          `Use process_logs(${id}) to view output, process_stop(${id}) to terminate.`,
        ].join("\n"),
        backgroundProcess: { id, pid: entry.pid, command },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Failed to start background process: ${msg}` };
    }
  }

  async getProcessLogs(id: number, tail = 50): Promise<ToolResult> {
    const entry = this.bgProcesses.get(id);
    if (!entry) {
      return { success: false, output: `No background process with id ${id}.` };
    }

    try {
      const stats = await stat(entry.logPath);
      const start = Math.max(0, stats.size - MAX_TAIL_BYTES);

      const content = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = createReadStream(entry.logPath, { start });
        stream.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
      });

      const lines = content.split("\n");
      const tailed = lines.slice(-tail).join("\n").trimEnd();
      const status = entry.alive ? "running" : `exited (code ${entry.exitCode ?? "unknown"})`;

      return {
        success: true,
        output: [
          `[Process ${id} — ${status} — pid ${entry.pid}]`,
          `[${truncCmd(entry.command, 70)}]`,
          "",
          tailed || "(no output yet)",
        ].join("\n"),
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: `Failed to read logs for process ${id}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async stopProcess(id: number): Promise<ToolResult> {
    const entry = this.bgProcesses.get(id);
    if (!entry) {
      return { success: false, output: `No background process with id ${id}.` };
    }

    if (!entry.alive) {
      return { success: false, output: `Process ${id} is already stopped.` };
    }

    try {
      entry.child.kill("SIGTERM");
      entry.alive = false;
      return { success: true, output: `Process ${id} terminated.` };
    } catch (err: unknown) {
      return {
        success: false,
        output: `Failed to stop process ${id}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  listProcesses(): ToolResult {
    const entries = [...this.bgProcesses.values()];
    if (entries.length === 0) {
      return { success: true, output: "No background processes." };
    }

    const lines = entries.map((entry) => {
      const status = entry.alive ? "running" : `exited(${entry.exitCode ?? "?"})`;
      const age = formatAge(entry.startedAt);
      return `${entry.id}  ${status}  pid:${entry.pid}  ${age}  ${truncCmd(entry.command, 50)}`;
    });

    return {
      success: true,
      output: ["ID  STATUS       PID    AGE     COMMAND", ...lines].join("\n"),
    };
  }

  async cleanup(): Promise<void> {
    for (const entry of this.bgProcesses.values()) {
      if (entry.alive) {
        try {
          entry.child.kill("SIGTERM");
        } catch {
          /* */
        }
      }
      try {
        await unlink(entry.logPath);
      } catch {
        /* */
      }
    }
    this.bgProcesses.clear();
    if (this.tmpDir) {
      try {
        await rm(this.tmpDir, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(next: string): void {
    if (!path.isAbsolute(next)) {
      throw new Error(`setCwd: path must be absolute, got: ${next}`);
    }
    if (!existsSync(next)) {
      throw new Error(`setCwd: path does not exist: ${next}`);
    }
    this.cwd = next;
  }

  getToolDescription(): string {
    return "Execute a bash command. Use for find, ls, git, build tools, package managers, running tests, and any other shell command. For content search, prefer the dedicated grep tool. Set background=true for long-running processes like dev servers, watchers, or anything that should keep running while you continue working. For file read/write/edit, prefer the dedicated file tools instead.";
  }

  getResolvedShell(): ResolvedShell {
    return this.resolvedShell;
  }

  private spawnInvocation(command: string): { binary: string; args: string[] } {
    const shell = this.resolvedShell;
    if (shell.binary) {
      if (shell.kind === "wsl") {
        return { binary: shell.binary, args: ["bash", "-lc", command] };
      }
      if (shell.kind === "powershell") {
        return { binary: shell.binary, args: ["-NoProfile", "-NonInteractive", "-Command", command] };
      }
      if (shell.kind === "bash") {
        return { binary: shell.binary, args: ["-lc", command] };
      }
      // cmd.exe or unknown
      return { binary: shell.binary, args: ["/d", "/s", "/c", command] };
    }
    if (process.platform === "win32") {
      return { binary: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
    }
    return { binary: "/bin/sh", args: ["-c", command] };
  }

  /**
   * Pre-execution command preparation.
   *
   * Layer 1 — Catastrophic hard-block: checks the command against
   * CATASTROPHIC_PATTERNS in permission-mode.ts. These are irreversible or
   * severely dangerous operations that are blocked regardless of permission
   * mode (safe / auto-edit / yolo) and regardless of sandbox state.
   *
   * Layer 2 — Future sandbox: when a new sandbox is wired in, wrap the
   * command here before returning.
   */
  /**
   * Pre-execution command preparation with two-layer safety.
   *
   * Layer 1 — Catastrophic hard-block: checks the command against
   * CATASTROPHIC_PATTERNS in permission-mode.ts. Returns structured block
   * result so callers can route to askcard approval flow.
   *
   * Layer 2 — Future sandbox: when a new sandbox is wired in, wrap the
   * command here before returning.
   */
  private prepareCommand(
    command: string,
  ): { ok: true; command: string } | { ok: false; error: string; block: SafetyBlockResult } {
    const catBlock = checkCatastrophicCommand(command);
    if (catBlock) {
      return {
        ok: false,
        error:
          `BLOCKED (${catBlock.kind}): ${catBlock.reason}\n` +
          "This command is blocked by the safety filter. " +
          "Use the safety_override tool or ask the user for approval.",
        block: catBlock,
      };
    }
    return { ok: true, command };
  }
}

function truncCmd(cmd: string, max: number): string {
  const oneLine = cmd.replace(/\n/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatAge(start: Date): string {
  const sec = Math.round((Date.now() - start.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

export function wrapHostBrowserCommand(command: string): string {
  return command;
}
