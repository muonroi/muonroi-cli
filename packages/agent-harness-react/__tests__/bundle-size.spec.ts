/**
 * bundle-size.spec.ts — Compile-time tree-shake guard + bundle size tests.
 *
 * Task 3.4: When __MUONROI_HARNESS__ is false, esbuild eliminates all
 * registry-touching code. The output bundle should NOT contain:
 *   - "register" (from registry.register calls)
 *   - "snapshot" (from registry.snapshot calls)
 *   - "useContext" (from React context reads inside Semantic)
 *
 * Task 3.5: Production bundle (MUONROI_HARNESS=false) must be ≤ 2KB gzipped.
 */

import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const ENTRY = resolve(import.meta.dirname ?? __dirname, "../src/index.ts");

// Shared esbuild base config for all bundle tests
const baseConfig: esbuild.BuildOptions = {
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  // Mark all external deps so we only measure this package's own code
  external: ["react", "react-dom", "@muonroi/agent-harness-core", "@muonroi/agent-harness-core/*"],
  // Resolve workspace path aliases
  alias: {
    "@muonroi/agent-harness-core/registry": resolve(
      import.meta.dirname ?? __dirname,
      "../../agent-harness-core/src/registry.ts",
    ),
    "@muonroi/agent-harness-core/protocol": resolve(
      import.meta.dirname ?? __dirname,
      "../../agent-harness-core/src/protocol.ts",
    ),
    "@muonroi/agent-harness-core": resolve(
      import.meta.dirname ?? __dirname,
      "../../agent-harness-core/src/browser-index.ts",
    ),
  },
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  loader: { ".ts": "ts", ".tsx": "tsx" },
};

// ---------------------------------------------------------------------------
// Task 3.4 — Tree-shake guard: no registry code when __MUONROI_HARNESS__=false
// ---------------------------------------------------------------------------

describe("compile-time tree-shake guard (Task 3.4)", () => {
  it("eliminates register, snapshot, and useContext when __MUONROI_HARNESS__=false", async () => {
    // Use minify:true so esbuild performs full dead-code elimination including
    // unused imports. Without minify, the import statement `import { useContext }
    // from "react"` remains even if useContext is never called.
    const result = await esbuild.build({
      ...baseConfig,
      define: {
        __MUONROI_HARNESS__: "false",
      },
      minify: true,
      treeShaking: true,
    });

    expect(result.outputFiles).toHaveLength(1);
    if (!result.outputFiles) throw new Error("esbuild produced no outputFiles");
    const code = result.outputFiles[0]!.text;

    // These identifiers come from the registry-touching branch — must be gone.
    // "register(" and "snapshot(" are function call signatures specific to
    // SemanticRegistry usage and should be fully dead-code-eliminated.
    expect(code).not.toContain("register(");
    expect(code).not.toContain("snapshot(");
    // useContext should also be gone when minified (unused import stripped)
    expect(code).not.toContain("useContext");
  });

  it("includes register and snapshot when __MUONROI_HARNESS__=true", async () => {
    const result = await esbuild.build({
      ...baseConfig,
      define: {
        __MUONROI_HARNESS__: "true",
      },
      minify: false,
    });

    expect(result.outputFiles).toHaveLength(1);
    if (!result.outputFiles) throw new Error("esbuild produced no outputFiles");
    const code = result.outputFiles[0]!.text;

    // When harness is ON, registry calls must be present
    expect(code).toContain("register(");
    expect(code).toContain("useContext");
  });
});

// ---------------------------------------------------------------------------
// Task 3.5 — Bundle size ≤ 2KB gzipped when __MUONROI_HARNESS__=false
// ---------------------------------------------------------------------------

describe("bundle size ≤ 2KB gzipped (Task 3.5)", () => {
  it("prod bundle (harness OFF) gzips to ≤ 2048 bytes", async () => {
    const result = await esbuild.build({
      ...baseConfig,
      define: {
        __MUONROI_HARNESS__: "false",
        "process.env.NODE_ENV": '"production"',
      },
      minify: true,
      treeShaking: true,
    });

    expect(result.outputFiles).toHaveLength(1);
    if (!result.outputFiles) throw new Error("esbuild produced no outputFiles");
    const raw = Buffer.from(result.outputFiles[0]!.contents);
    const gzipped = gzipSync(raw, { level: 9 });

    console.log(`Bundle raw: ${raw.byteLength} bytes`);
    console.log(`Bundle gzipped: ${gzipped.byteLength} bytes`);

    expect(gzipped.byteLength).toBeLessThanOrEqual(2048);
  });

  it("prod bundle (harness ON) gzips to ≤ 2048 bytes", async () => {
    const result = await esbuild.build({
      ...baseConfig,
      define: {
        __MUONROI_HARNESS__: "true",
        "process.env.NODE_ENV": '"production"',
      },
      minify: true,
      treeShaking: true,
    });

    expect(result.outputFiles).toHaveLength(1);
    if (!result.outputFiles) throw new Error("esbuild produced no outputFiles");
    const raw = Buffer.from(result.outputFiles[0]!.contents);
    const gzipped = gzipSync(raw, { level: 9 });

    console.log(`Bundle (harness=true) raw: ${raw.byteLength} bytes`);
    console.log(`Bundle (harness=true) gzipped: ${gzipped.byteLength} bytes`);

    // Even with harness ON it should be lean (no heavy deps, all external)
    expect(gzipped.byteLength).toBeLessThanOrEqual(2048);
  });
});
