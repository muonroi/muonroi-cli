/**
 * Static guard: no LSP test may provision a language server from the network.
 *
 * Why a source-level test rather than a behavioural one: the failure is a
 * *setup* action, so by the time a behavioural assertion could observe it the
 * download has already happened. The only way to keep it from happening is to
 * forbid the call site.
 *
 * The defect this pins, measured on `fad63746`:
 * `src/lsp/smoke.test.ts:26` called the INSTALLING probe
 * `lspNpmWhich("typescript-language-server", …)` from `beforeAll`, with no
 * `MUONROI_CLI_HOME` redirect (that env var is pinned per-file — see
 * `src/lsp/npm-cache.test.ts:49-53` — and NOT globally in
 * `src/__test-stubs__/vitest-setup.ts`). On a cold cache that reified the
 * package from registry.npmjs.org into the developer's real
 * `~/.muonroi-cli/cache/lsp/`. Both `it` bodies then early-returned under
 * `process.env.CI` (`:64`, `:86`), so a cold CI run paid for a network install
 * and asserted nothing.
 *
 * `src/lsp/smoke.test.ts:18-19` was a second, unnamed network path in the same
 * hook: `bunx typescript-language-server --version` auto-installs the package
 * when it is absent, and `typescript-language-server` is not a dependency of
 * this repo (`package.json` ships `typescript`, not the server).
 *
 * Two rules, checked over every test file under `src/lsp/`:
 *   1. A file that calls the installing `lspNpmWhich(` must redirect
 *      `MUONROI_CLI_HOME` first, so the install can never land in the real
 *      home. (`npm-cache.test.ts` satisfies this AND stubs Arborist.)
 *   2. No file may shell out to `bunx`/`bun x`, which resolves from the
 *      registry on a cold machine.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LSP_DIR = join(process.cwd(), "src", "lsp");

/**
 * Strip comments before matching.
 *
 * Without this the guard reads its own subject matter: the very file it polices
 * has to NAME `lspNpmWhich` and `bunx` in a comment to explain why they are
 * banned, and the rule would then fire on the explanation instead of the call.
 * Crude but sufficient for TypeScript test sources.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * This file is excluded from its own sweep.
 *
 * `stripComments` handles the prose, but the rules below are REGEX LITERALS
 * containing the very identifiers they ban, and those are code. Excluding the
 * file is the honest way out; the "finds the LSP test files it is supposed to
 * police" case below is what stops the sweep from silently degrading to empty.
 */
const SELF = "__tests__/no-network-install-in-tests.test.ts";

/** Every `*.test.ts` under src/lsp/, including the __tests__ subdirectory. */
function lspTestFiles(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.name.endsWith(".test.ts")) continue;
      if (rel === SELF) continue;
      out.push({ rel, src: stripComments(readFileSync(abs, "utf8")) });
    }
  };
  walk(LSP_DIR, "");
  return out;
}

describe("LSP tests must not provision a language server from the network", () => {
  const files = lspTestFiles();

  it("finds the LSP test files it is supposed to police", () => {
    // A zero-length sweep would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => f.rel)).toContain("smoke.test.ts");
  });

  it("only calls the installing lspNpmWhich() from a file that redirects MUONROI_CLI_HOME", () => {
    const offenders = files
      .filter((f) => /\blspNpmWhich\s*\(/.test(f.src))
      .filter((f) => !/process\.env\.MUONROI_CLI_HOME\s*=/.test(f.src))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  it("never resolves a binary through bunx, which installs from the registry", () => {
    const offenders = files.filter((f) => /\bbunx\b|\bbun\s+x\b/.test(f.src)).map((f) => f.rel);

    expect(offenders).toEqual([]);
  });
});
