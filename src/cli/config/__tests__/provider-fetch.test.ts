import { describe, expect, it } from "vitest";
import { inferCapability } from "../provider-fetch.js";

describe("inferCapability", () => {
  it("returns vision for model IDs containing 'vision'", () => {
    expect(inferCapability("gpt-4-vision-preview")).toBe("vision");
  });
  it("returns vision for 'vl' substring", () => {
    expect(inferCapability("Qwen2-VL-7B")).toBe("vision");
  });
  it("returns vision for 'multimodal'", () => {
    expect(inferCapability("gemini-multimodal-pro")).toBe("vision");
  });
  it("returns image for 'flux'", () => {
    expect(inferCapability("black-forest-labs/FLUX.1")).toBe("image");
  });
  it("returns image for 'dall-e'", () => {
    expect(inferCapability("dall-e-3")).toBe("image");
  });
  it("returns image for 'stable-diffusion'", () => {
    expect(inferCapability("stable-diffusion-xl")).toBe("image");
  });
  it("returns image for 'imagen'", () => {
    expect(inferCapability("imagen-3")).toBe("image");
  });
  it("returns video for 'wan'", () => {
    expect(inferCapability("wan-video-14b")).toBe("video");
  });
  it("returns video for 'kling'", () => {
    expect(inferCapability("kling-v1")).toBe("video");
  });
  it("returns text for unknown model", () => {
    expect(inferCapability("deepseek-v3")).toBe("text");
  });
  it("returns text for claude models", () => {
    expect(inferCapability("claude-opus-4-7")).toBe("text");
  });
});
