import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // This suite runs from the repo checkout, so detectInstallMethod() reports
  // dev-link — the same path a `bun link`-ed install takes at runtime.
  it("performs the update on a linked checkout instead of printing the commands", async () => {
    const ran: string[] = [];
    const { runManagedUpdate } = await import("./install-manager");

    const result = await runManagedUpdate("1.0.0", async (step) => {
      ran.push(`${step.cmd} ${step.args.join(" ")}`);
      return { code: 0, output: "" };
    });

    expect(result.success).toBe(true);
    expect(ran).toContain("git pull --ff-only");
    expect(ran).toContain("bun run build");
    // The old output was three commands for the user to copy — the whole defect.
    expect(result.output).not.toContain("pull && bun install && bun run build");
  });

  it("surfaces a failing step rather than reporting success", async () => {
    const { runManagedUpdate } = await import("./install-manager");

    const result = await runManagedUpdate("1.0.0", async (step) =>
      step.args[0] === "install" ? { code: 1, output: "lockfile conflict" } : { code: 0, output: "" },
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("lockfile conflict");
  });
});
