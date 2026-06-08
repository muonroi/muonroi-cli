#!/usr/bin/env node
/**
 * fix-extensions.cjs — post-tsc codemod that appends ".js" to extension-less
 * relative imports in the emitted JS files so the bundle runs on bare Node ESM
 * (which is strict about extensions). Bun's loader tolerates the missing
 * extensions so we accept them in source.
 *
 * Rules:
 *   - Only relative specifiers (./ or ../) get rewritten. Bare package
 *     specifiers are left alone.
 *   - Imports that already have an extension (.js, .json, .mjs, .cjs, .node)
 *     are skipped.
 *   - If the target resolves to a file → append ".js".
 *   - If the target resolves to a directory containing index.js → append
 *     "/index.js".
 *   - Both static (`from "..."` / `export ... from "..."`) and dynamic
 *     (`import("...")`) forms are handled.
 *   - The same rules are applied to .d.ts files so type consumers also work.
 *
 * Invoked from package.json scripts.build after tsc.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

if (!fs.existsSync(DIST)) {
  console.error(`[fix-extensions] dist/ not found — run tsc first.`);
  process.exit(1);
}

// Regex captures:
//   group 1: leading keyword + opening quote (e.g. `from "`)
//   group 2: the specifier
//   group 3: closing quote
//
// Refined to avoid matching inside comments (naive same-line check).
const STATIC_RE = /(\b(?:from|import)\s+['"])(\.\.?\/[^'"]+)(['"])/g;
const DYNAMIC_RE = /(\bimport\s*\(\s*['"])(\.\.?\/[^'"]+)(['"]\s*\))/g;

const SKIP_EXTS = new Set([".js", ".mjs", ".cjs", ".json", ".node", ".wasm"]);

let filesScanned = 0;
let importsRewritten = 0;
let unresolved = 0;

function rewriteSpecifier(spec, fromFile, offset, fullText) {
  // Naive comment check: skip if preceded by // on the same line.
  const lineStart = fullText.lastIndexOf("\n", offset) + 1;
  const linePrefix = fullText.slice(lineStart, offset);
  if (linePrefix.trim().startsWith("//")) return spec;

  const ext = path.extname(spec);
  if (SKIP_EXTS.has(ext)) return spec;

  const baseDir = path.dirname(fromFile);
  const absTarget = path.resolve(baseDir, spec);

  // Case A: <target>.js exists
  if (fs.existsSync(`${absTarget}.js`)) {
    importsRewritten++;
    return `${spec}.js`;
  }
  // Case B: <target>/index.js exists (directory import)
  if (fs.existsSync(path.join(absTarget, "index.js"))) {
    importsRewritten++;
    return `${spec}/index.js`;
  }
  // Case C: <target>.mjs (rare but valid)
  if (fs.existsSync(`${absTarget}.mjs`)) {
    importsRewritten++;
    return `${spec}.mjs`;
  }
  // Case D: target is already a real file (e.g. .json) — caller's responsibility
  if (fs.existsSync(absTarget) && fs.statSync(absTarget).isFile()) {
    return spec;
  }
  // Couldn't resolve — leave alone but warn.
  unresolved++;
  if (unresolved <= 10) {
    console.warn(`  [warn] unresolved relative import "${spec}" in ${path.relative(ROOT, fromFile)}`);
  }
  return spec;
}

function processFile(file) {
  const original = fs.readFileSync(file, "utf8");
  let out = original;
  out = out.replace(
    STATIC_RE,
    (_, pre, spec, post, offset) => `${pre}${rewriteSpecifier(spec, file, offset, original)}${post}`,
  );
  out = out.replace(
    DYNAMIC_RE,
    (_, pre, spec, post, offset) => `${pre}${rewriteSpecifier(spec, file, offset, original)}${post}`,
  );
  if (out !== original) fs.writeFileSync(file, out, "utf8");
  filesScanned++;
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
      processFile(full);
    }
  }
}

walk(DIST);
console.log(
  `  [fix-extensions] scanned ${filesScanned} file(s), rewrote ${importsRewritten} import(s)` +
    (unresolved > 0 ? `, ${unresolved} unresolved (see warnings)` : ""),
);
