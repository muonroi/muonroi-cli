import { setKeyForProvider } from "../src/providers/keychain.js";

const map: Record<string, "openai" | "siliconflow" | "anthropic" | "google" | "deepseek" | "xai"> = {
  OPENAI_API_KEY: "openai",
  SILICONFLOW_API_KEY: "siliconflow",
  ANTHROPIC_API_KEY: "anthropic",
  GOOGLE_API_KEY: "google",
  DEEPSEEK_API_KEY: "deepseek",
  XAI_API_KEY: "xai",
};

let stored = 0;
let skipped = 0;
for (const [envName, provider] of Object.entries(map)) {
  const v = process.env[envName];
  if (!v || v.length < 10) {
    skipped++;
    continue;
  }
  const ok = await setKeyForProvider(provider, v.trim());
  console.log(`${ok ? "✓" : "✗"} ${provider.padEnd(12)} ← $env:${envName}  (${v.slice(0, 6)}…${v.slice(-4)})`);
  if (ok) stored++;
}
console.log(`\nStored ${stored} key(s), skipped ${skipped} (env var not set).`);
