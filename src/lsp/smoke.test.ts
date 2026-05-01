import { execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLspClientSession } from "./client.js";

let tsServerAvailable = false;
let tmpDir = "";

beforeAll(() => {
  // Check if typescript-language-server is available
  try {
    execSync("bunx typescript-language-server --version", { timeout: 5000, stdio: "pipe" });
    tsServerAvailable = true;
  } catch {
    tsServerAvailable = false;
  }

  // Create temp directory with a minimal TypeScript project
  tmpDir = path.join(os.tmpdir(), `lsp-smoke-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  writeFileSync(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
    "utf8",
  );

  writeFileSync(path.join(tmpDir, "test.ts"), "const x: number = 1;\n", "utf8");
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

describe("LSP smoke test — createLspClientSession", () => {
  it("initializes LSP session with typescript-language-server", { timeout: 30000 }, async () => {
    if (!tsServerAvailable) {
      console.warn("typescript-language-server not available — skipping LSP session smoke test");
      return;
    }

    const session = await createLspClientSession({
      serverId: "ts-smoke",
      root: tmpDir,
      launch: { command: "bunx", args: ["typescript-language-server", "--stdio"] },
      startupTimeoutMs: 15000,
      diagnosticsDebounceMs: 500,
    });

    expect(session.serverId).toBe("ts-smoke");

    await session.openOrChangeFile(path.join(tmpDir, "test.ts"), "typescript", "const x: number = 1;");

    await session.stop();
  });

  it("createLspClientSession rejects for non-existent command", { timeout: 10000 }, async () => {
    await expect(
      createLspClientSession({
        serverId: "bad",
        root: os.tmpdir(),
        launch: { command: "nonexistent-lsp-binary-xyz" },
        startupTimeoutMs: 2000,
        diagnosticsDebounceMs: 500,
      }),
    ).rejects.toThrow();
  });
});
