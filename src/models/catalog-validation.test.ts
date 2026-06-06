import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { safeValidateCatalog, validateStaticCatalog } from "./catalog-client.js";

const realCatalog = createRequire(import.meta.url)("./catalog.json") as unknown;

// A minimal valid catalog payload for the happy-path assertions.
const VALID = {
  version: "1.0",
  updated_at: "2026-06-06",
  models: [
    {
      id: "m-fast",
      name: "M Fast",
      provider: "acme",
      tier: "fast",
      context_window: 128000,
      max_output_tokens: 8000,
      input_price_per_million: 0.1,
      output_price_per_million: 0.2,
      reasoning: false,
      description: "fast",
    },
  ],
};

describe("catalog schema validation", () => {
  it("accepts the real bundled catalog.json", () => {
    const models = safeValidateCatalog(realCatalog);
    expect(models).not.toBeNull();
    expect(models!.length).toBeGreaterThan(0);
    // every entry must carry the routing-critical fields
    for (const m of models!) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.provider).toBe("string");
      expect(typeof m.tier).toBe("string");
    }
  });

  it("safeValidateCatalog returns the models for a valid payload", () => {
    expect(safeValidateCatalog(VALID)?.[0]?.id).toBe("m-fast");
  });

  it("safeValidateCatalog returns null for a malformed remote payload (does not throw)", () => {
    expect(safeValidateCatalog({ version: "1", models: "nope" })).toBeNull();
    expect(safeValidateCatalog({ version: "1", updated_at: "x", models: [] })).toBeNull(); // empty
    expect(
      safeValidateCatalog({
        version: "1",
        updated_at: "x",
        models: [{ id: "x" }], // missing required provider/tier/prices
      }),
    ).toBeNull();
    expect(safeValidateCatalog(null)).toBeNull();
  });

  it("forward-compatible: unknown future fields are tolerated", () => {
    const withExtra = {
      ...VALID,
      models: [{ ...VALID.models[0], some_future_flag: true }],
    };
    expect(safeValidateCatalog(withExtra)).not.toBeNull();
  });

  it("validateStaticCatalog throws loudly on a malformed bundled file", () => {
    expect(() => validateStaticCatalog({ version: "1", updated_at: "x", models: [{ id: "x" }] }, "test.json")).toThrow(
      /Malformed catalog at test\.json/,
    );
  });

  it("validateStaticCatalog returns models for a valid bundled file", () => {
    expect(validateStaticCatalog(VALID, "test.json")[0]?.id).toBe("m-fast");
  });
});
