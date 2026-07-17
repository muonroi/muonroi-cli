/**
 * Regression guard for the argument-order drift that shipped a broken /compact.
 *
 * Commit e2100fb7 dropped deliberateCompact's `provider` parameter but left the
 * two TUI call sites passing it. Both live in @ts-nocheck files, so tsc saw
 * nothing; at runtime modelId became a provider OBJECT, resolveModelRuntime
 * threw "idOrAlias.lastIndexOf is not a function", compressChat caught it, and
 * /compact silently degraded to truncation while reporting success.
 *
 * The guard must throw — a silent degrade is what made this invisible.
 */
import { describe, expect, it } from "vitest";
import { deliberateCompact } from "../index.js";

describe("deliberateCompact modelId guard", () => {
  it("rejects a non-string modelId instead of silently falling back to truncation", async () => {
    const providerObject = { generate: () => {} } as unknown as string;
    await expect(deliberateCompact("/tmp/flow", [], "", 4096, providerObject)).rejects.toThrow(
      /modelId must be a model id string/,
    );
  });

  it("names the real fix in the message so the next reader goes to the call site", async () => {
    await expect(deliberateCompact("/tmp/flow", [], "", 4096, {} as unknown as string)).rejects.toThrow(
      /argument order at the call site/,
    );
  });
});
