import { afterEach, describe, expect, it } from "vitest";
import { getCatalogUrl } from "./catalog-client.js";

describe("getCatalogUrl", () => {
  const original = process.env.MUONROI_CATALOG_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.MUONROI_CATALOG_URL;
    else process.env.MUONROI_CATALOG_URL = original;
  });

  it("defaults to the catalog.muonroi.com service (not the dead cp.muonroi.com URL)", () => {
    delete process.env.MUONROI_CATALOG_URL;
    const url = getCatalogUrl();
    expect(url).toBe("https://catalog.muonroi.com/api/v1/models");
    expect(url).not.toContain("cp.muonroi.com");
  });

  it("honors MUONROI_CATALOG_URL override", () => {
    process.env.MUONROI_CATALOG_URL = "http://localhost:8083/api/v1/models";
    expect(getCatalogUrl()).toBe("http://localhost:8083/api/v1/models");
  });

  it("ignores a blank/whitespace override and falls back to the default", () => {
    process.env.MUONROI_CATALOG_URL = "   ";
    expect(getCatalogUrl()).toBe("https://catalog.muonroi.com/api/v1/models");
  });
});
