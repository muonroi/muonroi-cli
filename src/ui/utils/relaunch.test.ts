import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { relaunchWithSession, sanitizeArgvForResume } from "./relaunch.js";

describe("sanitizeArgvForResume", () => {
  it("appends --session when no prior session flag exists", () => {
    expect(sanitizeArgvForResume(["-m", "grok-build-0.1"], "abc-123")).toEqual([
      "-m",
      "grok-build-0.1",
      "--session",
      "abc-123",
    ]);
  });

  it("strips an existing `-s <id>` and replaces it", () => {
    expect(sanitizeArgvForResume(["-s", "old-id", "-m", "grok-build-0.1"], "new-id")).toEqual([
      "-m",
      "grok-build-0.1",
      "--session",
      "new-id",
    ]);
  });

  it("strips an existing `--session <id>` (long form)", () => {
    expect(sanitizeArgvForResume(["--session", "old-id", "-y"], "new-id")).toEqual(["-y", "--session", "new-id"]);
  });

  it("strips the combined `--session=<id>` form", () => {
    expect(sanitizeArgvForResume(["--session=old-id", "-y"], "new-id")).toEqual(["-y", "--session", "new-id"]);
  });

  it("strips `--session` even when its value looks like another flag (treats value as missing)", () => {
    // edge: user typed `--session --batch-api` — we don't eat the next flag
    expect(sanitizeArgvForResume(["--session", "--batch-api", "-y"], "new-id")).toEqual([
      "--batch-api",
      "-y",
      "--session",
      "new-id",
    ]);
  });

  it("removes multiple stray session flags (defensive — last wins)", () => {
    expect(sanitizeArgvForResume(["-s", "a", "--session", "b", "--session=c"], "z")).toEqual(["--session", "z"]);
  });

  it("throws when sessionId is empty or whitespace", () => {
    expect(() => sanitizeArgvForResume([], "")).toThrow(/sessionId is required/);
    expect(() => sanitizeArgvForResume([], "  ")).toThrow(/sessionId is required/);
  });

  it("strips transient launch-mode flags (--agent-mode) so resume does not re-enter agent-mode", () => {
    expect(sanitizeArgvForResume(["--agent-mode", "-m", "grok-build-0.1"], "new-id")).toEqual([
      "-m",
      "grok-build-0.1",
      "--session",
      "new-id",
    ]);
  });

  it("strips `--mock-llm <dir>` and the combined form", () => {
    expect(sanitizeArgvForResume(["--mock-llm", "/fix/dir", "-y"], "new-id")).toEqual(["-y", "--session", "new-id"]);
    expect(sanitizeArgvForResume(["--mock-llm=/fix/dir", "-y"], "new-id")).toEqual(["-y", "--session", "new-id"]);
  });

  it("strips agent-mode + mock-llm together (harness-launched resume → clean user CLI)", () => {
    expect(sanitizeArgvForResume(["--agent-mode", "--mock-llm", "/fx", "--session", "old"], "new")).toEqual([
      "--session",
      "new",
    ]);
  });
});

describe("relaunchWithSession", () => {
  it("spawns the same executable with the sanitized argv + session id, then exits 0", () => {
    const exitMock = vi.fn();
    const child = new EventEmitter() as EventEmitter & { spawnArgs?: unknown };
    const spawnMock = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    relaunchWithSession("sess-xyz", {
      argv: ["/usr/local/bin/muonroi-cli", "-m", "grok-build-0.1"],
      onExit: exitMock,
      spawnFn: spawnMock,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/muonroi-cli",
      ["-m", "grok-build-0.1", "--session", "sess-xyz"],
      { stdio: "inherit", detached: false },
    );
    // exit fires on the child's "spawn" event
    child.emit("spawn");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("exits 1 if the child spawn errors before starting", () => {
    const exitMock = vi.fn();
    const errMock = vi.spyOn(console, "error").mockImplementation(() => {});
    const child = new EventEmitter();
    const spawnMock = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    relaunchWithSession("sess-xyz", {
      argv: ["/bin/muonroi", "-y"],
      onExit: exitMock,
      spawnFn: spawnMock,
    });
    child.emit("error", new Error("ENOENT"));
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errMock).toHaveBeenCalled();
    errMock.mockRestore();
  });

  it("runs beforeSpawn teardown before spawning", () => {
    const calls: string[] = [];
    const child = new EventEmitter();
    const spawnMock = vi.fn(() => {
      calls.push("spawn");
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    relaunchWithSession("sess", {
      argv: ["/bin/bun", "src/index.ts"],
      onExit: () => {},
      spawnFn: spawnMock,
      beforeSpawn: () => calls.push("teardown"),
    });

    expect(calls).toEqual(["teardown", "spawn"]);
  });

  it("supervise: stays alive until the child exits, then propagates the exit code", () => {
    const exitMock = vi.fn();
    const child = new EventEmitter();
    const spawnMock = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    relaunchWithSession("sess", {
      argv: ["/bin/bun", "src/index.ts"],
      onExit: exitMock,
      spawnFn: spawnMock,
      supervise: true,
    });

    // Does NOT exit on spawn when supervising.
    child.emit("spawn");
    expect(exitMock).not.toHaveBeenCalled();
    // Exits with the child's code when the child finally exits.
    child.emit("exit", 3);
    expect(exitMock).toHaveBeenCalledWith(3);
  });

  it("throws when argv[0] is missing (cannot relaunch without an executable)", () => {
    expect(() =>
      relaunchWithSession("sess", {
        argv: [],
        onExit: () => {},
        spawnFn: (() => new EventEmitter()) as unknown as typeof import("node:child_process").spawn,
      }),
    ).toThrow(/process\.argv\[0\] is empty/);
  });
});
