/**
 * Tests for P3.1 computeFailureSignature and P3.2 load/save VerifyFailureSignatures.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeFailureSignature,
  loadVerifyFailureSignatures,
  saveVerifyFailureSignatures,
  type VerifyFailureRecord,
  type VerifyFailureSignatures,
} from "../verify-failure-tracking.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let flowDir: string;
const runId = "run-test-vfs";

beforeEach(async () => {
  flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "vfs-test-"));
});

afterEach(async () => {
  await fs.rm(flowDir, { recursive: true, force: true });
});

// ── P3.1: computeFailureSignature ────────────────────────────────────────────

describe("computeFailureSignature", () => {
  const base = {
    errorMessage:
      "TypeError: Cannot read property 'x' of undefined\n    at doThing (src/foo.ts:42:7)\n    at runAll (src/bar.ts:10:3)",
    verifyCommand: "bun test",
    fileTouched: "src/foo.ts",
  };

  it("1. same inputs → same sig", () => {
    expect(computeFailureSignature(base)).toBe(computeFailureSignature(base));
  });

  it("2. different error → different sig", () => {
    const other = { ...base, errorMessage: "SyntaxError: Unexpected token" };
    expect(computeFailureSignature(base)).not.toBe(computeFailureSignature(other));
  });

  it("3. different verifyCommand → different sig", () => {
    const other = { ...base, verifyCommand: "npm test" };
    expect(computeFailureSignature(base)).not.toBe(computeFailureSignature(other));
  });

  it("4. different fileTouched → different sig", () => {
    const other = { ...base, fileTouched: "src/bar.ts" };
    expect(computeFailureSignature(base)).not.toBe(computeFailureSignature(other));
  });

  it("5. error with 2 stack frames: different middle text → same sig (frames are dominant)", () => {
    const a = {
      ...base,
      errorMessage: "TypeError: blah\n    at doThing (src/foo.ts:42:7)\n    at runAll (src/bar.ts:10:3)",
    };
    const b = {
      ...base,
      errorMessage:
        "RangeError: something completely different\n    at doThing (src/foo.ts:42:7)\n    at runAll (src/bar.ts:10:3)",
    };
    expect(computeFailureSignature(a)).toBe(computeFailureSignature(b));
  });

  it("6. error with NO stack frame → still produces a stable sig", () => {
    const plain = {
      ...base,
      errorMessage: "Process exited with code 1",
    };
    const sig1 = computeFailureSignature(plain);
    const sig2 = computeFailureSignature(plain);
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(16);
    expect(sig1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns exactly 16 hex chars", () => {
    const sig = computeFailureSignature(base);
    expect(sig).toHaveLength(16);
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── P3.2: loadVerifyFailureSignatures / saveVerifyFailureSignatures ───────────

describe("loadVerifyFailureSignatures / saveVerifyFailureSignatures", () => {
  function makeRecord(count = 1): VerifyFailureRecord {
    return {
      count,
      lastSeenAt: new Date().toISOString(),
      lastError: "test error",
      file: "src/foo.ts",
    };
  }

  it("7. save then load → roundtrip preserved", { retry: 2 }, async () => {
    const sigs: VerifyFailureSignatures = {
      abc123: makeRecord(3),
      def456: makeRecord(1),
    };
    await saveVerifyFailureSignatures(flowDir, runId, sigs);
    const loaded = await loadVerifyFailureSignatures(flowDir, runId);
    expect(loaded).toEqual(sigs);
  });

  it("8. load when state.md missing → returns {}", async () => {
    const loaded = await loadVerifyFailureSignatures(flowDir, runId);
    expect(loaded).toEqual({});
  });

  it("9. load when section corrupted (invalid JSON) → returns {} fail-open", async () => {
    // Write a state.md with a corrupted section
    const runDir = path.join(flowDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    const content = "## Verify Failure Signatures\n\nnot { valid json }\n";
    await fs.writeFile(path.join(runDir, "state.md"), content, "utf8");

    const loaded = await loadVerifyFailureSignatures(flowDir, runId);
    expect(loaded).toEqual({});
  });

  it("10. save twice updates same section, no duplication", async () => {
    const first: VerifyFailureSignatures = { aaa: makeRecord(1) };
    await saveVerifyFailureSignatures(flowDir, runId, first);

    const second: VerifyFailureSignatures = { aaa: makeRecord(2), bbb: makeRecord(1) };
    await saveVerifyFailureSignatures(flowDir, runId, second);

    const loaded = await loadVerifyFailureSignatures(flowDir, runId);
    expect(loaded).toEqual(second);

    // Confirm the section appears exactly once in the raw file
    const runDir = path.join(flowDir, "runs", runId);
    const raw = await fs.readFile(path.join(runDir, "state.md"), "utf8");
    const sectionMatches = raw.match(/## Verify Failure Signatures/g);
    expect(sectionMatches).toHaveLength(1);
  });

  it("load when section is empty string → returns {}", async () => {
    const runDir = path.join(flowDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    const content = "## Verify Failure Signatures\n\n\n";
    await fs.writeFile(path.join(runDir, "state.md"), content, "utf8");
    const loaded = await loadVerifyFailureSignatures(flowDir, runId);
    expect(loaded).toEqual({});
  });
});
