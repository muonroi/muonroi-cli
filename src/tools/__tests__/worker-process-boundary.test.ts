import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { BashTool } from "../bash.js";
import { createBuiltinTools } from "../registry.js";

const worker = () => new BashTool(os.tmpdir(), { workerScope: true });

describe("worker process boundary", () => {
  it.each([
    "taskkill //F //PID 37968 //PID 23116",
    'cmd //c "taskkill /F /IM dotnet.exe"',
    'powershell -NoProfile -Command "Get-Process dotnet | Stop-Process -Force"',
    "bash -lc 'kill -9 123'",
    "echo ready; pkill dotnet",
    "& 'C:\\Windows\\System32\\taskkill.exe' /PID 123",
    "dotnet build-server shutdown",
    "dotnet nuget locals all --clear",
    "wmic process where ProcessId=123 call terminate",
  ])("refuses explicit shared process/cache operations before spawning: %s", (command) => {
    // Probe preparation only: never execute the historical destructive command.
    const prepared = (worker() as any).prepareCommand(command);
    expect(prepared.ok).toBe(false);
    expect(prepared.error).toContain("worker_process_boundary");
  });

  it.each([
    'echo "taskkill /PID 123"',
    "rg Stop-Process src",
    "dotnet build scoped.csproj",
    "dotnet nuget locals all --list",
    "node inspect.js",
    "git status --short",
    "wmic process get ProcessId,Name",
  ])("preserves ordinary commands and quoted data: %s", (command) => {
    expect((worker() as any).prepareCommand(command).ok).toBe(true);
  });

  it("blocks foreground, background and cd chains without cwd or shell effects", async () => {
    const bash = worker();
    const cwd = bash.getCwd();
    expect((await bash.execute("cd / && taskkill /PID __invalid_pid__")).success).toBe(false);
    expect(bash.getCwd()).toBe(cwd);
    expect((await bash.startBackground("taskkill /PID __invalid_pid__")).success).toBe(false);
    expect(bash.listProcesses().output).toContain("No background processes");
  });

  it("enforces the registry boundary even when the underlying executor is replaced", async () => {
    const bash = new BashTool(os.tmpdir());
    const execute = vi.spyOn(bash, "execute").mockResolvedValue({ success: true, output: "unexpected" });
    const tools = createBuiltinTools(bash, "agent", { executionRole: "worker" });
    const output = await tools.bash!.execute!({ command: "taskkill //F //PID 123" }, {} as any);
    expect(String(output)).toContain("worker_process_boundary");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not let a yolo safety approval override worker ownership", async () => {
    const previous = globalThis.__muonroiSafetyApproved;
    const command = "taskkill /PID 123";
    globalThis.__muonroiSafetyApproved = new Map([["approved", { kind: "once", command }]]);
    const bash = worker();
    const execute = vi.spyOn(bash, "execute").mockResolvedValue({ success: true, output: "unexpected" });
    try {
      const tools = createBuiltinTools(bash, "agent", { executionRole: "worker" });
      const output = await tools.bash!.execute!(
        { command, background: true },
        { toolCallId: "approved", messages: [] },
      );
      expect(String(output)).toContain("worker_process_boundary");
      expect(execute).not.toHaveBeenCalled();
      expect(globalThis.__muonroiSafetyApproved.has("approved")).toBe(true);
    } finally {
      globalThis.__muonroiSafetyApproved = previous;
    }
  });

  it("does not change the main executor or the native per-instance process ownership boundary", async () => {
    const owner = new BashTool(os.tmpdir());
    expect((owner as any).prepareCommand("taskkill //F //PID 123").ok).toBe(true);
    const stop = vi.fn();
    (owner as any).bgProcesses.set(91234, { alive: true, child: { kill: stop } });
    expect((await worker().stopProcess(91234)).success).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect((await owner.stopProcess(91234)).success).toBe(true);
    expect(stop).toHaveBeenCalledWith("SIGTERM");
  });
});
