/**
 * Unit tests for pickBackendStackFromDetection — the rule that decides
 * whether detection signals are strong enough to skip the backendStack
 * interview question (returning a synthesized answer) vs ambiguous enough
 * that we should ask the user.
 *
 * Original implementation just took `languages[0]` which was arbitrary
 * for polyglot repos (TS + Python → "TypeScript" wins by alphabetical
 * walk order, never asking the user about the actual change target).
 */

import { describe, expect, it } from "vitest";
import { pickBackendStackFromDetection } from "../gather.js";
import type { ExistingProjectSignals, ManifestDetection } from "../types.js";

function manifest(over: Partial<ManifestDetection> = {}): ManifestDetection {
  return {
    file: "package.json",
    type: "package.json",
    weight: 1,
    inferredLang: "TypeScript",
    inferredFrameworks: [],
    ...over,
  };
}

function detection(over: Partial<ExistingProjectSignals> = {}): ExistingProjectSignals {
  return {
    isGitRepo: true,
    hasCommitHistory: true,
    srcFileCount: 50,
    manifests: [],
    languages: [],
    frameworks: [],
    classification: "existing",
    ...over,
  };
}

describe("pickBackendStackFromDetection", () => {
  it("existing + single manifest → uses manifest.inferredLang + first framework", () => {
    const out = pickBackendStackFromDetection(
      detection({
        manifests: [manifest({ inferredLang: "TypeScript", inferredFrameworks: ["react", "vite"] })],
        languages: ["TypeScript"],
        frameworks: ["react", "vite"],
      }),
    );
    expect(out).toEqual({ language: "TypeScript", framework: "react" });
  });

  it("existing + single manifest with no frameworks → renders (none detected)", () => {
    const out = pickBackendStackFromDetection(
      detection({
        manifests: [manifest({ inferredLang: "Rust", inferredFrameworks: [] })],
        languages: ["Rust"],
      }),
    );
    expect(out).toEqual({ language: "Rust", framework: "(none detected)" });
  });

  it("ambiguous + exactly one language → uses it, no framework", () => {
    const out = pickBackendStackFromDetection(
      detection({
        classification: "ambiguous",
        manifests: [],
        languages: ["Go"],
      }),
    );
    expect(out).toEqual({ language: "Go", framework: "(none detected)" });
  });

  it("ambiguous + polyglot (regression — was picking [0] arbitrarily) → returns null", () => {
    const out = pickBackendStackFromDetection(
      detection({
        classification: "ambiguous",
        manifests: [
          manifest({ inferredLang: "TypeScript" }),
          manifest({ file: "pyproject.toml", type: "pyproject.toml", inferredLang: "Python" }),
        ],
        languages: ["TypeScript", "Python"],
      }),
    );
    expect(out).toBeNull();
  });

  it("ambiguous + zero languages → returns null", () => {
    const out = pickBackendStackFromDetection(detection({ classification: "ambiguous", manifests: [], languages: [] }));
    expect(out).toBeNull();
  });

  it("existing + multiple manifests should never happen (classify forces ambiguous) but is null-safe", () => {
    // Defensive: classify() would mark this ambiguous, but if a future caller
    // ever passes "existing" with multiple manifests, pick should NOT crash —
    // it should bail out cleanly.
    const out = pickBackendStackFromDetection(
      detection({
        classification: "existing",
        manifests: [manifest(), manifest({ file: "Cargo.toml", type: "Cargo.toml", inferredLang: "Rust" })],
        languages: ["TypeScript", "Rust"],
      }),
    );
    expect(out).toBeNull();
  });

  it("greenfield → returns null (no signal to use)", () => {
    const out = pickBackendStackFromDetection(
      detection({
        classification: "greenfield",
        manifests: [],
        languages: [],
        srcFileCount: 0,
      }),
    );
    expect(out).toBeNull();
  });
});
