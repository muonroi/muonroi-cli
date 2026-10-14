import { writeFileSync } from "node:fs";
import { loadEnvFileIntoProcess } from "../../../../src/providers/env-store.js";
import { loadKeyForProvider } from "../../../../src/providers/keychain.js";

loadEnvFileIntoProcess();
const key = await loadKeyForProvider("anthropic");
const response = await fetch("https://api.anthropic.com/v1/organizations/workspaces?include_default=true&limit=100", {
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  signal: AbortSignal.timeout(15_000),
});
const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch (error) {
  console.error(`Workspace discovery JSON failed (${response.status}): ${error.message}`);
  throw error;
}
const result = {
  status: response.status,
  workspaces: payload.data?.map((row) => ({ id: row.id, name: row.name })),
  has_more: payload.has_more,
  error: response.ok ? undefined : payload.error?.message,
};
writeFileSync(new URL("./anthropic-workspace-discovery.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
