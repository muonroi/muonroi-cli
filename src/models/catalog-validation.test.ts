import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { safeValidateCatalog, safeValidateCatalogDocument, validateStaticCatalog } from "./catalog-client.js";

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

  // Part E — drift guard: every bundled model MUST declare native_web_research
  // explicitly (true/false, never absent). A new model added without a decision
  // fails here, forcing the author to audit its real web-research capability
  // instead of silently defaulting (Kill #6: never infer from provider).
  it("every bundled catalog model declares native_web_research explicitly", () => {
    const raw = realCatalog as { models: Array<Record<string, unknown>> };
    const missing = raw.models.filter((m) => typeof m.native_web_research !== "boolean").map((m) => m.id);
    expect(missing).toEqual([]);
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

describe("remote payloads that serialize unset optionals as null", () => {
  /**
   * The deployed catalog API (FastAPI/Pydantic) emitted explicit nulls for every
   * unset optional. Zod's `.optional()` accepts a MISSING key but rejects null,
   * so the whole document failed validation and every CLI silently fell back to
   * its bundled static catalog — the remote catalog was served correctly and
   * consumed by nobody. The server now excludes nulls; the client tolerates them
   * either way.
   */
  const NULL_HEAVY = {
    version: "1.0",
    updated_at: "2026-07-27",
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
        cached_input_price_per_million: null,
        cache_write_price_per_million: null,
        reasoning: false,
        thinking_type: null,
        default_reasoning_effort: null,
        routing_tiers: null,
        description: "d",
      },
    ],
    routing: {
      vision_proxy: {
        default: { provider: "zai", model_id: "glm-4.6v-flash", api_base: null, api_key_env: null },
        fallback_chain: [
          {
            provider: "siliconflow",
            model_id: "Qwen/Qwen3-VL-32B-Instruct",
            api_base: "https://api.siliconflow.com/v1",
            api_key_env: "SILICONFLOW_API_KEY",
          },
        ],
      },
    },
    provider_policies: {
      zai: {
        peak_hour: {
          source_url: "https://z.ai",
          timezone: "Asia/Shanghai",
          start_hour: 14,
          end_hour: 18,
          windows: null,
          policy_basis: null,
          policy_note: null,
          sensitive_model_ids: ["glm-5.2"],
          fallback_model_id: "glm-4.7",
        },
      },
    },
  };

  it("accepts a null-heavy remote document instead of discarding it", () => {
    expect(safeValidateCatalog(NULL_HEAVY)).not.toBeNull();
  });

  it("keeps the non-null slot fields that carry the vision fallback", () => {
    const models = safeValidateCatalog(NULL_HEAVY);
    expect(models).not.toBeNull();
    // Regression guard for the real payload shape: the SiliconFlow slot's
    // endpoint + key env must survive, or the vision fallback resolves to a
    // provider that does not exist.
    const doc = safeValidateCatalogDocument(NULL_HEAVY);
    const slot = doc?.routing?.vision_proxy?.fallback_chain?.[0];
    expect(slot?.api_base).toBe("https://api.siliconflow.com/v1");
    expect(slot?.api_key_env).toBe("SILICONFLOW_API_KEY");
  });
});
