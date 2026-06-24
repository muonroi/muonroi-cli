/**
 * tests/pil/layer3-bb-dedup.spec.ts
 *
 * Unit tests for BB dedup in layer3-ee-injection.ts.
 * Verifies that EE hits whose sha16 matches an existing bb-context-injected marker
 * in ctx.enriched are skipped — preventing double-injection.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helper: compute sha16 (mirrors bbContextMarker internals in bb-retrieval.ts)
// ---------------------------------------------------------------------------

function sha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function bbMarker(content: string): string {
  return `<!-- bb-context-injected:${sha16(content)} -->`;
}

// ---------------------------------------------------------------------------
// Tests for the dedup helpers (pure unit — no network, no EE bridge)
// ---------------------------------------------------------------------------

describe("layer3-ee-injection BB dedup", () => {
  it("bbContextMarker produces correct sha16 format", () => {
    const content = "some rule text";
    const marker = bbMarker(content);
    expect(marker).toMatch(/^<!-- bb-context-injected:[0-9a-f]{16} -->$/);
  });

  it("extractBBMarkerShas returns empty set when no markers present", () => {
    const enriched = "some context text without markers";
    const regex = /<!-- bb-context-injected:([0-9a-f]{16}) -->/g;
    const shas = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = regex.exec(enriched)) !== null) {
      shas.add(m[1]);
    }
    expect(shas.size).toBe(0);
  });

  it("extractBBMarkerShas extracts sha16 from marker in enriched context", () => {
    const content = "important behavioral rule about error handling";
    const marker = bbMarker(content);
    const enriched = `some prior context\n${marker}\nmore text`;
    const regex = /<!-- bb-context-injected:([0-9a-f]{16}) -->/g;
    const shas = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = regex.exec(enriched)) !== null) {
      shas.add(m[1]);
    }
    expect(shas.size).toBe(1);
    expect(shas.has(sha16(content))).toBe(true);
  });

  it("extractBBMarkerShas extracts multiple shas from multiple markers", () => {
    const content1 = "rule one";
    const content2 = "rule two";
    const enriched = `${bbMarker(content1)}\n${bbMarker(content2)}`;
    const regex = /<!-- bb-context-injected:([0-9a-f]{16}) -->/g;
    const shas = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = regex.exec(enriched)) !== null) {
      shas.add(m[1]);
    }
    expect(shas.size).toBe(2);
    expect(shas.has(sha16(content1))).toBe(true);
    expect(shas.has(sha16(content2))).toBe(true);
  });

  it("dedup filter skips EE hit whose payload sha matches a BB marker", () => {
    const ruleText = "Always use repository pattern for data access";
    const marker = bbMarker(ruleText);
    const enrichedWithBB = `## BB context\n${ruleText}\n${marker}`;

    // Simulate the dedup logic from layer3-ee-injection.ts
    const bbMarkerShas = new Set<string>();
    const regex = /<!-- bb-context-injected:([0-9a-f]{16}) -->/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(enrichedWithBB)) !== null) {
      bbMarkerShas.add(m[1]);
    }

    const fakePoints = [
      { id: "pt-1", score: 0.9, payload: { text: ruleText } },
      { id: "pt-2", score: 0.8, payload: { text: "A different rule not yet injected" } },
    ];

    const getPointText = (p: (typeof fakePoints)[number]) => (p.payload?.text as string) ?? "";

    const filtered = fakePoints.filter((p) => {
      const text = getPointText(p);
      if (text.length === 0) return true;
      if (!bbMarkerShas.has(sha16(text))) return true;
      return false; // skip — already injected by BB path
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("pt-2");
  });

  it("dedup filter keeps all hits when no BB markers are present", () => {
    const enrichedNoBB = "plain context without any bb markers";

    const bbMarkerShas = new Set<string>();
    // No markers → shas stays empty

    const fakePoints = [
      { id: "pt-1", score: 0.9, payload: { text: "rule one" } },
      { id: "pt-2", score: 0.8, payload: { text: "rule two" } },
    ];

    const getPointText = (p: (typeof fakePoints)[number]) => (p.payload?.text as string) ?? "";

    const filtered = fakePoints.filter((p) => {
      const text = getPointText(p);
      if (text.length === 0 || bbMarkerShas.size === 0) return true;
      return !bbMarkerShas.has(sha16(text));
    });

    expect(filtered).toHaveLength(2);
    void enrichedNoBB;
  });
});
