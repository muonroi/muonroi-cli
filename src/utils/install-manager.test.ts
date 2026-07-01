import { exec } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    exec: vi.fn(),
  };
});

import {
  buildScriptUninstallPlan,
  getInstallMetadataPath,
  getReleaseTargetForPlatform,
  getScriptInstallContext,
  getScriptInstallDir,
  loadScriptInstallMetadata,
  parseChecksumsFile,
  saveScriptInstallMetadata,
} from "./install-manager";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  tempDirs = [];
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("getReleaseTargetForPlatform", () => {
  it("maps supported platforms to release asset names", () => {
    expect(getReleaseTargetForPlatform("darwin", "arm64")?.assetName).toBe("muonroi-cli-darwin-arm64");
    expect(getReleaseTargetForPlatform("darwin", "x64")?.assetName).toBe("muonroi-cli-darwin-arm64");
    expect(getReleaseTargetForPlatform("linux", "x64")?.assetName).toBe("muonroi-cli-linux-x64");
    expect(getReleaseTargetForPlatform("win32", "x64")?.assetName).toBe("muonroi-cli-windows-x64.exe");
    expect(getReleaseTargetForPlatform("linux", "arm64")).toBeNull();
  });
});

describe("parseChecksumsFile", () => {
  it("parses standard and BSD-style checksum entries", () => {
    const checksums = parseChecksumsFile(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  muonroi-cli-darwin-arm64",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *muonroi-cli-windows-x64.exe",
      ].join("\n"),
    );
    expect(checksums.get("muonroi-cli-darwin-arm64")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(checksums.get("muonroi-cli-windows-x64.exe")).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});

describe("script install metadata", () => {
  it("round-trips metadata through write and load", () => {
    const homeDir = createTempDir("muonroi-cli-meta-");
    const installDir = getScriptInstallDir(homeDir);
    const metadata = {
      schemaVersion: 1,
      installMethod: "script" as const,
      version: "1.2.3",
      repo: "muonroi/muonroi-cli",
      binaryPath: path.join(installDir, "muonroi-cli"),
      installDir,
      assetName: "muonroi-cli-darwin-arm64",
      target: "darwin-arm64" as const,
      installedAt: "2026-04-03T00:00:00.000Z",
      shellConfigPath: path.join(homeDir, ".zshrc"),
      pathCommand: `export PATH=${installDir}:$PATH`,
    };

    saveScriptInstallMetadata(metadata, homeDir);
    expect(loadScriptInstallMetadata(homeDir)).toEqual(metadata);
    expect(fs.existsSync(getInstallMetadataPath(homeDir))).toBe(true);
  });

  it("returns null when no metadata file exists", () => {
    expect(loadScriptInstallMetadata(createTempDir("muonroi-cli-empty-"))).toBeNull();
  });
});

describe("getScriptInstallContext", () => {
  it("returns context when metadata exists", () => {
    const homeDir = createTempDir("muonroi-cli-ctx-");
    const installDir = getScriptInstallDir(homeDir);
    const currentTarget = getReleaseTargetForPlatform();
    expect(currentTarget).not.toBeNull();

    saveScriptInstallMetadata(
      {
        schemaVersion: 1,
        installMethod: "script" as const,
        version: "1.2.3",
        repo: "muonroi/muonroi-cli",
        binaryPath: path.join(installDir, currentTarget!.binaryName),
        installDir,
        assetName: currentTarget!.assetName,
        target: currentTarget!.key,
        installedAt: "2026-04-03T00:00:00.000Z",
      },
      homeDir,
    );

    const ctx = getScriptInstallContext(homeDir);
    expect(ctx?.metadata.installMethod).toBe("script");
    expect(ctx?.binaryPath).toBe(path.join(installDir, currentTarget!.binaryName));
  });

  it("returns null when no metadata exists", () => {
    expect(getScriptInstallContext(createTempDir("muonroi-cli-no-ctx-"))).toBeNull();
  });
});

describe("buildScriptUninstallPlan", () => {
  it("removes the full ~/.muonroi-cli directory by default", () => {
    const homeDir = createTempDir("muonroi-cli-uninstall-");
    const installDir = getScriptInstallDir(homeDir);
    const currentTarget = getReleaseTargetForPlatform()!;
    fs.mkdirSync(installDir, { recursive: true });

    saveScriptInstallMetadata(
      {
        schemaVersion: 1,
        installMethod: "script" as const,
        version: "1.2.3",
        repo: "muonroi/muonroi-cli",
        binaryPath: path.join(installDir, currentTarget.binaryName),
        installDir,
        assetName: currentTarget.assetName,
        target: currentTarget.key,
        installedAt: "2026-04-03T00:00:00.000Z",
      },
      homeDir,
    );

    const plan = buildScriptUninstallPlan({}, homeDir);
    expect(plan?.removePaths).toContain(path.join(homeDir, ".muonroi-cli"));
  });

  it("keeps config and data when requested", () => {
    const homeDir = createTempDir("muonroi-cli-keep-");
    const installDir = getScriptInstallDir(homeDir);
    const currentTarget = getReleaseTargetForPlatform()!;
    fs.mkdirSync(installDir, { recursive: true });

    saveScriptInstallMetadata(
      {
        schemaVersion: 1,
        installMethod: "script" as const,
        version: "1.2.3",
        repo: "muonroi/muonroi-cli",
        binaryPath: path.join(installDir, currentTarget.binaryName),
        installDir,
        assetName: currentTarget.assetName,
        target: currentTarget.key,
        installedAt: "2026-04-03T00:00:00.000Z",
      },
      homeDir,
    );

    const plan = buildScriptUninstallPlan({ keepConfig: true, keepData: true }, homeDir);
    expect(plan?.removePaths).not.toContain(path.join(homeDir, ".muonroi-cli"));
    expect(plan?.removePaths).toContain(path.join(installDir, currentTarget.binaryName));
  });
});

describe("runManagedUpdate", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles dev-link update when newer version is available", async () => {
    vi.mocked(exec).mockImplementation(((cmd: any, callback: any) => {
      callback(null, "hash\trefs/tags/v2.0.0\n", "");
      return {} as any;
    }) as any);

    const { runManagedUpdate } = await import("./install-manager");
    const result = await runManagedUpdate("1.0.0");

    expect(result.success).toBe(true);
    expect(result.output).toContain("A new version of `muonroi-cli` is available!");
    expect(result.output).toContain("Current Version:** `v1.0.0`");
    expect(result.output).toContain("Latest Version:** `v2.0.0`");
    expect(result.output).toContain("git -C");
    expect(result.output).toContain("pull && bun install && bun run build");
  });

  it("handles dev-link when already up to date", async () => {
    vi.mocked(exec).mockImplementation(((cmd: any, callback: any) => {
      callback(null, "hash\trefs/tags/v1.0.0\n", "");
      return {} as any;
    }) as any);

    const { runManagedUpdate } = await import("./install-manager");
    const result = await runManagedUpdate("1.0.0");

    expect(result.success).toBe(true);
    expect(result.output).toContain("You are already up to date!");
    expect(result.output).toContain("Current Version:** `v1.0.0`");
    expect(result.output).toContain("Latest Version:** `v1.0.0`");
  });

  it("handles dev-link when local is ahead of latest remote version", async () => {
    vi.mocked(exec).mockImplementation(((cmd: any, callback: any) => {
      callback(null, "hash\trefs/tags/v1.0.0\n", "");
      return {} as any;
    }) as any);

    const { runManagedUpdate } = await import("./install-manager");
    const result = await runManagedUpdate("1.1.0");

    expect(result.success).toBe(true);
    expect(result.output).toContain("Your local installation is newer than the remote release tag.");
    expect(result.output).toContain("Current Version:** `v1.1.0`");
    expect(result.output).toContain("Latest Version:** `v1.0.0`");
  });
});
