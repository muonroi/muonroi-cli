import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUnwrappedComponents } from "../src/lint.js";

// ---------------------------------------------------------------------------
// findUnwrappedComponents — unit tests using temp-dir fixtures
// ---------------------------------------------------------------------------

describe("findUnwrappedComponents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lint-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns only the unwrapped file when 1 wrapped + 1 unwrapped are present", async () => {
    writeFileSync(
      join(tmpDir, "wrapped.tsx"),
      `export default function Foo() { return <Semantic id="x" role="region"><div>hi</div></Semantic>; }`,
    );
    writeFileSync(join(tmpDir, "unwrapped.tsx"), `export default function Bar() { return <Box>raw</Box>; }`);

    const results = await findUnwrappedComponents({
      rootDir: tmpDir,
      patterns: ["*.tsx"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("unwrapped.tsx");
  });

  it("returns empty when the unwrapped file is in the allowlist", async () => {
    writeFileSync(
      join(tmpDir, "wrapped.tsx"),
      `export default function Foo() { return <Semantic id="x" role="region"><div>hi</div></Semantic>; }`,
    );
    writeFileSync(join(tmpDir, "unwrapped.tsx"), `export default function Bar() { return <Box>raw</Box>; }`);

    // Write an allowlist that suppresses unwrapped.tsx
    const allowlistPath = join(tmpDir, "allow.txt");
    writeFileSync(allowlistPath, "unwrapped.tsx\n");

    const results = await findUnwrappedComponents({
      rootDir: tmpDir,
      patterns: ["*.tsx"],
      allowlistPath,
    });

    expect(results).toHaveLength(0);
  });
});
