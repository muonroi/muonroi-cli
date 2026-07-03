import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInteractiveWithoutSemantic, findUnwrappedComponents } from "../src/lint.js";

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

// ---------------------------------------------------------------------------
// findInteractiveWithoutSemantic — flags interactive components with no
// semantic wrapper reference.
// ---------------------------------------------------------------------------

describe("findInteractiveWithoutSemantic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lint-int-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags a component that wires onSubmit but references no semantic wrapper", async () => {
    writeFileSync(
      join(tmpDir, "raw-input.tsx"),
      `export function RawInput() { return <textarea onSubmit={() => {}} />; }`,
    );

    const results = await findInteractiveWithoutSemantic({ rootDir: tmpDir, patterns: ["*.tsx"] });

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("raw-input.tsx");
    expect(results[0].marker).toBe("onSubmit");
  });

  it("does NOT flag when a raw <Semantic> is present", async () => {
    writeFileSync(
      join(tmpDir, "wrapped.tsx"),
      `export function Ok() { return <Semantic id="c" role="textbox"><textarea onSubmit={() => {}} /></Semantic>; }`,
    );

    const results = await findInteractiveWithoutSemantic({ rootDir: tmpDir, patterns: ["*.tsx"] });
    expect(results).toHaveLength(0);
  });

  it("does NOT flag when a primitives import is present", async () => {
    writeFileSync(
      join(tmpDir, "primitive.tsx"),
      `import { TextBox } from "../primitives/index.js";\nexport function Ok() { return <TextBox id="c"><textarea focused={true} /></TextBox>; }`,
    );

    const results = await findInteractiveWithoutSemantic({ rootDir: tmpDir, patterns: ["*.tsx"] });
    expect(results).toHaveLength(0);
  });

  it("does NOT flag a purely presentational component (no interactive props)", async () => {
    writeFileSync(join(tmpDir, "static.tsx"), `export function Label() { return <text>hi</text>; }`);

    const results = await findInteractiveWithoutSemantic({ rootDir: tmpDir, patterns: ["*.tsx"] });
    expect(results).toHaveLength(0);
  });

  it("respects the allowlist", async () => {
    writeFileSync(join(tmpDir, "raw.tsx"), `export function R() { return <input onClick={() => {}} />; }`);
    const allowlistPath = join(tmpDir, "allow.txt");
    writeFileSync(allowlistPath, "raw.tsx\n");

    const results = await findInteractiveWithoutSemantic({ rootDir: tmpDir, patterns: ["*.tsx"], allowlistPath });
    expect(results).toHaveLength(0);
  });
});
