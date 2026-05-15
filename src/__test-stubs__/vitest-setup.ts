/**
 * Global vitest setup: mock bun:sqlite which is unavailable outside the Bun runtime.
 * Any module that transitively imports db.ts will resolve to this stub.
 */
import { vi } from "vitest";

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

vi.mock("bun:sqlite", () => {
  const mockRun = vi.fn();
  const mockGet = vi.fn();
  const mockAll = vi.fn().mockReturnValue([]);
  const mockPrepare = vi.fn().mockReturnValue({ run: mockRun, get: mockGet, all: mockAll });
  class Database {
    prepare = mockPrepare;
    exec = vi.fn();
    close = vi.fn();
  }
  return { Database };
});
