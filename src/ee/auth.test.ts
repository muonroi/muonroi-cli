import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getEmbeddingModelVersion, loadEEAuthToken, refreshAuthToken } from "./auth.js";

describe("loadEEAuthToken", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ee-auth-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it("returns token when ~/.experience/config.json exists", async () => {
    const dir = path.join(tmpHome, ".experience");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({
        authToken: "test-token-abc123",
        embeddingModelVersion: "nomic-embed-text-v1.5",
      }),
    );
    const token = await loadEEAuthToken({ home: tmpHome });
    expect(token).toBe("test-token-abc123");
  });

  it("returns null when ~/.experience/config.json is absent (no throw)", async () => {
    const token = await loadEEAuthToken({ home: tmpHome });
    expect(token).toBeNull();
  });

  it("sets embeddingModelVersion from config", async () => {
    const dir = path.join(tmpHome, ".experience");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({
        authToken: "tok",
        embeddingModelVersion: "custom-v2",
      }),
    );
    await loadEEAuthToken({ home: tmpHome });
    expect(getEmbeddingModelVersion()).toBe("custom-v2");
  });
});

describe("refreshAuthToken", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ee-auth-ref-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it("re-reads config.json and updates the cached value", async () => {
    const dir = path.join(tmpHome, ".experience");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ authToken: "old-token" }));
    const first = await loadEEAuthToken({ home: tmpHome });
    expect(first).toBe("old-token");

    // Write new token
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ authToken: "new-token" }));
    const second = await refreshAuthToken({ home: tmpHome });
    expect(second).toBe("new-token");
  });
});
