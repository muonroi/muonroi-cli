import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relativizePath, writeExperienceConfig } from "./auth.js";

describe("auth path utilities", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
});
