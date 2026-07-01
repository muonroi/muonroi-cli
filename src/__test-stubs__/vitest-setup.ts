/**
 * Global vitest setup: mock bun:sqlite which is unavailable outside the Bun runtime.
 * Any module that transitively imports db.ts will resolve to this stub.
 */
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
