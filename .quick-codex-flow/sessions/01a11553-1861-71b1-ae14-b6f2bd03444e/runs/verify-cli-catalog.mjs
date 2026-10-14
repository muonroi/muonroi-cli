import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Keep the existing service credential in process memory; never print or persist it.
const key = execFileSync(
  "ssh",
  [
    "-i",
    "C:/Users/phila/.ssh/muonroi_vps_rsa",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "phila@100.79.164.25",
    `docker exec muonroi-catalog-1 python -c 'import os; print(os.environ.get("CATALOG_API_KEY", ""))'`,
  ],
  { encoding: "utf8", windowsHide: true },
).trim();
process.env.MUONROI_CATALOG_API_KEY = key;
process.env.MUONROI_CATALOG_URL = "https://catalog.muonroi.com/api/v1/models?release=2.20-a95fbfe00871";
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  calls.push({ url: String(args[0]), status: response.status });
  return response;
};
const { fetchCatalogDocument, catalogModelToModelInfo } = await import(
  pathToFileURL(resolve("dist/src/models/catalog-client.js"))
);
const doc = await fetchCatalogDocument();
assert.equal(calls.length, 1);
assert.equal(calls[0].status, 200);
assert.equal(doc.version, "2.20");
assert.equal(doc.models.length, 51);
const source = JSON.parse(readFileSync("src/models/catalog.json", "utf8"));
const active = source.models.filter(
  (row) => ["openai", "anthropic"].includes(row.provider) && row.tier_routing !== false,
);
for (const expected of active) {
  const row = doc.models.find((model) => model.id === expected.id);
  assert.ok(row, expected.id);
  assert.deepEqual(row.modalities, expected.modalities);
  assert.deepEqual(row.long_context_pricing, expected.long_context_pricing);
  const runtime = catalogModelToModelInfo(row);
  assert.equal(runtime.maxOutputTokens, 128_000);
  assert.equal(runtime.contextWindow, expected.context_window);
}
const result = {
  source: "authenticated public endpoint through built CLI fetchCatalogDocument",
  requests: calls,
  version: doc.version,
  models: doc.models.length,
  active_provider_contracts_verified: active.length,
  context_pricing_preserved: doc.models.filter((row) => row.long_context_pricing).length,
};
writeFileSync(new URL("./catalog-cli-live-verification.json", import.meta.url), JSON.stringify(result, null, 2));
delete process.env.MUONROI_CATALOG_API_KEY;
console.log(JSON.stringify(result));
