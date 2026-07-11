import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveRunId } from "../../flow/run-manager.js";
import {
  __resetActiveRunStoreForTests,
  activeRunStore,
  clearWorkspaceFocus,
  setWorkspaceFocus,
} from "../active-run.js";

describe("workspace focus (F8 single writer)", () => {
  let flowDir: string;

  beforeEach(async () => {
    flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "focus-"));
    __resetActiveRunStoreForTests();
  });

  afterEach(async () => {
    __resetActiveRunStoreForTests();
    await fs.rm(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("setWorkspaceFocus writes the durable pointer AND the in-memory cache atomically", async () => {
    await setWorkspaceFocus(flowDir, { runId: "run-abc", productSlug: "my-app", reason: "test" });

    // durable: state.md Active Run
    expect(await getActiveRunId(flowDir)).toBe("run-abc");
    // cache: in-memory store
    expect(activeRunStore.getState()).toEqual({
      runId: "run-abc",
      flowDir,
      productSlug: "my-app",
    });
  });

  it("is idempotent — re-focusing the same run leaves disk + cache agreeing", async () => {
    await setWorkspaceFocus(flowDir, { runId: "run-xyz", productSlug: "app" });
    await setWorkspaceFocus(flowDir, { runId: "run-xyz", productSlug: "app" });
    expect(await getActiveRunId(flowDir)).toBe("run-xyz");
    expect(activeRunStore.getState().runId).toBe("run-xyz");
  });

  it("clearWorkspaceFocus clears the cache but leaves the durable pointer as a historical marker", async () => {
    await setWorkspaceFocus(flowDir, { runId: "run-ship", productSlug: "app" });
    clearWorkspaceFocus();

    // cache cleared
    expect(activeRunStore.getState()).toEqual({ runId: null, flowDir: null, productSlug: null });
    // durable pointer intact so /ideal phases still resolves the last run post-ship
    expect(await getActiveRunId(flowDir)).toBe("run-ship");
  });
});
