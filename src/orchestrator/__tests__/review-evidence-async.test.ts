import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sourceFingerprint } from "../review-evidence.js";

const control = vi.hoisted(() => ({
  hold: false,
  held: undefined as (() => void) | undefined,
  resume: undefined as (() => void) | undefined,
  error: undefined as Error | undefined,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const invoke = (file: string, args: string[], options: any, callback: any): any => {
    if (control.error) {
      const error = control.error;
      control.error = undefined;
      queueMicrotask(() => callback(error, "", ""));
      return {};
    }
    if (control.hold) {
      control.hold = false;
      control.resume = () => actual.execFile(file, args, options, callback);
      control.held?.();
      return {};
    }
    return actual.execFile(file, args, options, callback);
  };
  // Match Node's execFile custom promisification contract for the deferred
  // native call; once released it still runs actual Git against an owned repo.
  Object.defineProperty(invoke, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, args: string[], options: any) =>
      new Promise((resolve, reject) =>
        invoke(file, args, options, (error: any, stdout: string, stderr: string) => {
          if (error) {
            error.stderr = stderr;
            reject(error);
          } else resolve({ stdout, stderr });
        }),
      ),
  });
  return { ...actual, execFile: invoke };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "snapshot-async-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "source.ts"), "export const stable = true;");
});
afterEach(() => {
  control.hold = false;
  control.held = undefined;
  control.resume = undefined;
  control.error = undefined;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("lets host callbacks run while Git is pending and resumes the actual snapshot afterward", async () => {
  const held = new Promise<void>((resolve) => {
    control.held = resolve;
  });
  control.hold = true;
  const snapshot = sourceFingerprint(root);
  try {
    expect(await Promise.race([held.then(() => "pending-git"), snapshot.then(() => "snapshot-completed")])).toBe(
      "pending-git",
    );
    let hostHandledInput = false;
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        hostHandledInput = true;
        resolve();
      }),
    );
    expect(hostHandledInput).toBe(true);
    control.resume!();
    control.resume = undefined;
    expect(await snapshot).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    control.resume?.();
    control.resume = undefined;
    await snapshot.catch((error) => console.error("Deferred snapshot test cleanup:", error.message));
  }
});

it("still refuses a timed-out Git child with its code, signal and deadline", async () => {
  control.error = Object.assign(new Error("Timed out Git child"), { code: "ETIMEDOUT", signal: "SIGTERM" });
  await expect(sourceFingerprint(root)).rejects.toThrow(
    /code=ETIMEDOUT;.*signal=SIGTERM;.*elapsedMs=\d+; timeoutMs=10000/,
  );
});
