import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SemanticRegistryService } from "../src/registry.service.js";
import { SemanticDirective } from "../src/semantic.directive.js";

// ---------------------------------------------------------------------------
// Task 4.3 — Basic mount/unmount
// ---------------------------------------------------------------------------

@Component({
  selector: "test-basic",
  standalone: true,
  imports: [SemanticDirective],
  template: `<button muonroiSemantic id="x" role="button">Click</button>`,
})
class BasicComponent {}

// ---------------------------------------------------------------------------
// Task 4.4 — Nested parent resolution (HIGH-4 critical test)
// ---------------------------------------------------------------------------

@Component({
  selector: "test-nested",
  standalone: true,
  imports: [SemanticDirective],
  template: `
    <div muonroiSemantic id="d" role="region">
      <span muonroiSemantic id="s" role="button"></span>
    </div>
  `,
})
class NestedComponent {}

// ---------------------------------------------------------------------------
// Task 4.3 — test suite
// ---------------------------------------------------------------------------

describe("[muonroiSemantic] directive — basic mount/unmount", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BasicComponent],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("registers node 'x' when mounted", () => {
    const fixture = TestBed.createComponent(BasicComponent);
    fixture.detectChanges();

    const registry = TestBed.inject(SemanticRegistryService);
    const snap = registry.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].id).toBe("x");
    expect(snap.nodes[0].role).toBe("button");
  });

  it("unregisters node 'x' when component is destroyed", () => {
    const fixture = TestBed.createComponent(BasicComponent);
    fixture.detectChanges();

    const registry = TestBed.inject(SemanticRegistryService);
    expect(registry.snapshot().nodes).toHaveLength(1);

    fixture.destroy();

    expect(registry.snapshot().nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.4 — Nested parent resolution (HIGH-4 critical test)
// ---------------------------------------------------------------------------

describe("[muonroiSemantic] directive — nested parent resolution (HIGH-4)", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [NestedComponent],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("resolves s.parentId === 'd', NOT the component root", () => {
    const fixture = TestBed.createComponent(NestedComponent);
    fixture.detectChanges();

    const registry = TestBed.inject(SemanticRegistryService);
    const snap = registry.snapshot();

    // Should have 2 nodes total: d (root) and s (child of d).
    // d is a root-level node; s is nested under d as a child.
    expect(snap.nodes).toHaveLength(1);

    const divNode = snap.nodes[0];
    expect(divNode.id).toBe("d");
    expect(divNode.role).toBe("region");

    // s must be a child of d — not a root-level node.
    expect(divNode.children).toBeDefined();
    expect(divNode.children).toHaveLength(1);
    const spanNode = divNode.children![0];
    expect(spanNode.id).toBe("s");
    expect(spanNode.role).toBe("button");
  });

  it("both nodes unregister cleanly on destroy", () => {
    const fixture = TestBed.createComponent(NestedComponent);
    fixture.detectChanges();

    const registry = TestBed.inject(SemanticRegistryService);
    expect(registry.snapshot().nodes).toHaveLength(1); // d with child s

    fixture.destroy();

    expect(registry.snapshot().nodes).toHaveLength(0);
  });
});
