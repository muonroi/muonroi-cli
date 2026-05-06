/**
 * Global vitest setup: mock bun:sqlite which is unavailable outside the Bun runtime.
 * Any module that transitively imports db.ts will resolve to this stub.
 */
import { vi } from "vitest";

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
