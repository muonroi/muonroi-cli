import { describe, expect, it } from "vitest";
import { productSlug } from "../product-identity.js";

describe("productSlug", () => {
  it("returns 8-char hash prefix + dash + slug suffix", () => {
    const out = productSlug("Blog platform with auth");
    expect(out).toMatch(/^[a-f0-9]{8}-[a-z0-9-]+$/);
  });

  it("stable: same input → same output", () => {
    const a = productSlug("Build a chat app");
    const b = productSlug("Build a chat app");
    expect(a).toBe(b);
  });

  it("different inputs produce different slugs", () => {
    expect(productSlug("idea A")).not.toBe(productSlug("idea B"));
  });

  it("total length ≤ 49 chars (8 + 1 + 40)", () => {
    const out = productSlug("a".repeat(500));
    expect(out.length).toBeLessThanOrEqual(49);
  });

  it("slug suffix only contains [a-z0-9-]", () => {
    const out = productSlug("HELLO!@# WORLD ñ");
    const suffix = out.slice(9);
    expect(/^[a-z0-9-]*$/.test(suffix)).toBe(true);
  });

  it("whitespace-only idea still yields valid slug", () => {
    const out = productSlug("   ");
    expect(out).toMatch(/^[a-f0-9]{8}/);
  });

  it("Discord round-trip: name muonroi-${slug} survives Discord's lowercase+replace transform unchanged", () => {
    const slug = productSlug("My Cool Product 2026");
    const channelName = `muonroi-${slug}`;
    const discordTransformed = channelName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    expect(channelName).toBe(discordTransformed);
  });

  it("Vietnamese with diacritics produces clean slug", () => {
    const out = productSlug("Sản phẩm thử nghiệm");
    expect(/^[a-f0-9]{8}-[a-z0-9-]+$/.test(out)).toBe(true);
  });
});
