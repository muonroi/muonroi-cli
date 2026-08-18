import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELEASE_URL = "https://api.github.com/repos/muonroi/muonroi-cli/releases/latest";

// These specs exercise the RELEASE path, so the install method has to be
// pinned: the suite itself runs out of a git checkout, so the real detector
// returns "dev-link" here and would route every case through the source-branch
// check instead.
const state = vi.hoisted(() => ({
  method: "compiled" as import("./install-manager").InstallMethod,
  upstream: null as { branch: string; behind: boolean } | null,
}));

vi.mock("./install-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./install-manager")>();
  return {
    ...actual,
    detectInstallMethod: () => state.method,
    getRunningCheckoutRoot: () => "/repo",
    checkUpstreamCommits: async () => state.upstream,
  };
});

beforeEach(() => {
  state.method = "compiled";
  state.upstream = null;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importModule() {
  return import("./update-checker");
}

describe("checkForUpdate", () => {
  it("returns hasUpdate=true when release version is newer", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tag_name: "v2.0.0", assets: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(true);
    expect(result!.latestVersion).toBe("2.0.0");
    expect(result!.currentVersion).toBe("1.0.0");
    expect(mockFetch).toHaveBeenCalledWith(
      RELEASE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
        }),
      }),
    );
  });

  it("returns hasUpdate=false when current version matches latest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v1.0.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(false);
  });

  it("detects update from prerelease to stable release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v1.0.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0-rc7");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(true);
    expect(result!.latestVersion).toBe("1.0.0");
    expect(result!.currentVersion).toBe("1.0.0-rc7");
  });

  it("returns hasUpdate=false when prerelease is newer than registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.9.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0-rc7");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(false);
  });

  it("returns null when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });

  it("returns null when the release API returns a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });

  it("returns null when the release API returns an invalid version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "not-a-version", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });

  it("returns null when the current version is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v2.0.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("garbage");

    expect(result).toBeNull();
  });

  it("handles fetch timeout gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 10))),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });
});

describe("checkForUpdate — linked source checkout", () => {
  // A checkout updates by pulling its branch. Comparing against the newest
  // RELEASE TAG answered a different question: it stayed silent while the
  // checkout fell behind, and cried "update" whenever the checkout was ahead
  // of the tag.
  it("reports an update when the branch has upstream commits, without asking the release API", async () => {
    state.method = "dev-link";
    state.upstream = { branch: "develop", behind: true };
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.9.0");

    expect(result?.hasUpdate).toBe(true);
    expect(result?.latestLabel).toBe("new commits on develop");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports no update when the branch head is already checked out", async () => {
    state.method = "dev-link";
    state.upstream = { branch: "develop", behind: false };

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.9.0");

    expect(result?.hasUpdate).toBe(false);
  });

  it("stays silent when the upstream cannot be read", async () => {
    state.method = "dev-link";
    state.upstream = null;

    const { checkForUpdate } = await importModule();

    await expect(checkForUpdate("1.9.0")).resolves.toBeNull();
  });
});

describe("runUpdate", () => {
  it("returns success when the managed updater succeeds", async () => {
    vi.doMock("./install-manager", async () => {
      const actual = await vi.importActual<typeof import("./install-manager")>("./install-manager");
      return {
        ...actual,
        runManagedUpdate: vi.fn().mockResolvedValue({ success: true, output: "Updated to muonroi-cli 2.0.0." }),
      };
    });

    const { runUpdate } = await importModule();
    const result = await runUpdate("1.0.0");

    expect(result.success).toBe(true);
    expect(result.output).toContain("Updated");
  });

  it("returns failure when the managed updater fails", async () => {
    vi.doMock("./install-manager", async () => {
      const actual = await vi.importActual<typeof import("./install-manager")>("./install-manager");
      return {
        ...actual,
        runManagedUpdate: vi.fn().mockResolvedValue({ success: false, output: "permission denied" }),
      };
    });

    const { runUpdate } = await importModule();
    const result = await runUpdate("1.0.0");

    expect(result.success).toBe(false);
    expect(result.output).toContain("permission denied");
  });
});

describe("getUpdateCommandForMethod", () => {
  it("maps bun/npm global installs to the right update command", async () => {
    const { getUpdateCommandForMethod } = await import("./install-manager");
    expect(getUpdateCommandForMethod("bun-global")).toBe("bun add -g muonroi-cli@latest");
    expect(getUpdateCommandForMethod("npm-global")).toBe("npm install -g muonroi-cli@latest");
  });

  it("returns null for methods without a package-manager command", async () => {
    const { getUpdateCommandForMethod } = await import("./install-manager");
    expect(getUpdateCommandForMethod("script")).toBeNull();
    expect(getUpdateCommandForMethod("compiled")).toBeNull();
    expect(getUpdateCommandForMethod("unknown")).toBeNull();
  });
});
