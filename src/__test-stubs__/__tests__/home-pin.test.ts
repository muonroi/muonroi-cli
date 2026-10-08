/**
 * The suite's muonroi home must be a temp dir, never the developer's real one.
 *
 * This asserts the REDIRECT, not merely that the env var is set: it calls a
 * production path resolver (`getSessionDir`, which goes through the same
 * `MUONROI_CLI_HOME ?? homedir() + "/.muonroi-cli"` convention as ~16 other
 * modules) and checks where it actually lands.
 *
 * What it protects: a test once created package directories under the real
 * `~/.muonroi-cli/cache/lsp/` and its cleanup `rm -rf`'d them, deleting the
 * user's genuine pyright install (`src/lsp/npm-cache.ts:20-28`). Pinning the
 * root in `vitest-setup.ts` makes that class impossible; this test fails if the
 * pin is removed, so it cannot regress silently.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSessionDir } from "../../storage/session-dir.js";

const realHome = path.resolve(path.join(os.homedir(), ".muonroi-cli"));

describe("suite-wide MUONROI_CLI_HOME pin", () => {
  it("is set, and points inside the OS temp dir", () => {
    const pinned = process.env.MUONROI_CLI_HOME;
    expect(pinned, "vitest-setup.ts must pin MUONROI_CLI_HOME").toBeTruthy();
    expect(path.resolve(pinned!).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(existsSync(pinned!)).toBe(true);
  });

  it("is not the developer's real ~/.muonroi-cli", () => {
    expect(path.resolve(process.env.MUONROI_CLI_HOME!)).not.toBe(realHome);
  });

  it("actually redirects a production path resolver away from the real home", async () => {
    // The assertion that matters: not "the env var is set" but "the code that
    // reads it lands somewhere harmless".
    const dir = path.resolve(await getSessionDir("home-pin-probe"));

    expect(dir.startsWith(path.resolve(process.env.MUONROI_CLI_HOME!))).toBe(true);
    expect(dir.startsWith(realHome), `resolved into the REAL home: ${dir}`).toBe(false);
  });
});
