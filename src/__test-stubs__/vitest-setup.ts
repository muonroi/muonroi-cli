/**
 * Global vitest setup: mock bun:sqlite which is unavailable outside the Bun runtime.
 * Any module that transitively imports db.ts will resolve to this stub.
 */
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { vi } from "vitest";

// vitest 2+ removed vi.mocked(). This shim restores it for the 93+ call sites across the
// codebase without a codemod. Safe no-op: vi.mocked(item) just returns item (typed cast).
// @ts-expect-error — vi.mocked is intentionally absent from vitest 4 types.
vi.mocked ??= ((item, _options) => item) as any;

// Polyfill vi.doMock, vi.doUnmock and vi.importActual for Bun test runner
vi.doMock ??= vi.mock as any;
vi.doUnmock ??= (() => vi) as any;
vi.importActual ??= ((moduleName: string) => import(moduleName)) as any;

declare const Bun: any;

const originalGlobals = new Map<any, any>();
vi.stubGlobal ??= (key: any, value: any) => {
  if (!originalGlobals.has(key)) {
    originalGlobals.set(key, (globalThis as any)[key]);
  }
  (globalThis as any)[key] = value;
  return vi;
};
vi.unstubAllGlobals ??= () => {
  for (const [key, value] of originalGlobals.entries()) {
    (globalThis as any)[key] = value;
  }
  originalGlobals.clear();
  return vi;
};

const originalEnvs = new Map<string, string | undefined>();
vi.stubEnv ??= (key: any, value: any) => {
  if (!originalEnvs.has(key)) {
    originalEnvs.set(key, process.env[key]);
  }
  process.env[key] = value;
  return vi;
};
vi.unstubAllEnvs ??= () => {
  for (const [key, value] of originalEnvs.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvs.clear();
  return vi;
};

// @opentui/react is a pre-bundled CJS package that requires 'react-reconciler/constants'
// without the .js extension — this fails in the vitest ESM environment. None of the unit
// tests exercise OpenTUI hooks directly (those are covered by E2E harness specs), so mocking
// the package here prevents the resolution error from propagating through the
// @muonroi/agent-harness-opentui barrel export (which includes input-bridge.tsx).
vi.mock("@opentui/react", () => ({
  useAppContext: () => ({ keyHandler: undefined }),
  useKeyboard: () => undefined,
  useRenderer: () => undefined,
  useTerminalDimensions: () => ({ width: 120, height: 40 }),
}));

// Give the PIL pipeline a generous timeout in test environments so the 200ms
// fast-path race does not fire prematurely when running the full 1600+ test
// suite under load. Tests that explicitly test the timeout path use fake timers
// or import resolveAfter directly, so they are unaffected by this env var.
process.env.MUONROI_TEST_PIPELINE_TIMEOUT_MS = "5000";

// The verify floor's baseline witness lives outside the project tree, which by
// default means the developer's real `~/.muonroi-cli/floor-baselines/`. Every
// test calling `captureVerifyFloorBaseline` would write there — measured: four
// stray records from one run, and one of them leaked a previous test's baseline
// into a later test's verdict, because run ids repeat across test files. Pin the
// directory into the OS temp dir for the whole suite so no test can reach the
// real home, whether or not it remembers to pass `witnessPath`.
process.env.MUONROI_FLOOR_BASELINE_DIR ??= nodePath.join(
  nodeOs.tmpdir(),
  `muonroi-test-floor-baselines-${process.pid}`,
);

// Same reasoning, one level up: pin the WHOLE muonroi home for the suite.
//
// ~16 modules resolve their storage root as `MUONROI_CLI_HOME ?? homedir() +
// "/.muonroi-cli"` — config, session-dir, usage/{ledger,cost-log,decision-log,
// product-ledger}, pil/budget-log, chat/channel-manager, lsp/npm-cache,
// storage/usage-cap, product-loop/stakeholder-acl, reporter/auto-fire and the
// cli/{usage-report,share-cmd,reporter-cmd} commands. Unpinned, every test that
// touches one of them reads and WRITES the developer's real home.
//
// This is not theoretical damage. A test created package directories under the
// real `~/.muonroi-cli/cache/lsp/` and its cleanup then `rm -rf`'d them, which
// deleted the user's actual pyright install down to a bin-less `dist/` stump —
// and the half-finished recursive delete blew the 10s hook budget, so every
// later run re-broke it (`src/lsp/npm-cache.ts:20-28` records it). Pinning the
// root makes that entire class impossible instead of fixing it one test file at
// a time; the per-file `process.env.MUONROI_CLI_HOME = tmpHome` dances (see
// npm-cache.test.ts:49-53, chat/__tests__/channel-manager.test.ts:27-28,
// cli/__tests__/share-cmd.test.ts:29-30) keep working and simply override a
// temp dir with another temp dir.
//
// `??=`, matching the pin above: an explicitly exported MUONROI_CLI_HOME still
// wins, so a developer can still aim the suite somewhere deliberately.
//
// LIMIT, deliberately not papered over: this only redirects code that CONSULTS
// the env var. These resolve `os.homedir()` directly and are NOT pinned —
//   src/utils/instructions.ts:79      (~/.muonroi-cli/AGENTS.md)
//   src/tools/schedule.ts:7-8         (schedules/, daemon.pid)
//   src/utils/stderr-mirror.ts:79     (tui-stderr.log)
//   src/council/…  breadcrumbFilePath (council-breadcrumbs.jsonl)
//   src/providers/auth/token-store.ts:21 (has its own MUONROI_AUTH_DIR escape)
// Their existing tests are safe because each mocks `os.homedir()` per file, and
// that is also why adding this pin did not change their behaviour — measured,
// all four stayed green. A NEW test touching one of them without mocking
// homedir would still reach the real home. `schedule.ts` is the awkward one: its
// paths are module-level `const`s evaluated at import, so an env var alone could
// not redirect it even if one were added — the same trap `npm-cache.ts:20-28`
// records. Converting these to the shared convention is a separate change.
process.env.MUONROI_CLI_HOME ??= nodePath.join(nodeOs.tmpdir(), `muonroi-test-home-${process.pid}`);
// Create it: the modules above mkdir their own subpaths, but a bare read of a
// missing root is a needless difference from a real home that already exists.
try {
  nodeFs.mkdirSync(process.env.MUONROI_CLI_HOME, { recursive: true });
} catch (err) {
  console.error(
    `[vitest-setup] could not create the pinned MUONROI_CLI_HOME ${process.env.MUONROI_CLI_HOME}: ` +
      `${err instanceof Error ? err.message : String(err)} — tests that write there will fail loudly rather than silently reaching the real home`,
  );
}

if (typeof Bun === "undefined") {
  vi.mock("bun:sqlite", () => {
    const mockRun = vi.fn();
    const mockGet = vi.fn();
    const mockAll = vi.fn().mockReturnValue([]);
    const mockPrepare = vi.fn().mockReturnValue({ run: mockRun, get: mockGet, all: mockAll });
    class Database {
      prepare = mockPrepare;
      query = mockPrepare;
      exec = vi.fn();
      run = vi.fn();
      close = vi.fn();
    }
    return { Database };
  });
}
