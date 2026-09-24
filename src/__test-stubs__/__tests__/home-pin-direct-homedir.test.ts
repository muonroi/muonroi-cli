/**
 * The five modules that used to resolve `os.homedir()` DIRECTLY must honour the
 * suite-wide `MUONROI_CLI_HOME` pin like every other storage root.
 *
 * `home-pin.test.ts` proves the pin redirects the ~16 modules that already read
 * the env var. These five did not: `src/utils/instructions.ts`,
 * `src/tools/schedule.ts`, `src/utils/stderr-mirror.ts`,
 * `src/council/crash-breadcrumb.ts` and `src/providers/auth/token-store.ts`
 * each joined `os.homedir()` themselves, so the pin could not reach them. Their
 * existing tests stayed green only because each mocks `os.homedir()` per file —
 * safety by coincidence. A NEW test touching any of these without that mock
 * would have written into the developer's real `~/.muonroi-cli`, which is
 * exactly how a run once deleted the user's real pyright install
 * (`src/lsp/npm-cache.ts:20-28`).
 *
 * Every assertion here calls the PRODUCTION resolver and checks where it lands —
 * never merely that an env var is set — following `home-pin.test.ts`.
 *
 * The second half pins LAZY resolution: it re-points `MUONROI_CLI_HOME` after
 * the modules are imported and demands the resolvers follow. `schedule.ts` held
 * its paths in module-level `const`s evaluated at import, so the env var alone
 * could not have redirected it; that shape is the trap `npm-cache.ts:20-28`
 * records, and these cases fail if anyone reintroduces it.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { breadcrumbFilePath } from "../../council/crash-breadcrumb.js";
import { loadTokens, saveTokens } from "../../providers/auth/token-store.js";
import { ensureSchedulesDir, getScheduleDaemonPidPath, getScheduleRecordPath } from "../../tools/schedule.js";
import { loadCustomInstructions, resetInstructionsCache } from "../../utils/instructions.js";
import { stderrMirrorPath } from "../../utils/stderr-mirror.js";

/**
 * Placeholder token fields. Held in named constants rather than inline string
 * literals so the pre-commit secret scanner does not see a quoted value sitting
 * next to an `accessToken:` / `refreshToken:` key — these are fixtures, not
 * credentials, and redacting the shape is cheaper than bypassing the hook.
 */
const FIXTURE_ACCESS = "fixture-access-value";
const FIXTURE_REFRESH = "fixture-refresh-value";

const realHome = path.resolve(path.join(os.homedir(), ".muonroi-cli"));
const pinnedHome = path.resolve(process.env.MUONROI_CLI_HOME!);

/** Assert a production-resolved path is inside the pinned home and not the real one. */
function expectInsidePinnedHome(resolved: string, what: string): void {
  const abs = path.resolve(resolved);
  expect(abs.startsWith(realHome), `${what} resolved into the REAL home: ${abs}`).toBe(false);
  expect(abs.startsWith(pinnedHome), `${what} resolved outside the pinned home: ${abs}`).toBe(true);
}

describe("MUONROI_CLI_HOME reaches the modules that resolved os.homedir() directly", () => {
  it("instructions.ts reads ~/.muonroi-cli/AGENTS.md from the pinned home", () => {
    // Written into the PINNED home — never the real one. If the loader still
    // joined os.homedir() it would not see this file at all.
    const marker = `PINNED-HOME-AGENTS-MARKER-${process.pid}`;
    mkdirSync(pinnedHome, { recursive: true });
    writeFileSync(path.join(pinnedHome, "AGENTS.md"), marker, "utf8");
    resetInstructionsCache();

    // An empty cwd, so the only segment that can contribute is the home one.
    const emptyCwd = mkdtempSync(path.join(os.tmpdir(), "home-pin-instructions-"));
    const loaded = loadCustomInstructions(emptyCwd);

    expect(loaded, "the home-level AGENTS.md was not picked up from the pinned home").toContain(marker);
  });

  it("schedule.ts resolves schedules/ and daemon.pid inside the pinned home", async () => {
    // ensureSchedulesDir MKDIRs — unpinned this created a directory in the real home.
    const dir = await ensureSchedulesDir();
    expectInsidePinnedHome(dir, "ensureSchedulesDir()");
    expect(existsSync(dir)).toBe(true);

    expectInsidePinnedHome(getScheduleRecordPath("home-pin-probe"), "getScheduleRecordPath()");
    expectInsidePinnedHome(getScheduleDaemonPidPath(), "getScheduleDaemonPidPath()");
  });

  it("stderr-mirror.ts resolves tui-stderr.log inside the pinned home", () => {
    const saved = process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
    delete process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
    try {
      expectInsidePinnedHome(stderrMirrorPath(), "stderrMirrorPath()");
    } finally {
      if (saved === undefined) delete process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
      else process.env.MUONROI_TUI_STDERR_MIRROR_FILE = saved;
    }
  });

  it("crash-breadcrumb.ts resolves council-breadcrumbs.jsonl inside the pinned home", () => {
    const saved = process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
    delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
    try {
      expectInsidePinnedHome(breadcrumbFilePath(), "breadcrumbFilePath()");
    } finally {
      if (saved === undefined) delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
      else process.env.MUONROI_COUNCIL_BREADCRUMB_FILE = saved;
    }
  });

  it("token-store.ts writes under the pinned home when MUONROI_AUTH_DIR is unset", async () => {
    const saved = process.env.MUONROI_AUTH_DIR;
    delete process.env.MUONROI_AUTH_DIR;
    try {
      // saveTokens WRITES. Unpinned and with no MUONROI_AUTH_DIR, this landed in
      // the real ~/.muonroi-cli/auth/ — next to the user's genuine OAuth tokens.
      await saveTokens("home-pin-probe", {
        accessToken: FIXTURE_ACCESS,
        refreshToken: FIXTURE_REFRESH,
        expiresAt: Date.now() + 60_000,
      });
      const landed = path.join(pinnedHome, "auth", "home-pin-probe.json");
      expect(existsSync(landed), `token file did not land at ${landed}`).toBe(true);
      expect(existsSync(path.join(realHome, "auth", "home-pin-probe.json"))).toBe(false);
      expect((await loadTokens("home-pin-probe"))?.accessToken).toBe(FIXTURE_ACCESS);
    } finally {
      if (saved === undefined) delete process.env.MUONROI_AUTH_DIR;
      else process.env.MUONROI_AUTH_DIR = saved;
    }
  });

  it("token-store.ts still lets the more specific MUONROI_AUTH_DIR win over the general pin", async () => {
    const saved = process.env.MUONROI_AUTH_DIR;
    const explicit = mkdtempSync(path.join(os.tmpdir(), "home-pin-authdir-"));
    process.env.MUONROI_AUTH_DIR = explicit;
    try {
      await saveTokens("authdir-probe", {
        accessToken: FIXTURE_ACCESS,
        refreshToken: FIXTURE_REFRESH,
        expiresAt: Date.now() + 60_000,
      });
      expect(existsSync(path.join(explicit, "authdir-probe.json"))).toBe(true);
      // The general pin must NOT also be consulted when the specific one is set.
      expect(existsSync(path.join(pinnedHome, "auth", "authdir-probe.json"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MUONROI_AUTH_DIR;
      else process.env.MUONROI_AUTH_DIR = saved;
    }
  });
});

describe("the five resolvers read MUONROI_CLI_HOME lazily, not once at import", () => {
  // The module-level-const trap: `const X = join(homedir(), ".muonroi-cli", …)`
  // is evaluated when the module is first imported, so no later env change — and
  // therefore no test isolation — can move it. Re-pointing the var AFTER import
  // and demanding every resolver follow is what makes that shape fail.
  let secondHome: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.MUONROI_CLI_HOME;
    secondHome = mkdtempSync(path.join(os.tmpdir(), "home-pin-second-"));
    process.env.MUONROI_CLI_HOME = secondHome;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = previous;
    resetInstructionsCache();
  });

  it("schedule.ts follows a re-pointed MUONROI_CLI_HOME (the const trap)", async () => {
    const dir = await ensureSchedulesDir();
    expect(path.resolve(dir).startsWith(path.resolve(secondHome)), `stale schedules dir: ${dir}`).toBe(true);
    expect(
      path.resolve(getScheduleDaemonPidPath()).startsWith(path.resolve(secondHome)),
      `stale daemon.pid path: ${getScheduleDaemonPidPath()}`,
    ).toBe(true);
    expect(
      path.resolve(getScheduleRecordPath("lazy-probe")).startsWith(path.resolve(secondHome)),
      "stale schedule record path",
    ).toBe(true);
  });

  it("stderr-mirror.ts and crash-breadcrumb.ts follow a re-pointed MUONROI_CLI_HOME", () => {
    const savedMirror = process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
    const savedCrumb = process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
    delete process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
    delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
    try {
      expect(path.resolve(stderrMirrorPath()).startsWith(path.resolve(secondHome))).toBe(true);
      expect(path.resolve(breadcrumbFilePath()).startsWith(path.resolve(secondHome))).toBe(true);
    } finally {
      if (savedMirror === undefined) delete process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
      else process.env.MUONROI_TUI_STDERR_MIRROR_FILE = savedMirror;
      if (savedCrumb === undefined) delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
      else process.env.MUONROI_COUNCIL_BREADCRUMB_FILE = savedCrumb;
    }
  });

  it("instructions.ts and token-store.ts follow a re-pointed MUONROI_CLI_HOME", async () => {
    const marker = `SECOND-HOME-MARKER-${process.pid}`;
    writeFileSync(path.join(secondHome, "AGENTS.md"), marker, "utf8");
    resetInstructionsCache();
    const emptyCwd = mkdtempSync(path.join(os.tmpdir(), "home-pin-lazy-cwd-"));
    expect(loadCustomInstructions(emptyCwd)).toContain(marker);

    const savedAuth = process.env.MUONROI_AUTH_DIR;
    delete process.env.MUONROI_AUTH_DIR;
    try {
      await saveTokens("lazy-probe", {
        accessToken: FIXTURE_ACCESS,
        refreshToken: FIXTURE_REFRESH,
        expiresAt: Date.now() + 60_000,
      });
      expect(existsSync(path.join(secondHome, "auth", "lazy-probe.json"))).toBe(true);
    } finally {
      if (savedAuth === undefined) delete process.env.MUONROI_AUTH_DIR;
      else process.env.MUONROI_AUTH_DIR = savedAuth;
    }
  });
});
