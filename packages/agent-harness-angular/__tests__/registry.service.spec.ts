import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SemanticRegistryService } from "../src/registry.service.js";

describe("SemanticRegistryService", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it("injects via TestBed", () => {
    const svc = TestBed.inject(SemanticRegistryService);
    expect(svc).toBeDefined();
  });

  it("snapshot().nodes is empty on fresh module", () => {
    const svc = TestBed.inject(SemanticRegistryService);
    const snap = svc.snapshot();
    expect(snap.nodes).toHaveLength(0);
  });

  it("register adds a node and unregister removes it", () => {
    const svc = TestBed.inject(SemanticRegistryService);
    const unregister = svc.register({ id: "a", role: "button" });
    expect(svc.snapshot().nodes).toHaveLength(1);
    unregister();
    expect(svc.snapshot().nodes).toHaveLength(0);
  });
});
