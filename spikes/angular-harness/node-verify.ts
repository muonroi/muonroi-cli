/**
 * Node-only proof of concept for the Angular [muonroiSemantic] directive.
 *
 * Exercises Angular TestBed + ComponentFixture WITHOUT a browser.
 * Validates the critical HIGH-4 risk: parentId resolution via element-injector
 * chain — span inside div resolves parentId="d", NOT the component root.
 *
 * Acceptance criteria:
 *   1. Registry has 2 nodes after detectChanges(): "d" and "s".
 *   2. s.parentId === "d" (element-injector chain, not component injector).
 *   3. Mount → unmount cycle emits exactly 2 distinct LiveFrames (no dedup).
 *   Prints "PASS: parent resolution + 2 frames + no dup" and exits 0.
 *   Prints "FAIL: <reason>" on any check failure, exits 1.
 */

/**
 * DOM bootstrapping — jsdom must be set up BEFORE any Angular import
 * because Angular's BrowserDynamicTestingModule reads `document` at import
 * time. We install a minimal DOM globally so Angular finds what it needs.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost/",
});
// Install global DOM APIs that Angular and zone.js expect
(global as Record<string, unknown>).window = dom.window as unknown as Window & typeof globalThis;
(global as Record<string, unknown>).document = dom.window.document;
(global as Record<string, unknown>).navigator = dom.window.navigator;
(global as Record<string, unknown>).location = dom.window.location;
(global as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
(global as Record<string, unknown>).Element = dom.window.Element;
(global as Record<string, unknown>).Event = dom.window.Event;
(global as Record<string, unknown>).CustomEvent = dom.window.CustomEvent;
(global as Record<string, unknown>).Node = dom.window.Node;
(global as Record<string, unknown>).NodeList = dom.window.NodeList;
(global as Record<string, unknown>).MutationObserver = dom.window.MutationObserver;
(global as Record<string, unknown>).XMLHttpRequest = dom.window.XMLHttpRequest;

// Zone.js must be imported AFTER global DOM setup to patch correctly.
import "zone.js/node";

import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from "@angular/platform-browser-dynamic/testing";
import { SemanticRegistry } from "./src/registry.service";
import { SemanticDirective } from "./src/semantic.directive";

// Initialize Angular test environment (required once per Node process)
TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());

// ---------------------------------------------------------------------------
// Test host component — template mirrors the acceptance criterion:
//   <div muonroiSemantic id="d" role="region">
//     <span muonroiSemantic id="s" role="button">x</span>
//   </div>
// ---------------------------------------------------------------------------
@Component({
  standalone: true,
  imports: [SemanticDirective],
  template: `
    <div muonroiSemantic id="d" role="region">
      <span muonroiSemantic id="s" role="button">x</span>
    </div>
  `,
})
class TestHostComponent {}

// ---------------------------------------------------------------------------
// Snapshot helpers (inline — no import from src/snapshot-loop to keep
// node-verify.ts runnable before any compilation step)
// ---------------------------------------------------------------------------
const PROTOCOL_VERSION = "0.1.0" as const;

type LiveFrame = {
  mode: "live";
  version: typeof PROTOCOL_VERSION;
  seq: number;
  ts: number;
  nodes: ReturnType<SemanticRegistry["snapshot"]>;
};

function captureFrame(registry: SemanticRegistry, frames: string[], state: { lastHash: string; seq: number }): void {
  const nodes = registry.snapshot();
  const hash = JSON.stringify(nodes);
  if (hash === state.lastHash) return; // dedup
  state.lastHash = hash;
  const frame: LiveFrame = {
    mode: "live",
    version: PROTOCOL_VERSION,
    seq: ++state.seq,
    ts: Date.now(),
    nodes,
  };
  frames.push(JSON.stringify(frame));
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Configure TestBed with the standalone directive and component
  await TestBed.configureTestingModule({
    imports: [TestHostComponent, SemanticDirective],
  }).compileComponents();

  const registry = TestBed.inject(SemanticRegistry);
  const frames: string[] = [];
  const snapState = { lastHash: "", seq: 0 };

  // --- MOUNT ---
  const fixture = TestBed.createComponent(TestHostComponent);
  fixture.detectChanges(); // triggers ngOnInit on both directives

  captureFrame(registry, frames, snapState); // should emit frame 1

  // Duplicate snapshot — must NOT add a new frame (hash-dedup)
  captureFrame(registry, frames, snapState);
  captureFrame(registry, frames, snapState);

  // --- Assert mount state ---
  let ok = true;

  if (registry.size() !== 2) {
    console.error(`FAIL: expected 2 registered nodes, got ${registry.size()}`);
    ok = false;
  }

  const nodeD = registry.get("d");
  const nodeS = registry.get("s");

  if (!nodeD) {
    console.error("FAIL: node 'd' not found in registry");
    ok = false;
  }
  if (!nodeS) {
    console.error("FAIL: node 's' not found in registry");
    ok = false;
  }

  // THE CRITICAL CHECK: span's parentId must be "d" (element-injector), not null/component-root
  if (ok && nodeS!.parentId !== "d") {
    console.error(
      `FAIL: s.parentId === ${JSON.stringify(nodeS!.parentId)}, expected "d".\n` +
        `      @SkipSelf() did NOT resolve to the enclosing element injector.\n` +
        `      This would mean HIGH-4 risk is REAL — re-provision pattern broken.`,
    );
    ok = false;
  }

  // Check d has no parent (it's the root semantic node)
  if (ok && nodeD!.parentId != null) {
    console.error(
      `FAIL: d.parentId === ${JSON.stringify(nodeD!.parentId)}, expected null.\n` +
        `      Root node should have no parent.`,
    );
    ok = false;
  }

  // --- UNMOUNT ---
  fixture.destroy(); // triggers ngOnDestroy on both directives → unregisters

  captureFrame(registry, frames, snapState); // should emit frame 2

  // Another no-op re-snapshot
  captureFrame(registry, frames, snapState);

  // --- Assert unmount state ---
  if (ok && registry.size() !== 0) {
    console.error(`FAIL: expected 0 registered nodes after destroy, got ${registry.size()}`);
    ok = false;
  }

  // --- Assert frame count ---
  if (ok && frames.length !== 2) {
    console.error(`FAIL: got ${frames.length} distinct frames (expected 2)`);
    ok = false;
  }

  const parsed = frames.map((f) => JSON.parse(f) as LiveFrame);

  if (ok && parsed[0]?.nodes?.length !== 1) {
    // snapshot() returns ROOT nodes only (children are nested under parent).
    // For our tree (d → s), top-level should be 1 (just "d").
    console.error(`FAIL: frame 1 should have 1 root node, got ${parsed[0]?.nodes?.length}`);
    console.error("Frame 1 dump:", JSON.stringify(parsed[0], null, 2));
    ok = false;
  }

  if (ok && parsed[1]?.nodes?.length !== 0) {
    console.error(`FAIL: frame 2 should have 0 nodes (empty after unmount), got ${parsed[1]?.nodes?.length}`);
    ok = false;
  }

  if (ok && parsed[0]?.version !== "0.1.0") {
    console.error(`FAIL: wrong version in frame 1: ${parsed[0]?.version}`);
    ok = false;
  }

  // --- Verify tree structure in frame 1: d is root, s is child of d ---
  if (ok) {
    const rootNodes = parsed[0]!.nodes;
    if (rootNodes.length !== 1 || rootNodes[0]?.id !== "d") {
      console.error(`FAIL: expected single root node "d", got: ${JSON.stringify(rootNodes.map((n) => n.id))}`);
      ok = false;
    }
    const childNodes = rootNodes[0]?.children ?? [];
    if (childNodes.length !== 1 || childNodes[0]?.id !== "s") {
      console.error(`FAIL: expected "d" to have single child "s", got: ${JSON.stringify(childNodes.map((n) => n.id))}`);
      ok = false;
    }
  }

  if (ok) {
    console.log("PASS: parent resolution + 2 frames + no dup");
    console.log("Frame 1:", JSON.stringify(parsed[0], null, 2));
    console.log("Frame 2:", JSON.stringify(parsed[1], null, 2));
    console.log("\nNode details:");
    console.log("  d:", JSON.stringify(registry.get("d") ?? "(destroyed)")); // null after destroy
    console.log("  s.parentId was:", nodeS!.parentId);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAIL: unhandled exception:", err);
  process.exit(1);
});
