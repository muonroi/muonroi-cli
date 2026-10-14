import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bestEffortRemove } from "../__test-stubs__/cleanup";
import { relativizePath, writeExperienceConfig } from "./auth.js";

describe("auth path utilities", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-test-"));
  });

  afterEach(async () => {
    await bestEffortRemove(tmpDir, "src/ee/auth.test.ts");
  });

  it("relativizes home path structures and replaces slashes safely", () => {
    const home = os.homedir().replace(/\\/g, "/");
    const testPath = `${home}/some/nested/dir`;
    expect(relativizePath(testPath)).toBe("~/some/nested/dir");
    expect(relativizePath(`${os.homedir()}\\some\\nested\\dir`)).toBe("~/some/nested/dir");
  });

  it("writeExperienceConfig creates directory with 0o700 permissions", async () => {
    const configHome = path.join(tmpDir, "custom-home");
    // Ensure parent dir doesn't exist yet
    await writeExperienceConfig({ authToken: "test-token" }, { home: configHome });

    const expDir = path.join(configHome, ".experience");
    const stats = await fs.stat(expDir);
    expect(stats.isDirectory()).toBe(true);

    // Mode is platform dependent (on Windows permissions are simulated differently,
    // but on Unix we can check exactly that they are 0o700)
    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  // ── Credential at rest ────────────────────────────────────────────────────
  //
  // config.json holds `serverAuthToken` in PLAINTEXT. The directory was already
  // created 0o700, but the FILE was written with no mode, so it landed at the
  // default umask (0644 on POSIX) — readable by any other local user, and
  // carried into any backup of $HOME.
  //
  // Mode assertions are POSIX-only for the same reason as the 0o700 check above;
  // the content assertion runs everywhere so a mode change can never silently
  // break the merge.

  const itPosix = process.platform === "win32" ? it.skip : it;

  itPosix("writeExperienceConfig writes config.json at 0o600, not the umask default", async () => {
    const configHome = path.join(tmpDir, "fresh-home");

    await writeExperienceConfig({ serverAuthToken: `tok-${"notarealtoken"}` }, { home: configHome });

    const stats = await fs.stat(path.join(configHome, ".experience", "config.json"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  itPosix("TIGHTENS an existing world-readable config.json to 0o600", async () => {
    // The regression that a create-time `mode` alone would NOT fix: `mode` on
    // writeFile applies only when the file is created, so a config.json an
    // installer (or an older build) already left at 0644 would stay at 0644
    // forever. This is the case that makes an explicit chmod necessary.
    const configHome = path.join(tmpDir, "existing-home");
    const expDir = path.join(configHome, ".experience");
    const cfg = path.join(expDir, "config.json");
    await fs.mkdir(expDir, { recursive: true });
    await fs.writeFile(cfg, JSON.stringify({ serverBaseUrl: "https://experience.example.com" }), "utf8");
    await fs.chmod(cfg, 0o644);
    expect((await fs.stat(cfg)).mode & 0o777).toBe(0o644);

    await writeExperienceConfig({ serverAuthToken: `tok-${"notarealtoken"}` }, { home: configHome });

    expect((await fs.stat(cfg)).mode & 0o777).toBe(0o600);
  });

  it("requests 0o600 on every write, on every platform", async () => {
    // The two assertions above are POSIX-only, because Windows does not model
    // POSIX permission bits — which would leave this fix UNVERIFIED on the
    // platform it was authored on. Asserting the syscall instead runs everywhere,
    // so the chmod cannot be dropped without a local failure.
    const chmodSpy = vi.spyOn(fs, "chmod");
    try {
      const configHome = path.join(tmpDir, "spy-home");
      await writeExperienceConfig({ serverAuthToken: `tok-${"notarealtoken"}` }, { home: configHome });

      const cfg = path.join(configHome, ".experience", "config.json").replace(/\\/g, "/");
      const call = chmodSpy.mock.calls.find(([target]) => String(target).replace(/\\/g, "/") === cfg);
      expect(call, `chmod was never called for ${cfg}`).toBeDefined();
      expect(call?.[1]).toBe(0o600);
    } finally {
      chmodSpy.mockRestore();
    }
  });

  it("still merges the patch over existing fields when tightening the mode", async () => {
    const configHome = path.join(tmpDir, "merge-home");
    const expDir = path.join(configHome, ".experience");
    await fs.mkdir(expDir, { recursive: true });
    await fs.writeFile(
      path.join(expDir, "config.json"),
      JSON.stringify({ serverBaseUrl: "https://experience.example.com", serverTimeoutMs: 9000 }),
      "utf8",
    );

    const token = `tok-${"notarealtoken"}`;
    await writeExperienceConfig({ serverAuthToken: token }, { home: configHome });

    const written = JSON.parse(await fs.readFile(path.join(expDir, "config.json"), "utf8")) as Record<string, unknown>;
    // The permission hardening must not disturb the merge semantics the EE
    // installer depends on.
    expect(written.serverBaseUrl).toBe("https://experience.example.com");
    expect(written.serverTimeoutMs).toBe(9000);
    expect(written.serverAuthToken).toBe(token);
  });
});
