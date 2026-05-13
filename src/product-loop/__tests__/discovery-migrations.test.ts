// src/product-loop/__tests__/discovery-migrations.test.ts
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrators, readProjectContextWithMigration } from "../discovery-migrations.js";

describe("discovery-migrations", () => {
  it("CURRENT_SCHEMA_VERSION is 1", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it("registry exposes v0 → v1 migrator", () => {
    expect(typeof migrators[0]).toBe("function");
  });

  it("v0 → v1 migrator adds version and schemaName fields", () => {
    const v0 = { idea: "x", context: {} };
    const v1 = migrators[0](v0);
    expect(v1.version).toBe(1);
    expect(v1.schemaName).toBe("project-context");
  });

  it("v1 → v1 no-op preserves identity", () => {
    if (migrators[1]) {
      const v1 = { version: 1, schemaName: "project-context", idea: "x" };
      expect(migrators[1](v1)).toEqual(v1);
    } else {
      expect(migrators[1]).toBeUndefined();
    }
  });

  it("reads valid v1 directly", () => {
    const raw = JSON.stringify({
      version: 1,
      schemaName: "project-context",
      generatedAt: "2026-05-13T10:00:00Z",
      idea: "test",
      detection: {},
      context: {},
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: true } },
      userOverrides: [],
    });
    const ctx = readProjectContextWithMigration(raw);
    expect(ctx).not.toBeNull();
    expect(ctx?.version).toBe(1);
  });

  it("treats missing version as v0 and migrates", () => {
    const raw = JSON.stringify({ idea: "legacy", context: {} });
    const ctx = readProjectContextWithMigration(raw);
    expect(ctx?.version).toBe(1);
  });

  it("returns null on unknown future version", () => {
    const raw = JSON.stringify({ version: 99, idea: "future" });
    expect(readProjectContextWithMigration(raw)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(readProjectContextWithMigration("not json")).toBeNull();
    expect(readProjectContextWithMigration("")).toBeNull();
  });

  it("returns null if migrator throws", () => {
    const raw = JSON.stringify({ version: 0 });
    // tamper: replace v0 migrator to throw
    const orig = migrators[0];
    (migrators as any)[0] = () => {
      throw new Error("boom");
    };
    try {
      expect(readProjectContextWithMigration(raw)).toBeNull();
    } finally {
      (migrators as any)[0] = orig;
    }
  });
});
