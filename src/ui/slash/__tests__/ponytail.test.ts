import { afterEach, describe, expect, it } from "vitest";
import { handlePonytailSlash } from "../ponytail.js";
import type { SlashContext } from "../registry.js";

describe("handlePonytailSlash", () => {
  const originalEnv = process.env.MUONROI_PONYTAIL_DISABLE;
  const dummyCtx: SlashContext = {
    cwd: "/",
    tenantId: "test",
    defaultProvider: "openai",
    defaultModel: "gpt-4",
  };

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MUONROI_PONYTAIL_DISABLE;
    } else {
      process.env.MUONROI_PONYTAIL_DISABLE = originalEnv;
    }
  });

  it("should enable ponytail mode and modify process.env", async () => {
    process.env.MUONROI_PONYTAIL_DISABLE = "1";
    const response = await handlePonytailSlash(["on"], dummyCtx);
    expect(process.env.MUONROI_PONYTAIL_DISABLE).toBe("0");
    expect(response).toContain("Ponytail Mode enabled");
  });

  it("should disable ponytail mode and modify process.env", async () => {
    process.env.MUONROI_PONYTAIL_DISABLE = "0";
    const response = await handlePonytailSlash(["off"], dummyCtx);
    expect(process.env.MUONROI_PONYTAIL_DISABLE).toBe("1");
    expect(response).toContain("Ponytail Mode disabled");
  });

  it("should return status when no args are provided", async () => {
    process.env.MUONROI_PONYTAIL_DISABLE = "0";
    const response = await handlePonytailSlash([], dummyCtx);
    expect(response).toContain("ON (enabled)");
  });
});
