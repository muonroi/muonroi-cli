/**
 * Export keys from OS keychain to Bitwarden vault as Secure Notes.
 * Item name convention matches keys import-bw / import-bw-chat:
 *   muonroi-cli/<provider>           e.g. muonroi-cli/deepseek
 *   muonroi-cli/chat-<chat-secret>   e.g. muonroi-cli/chat-discord-token
 * Notes field = the value.
 *
 * Idempotent: existing items are updated (edit), missing ones created.
 *
 * Requires BW_SESSION env var (run: $env:BW_SESSION = (bw unlock --raw))
 */
import { spawnSync } from "node:child_process";
import type { ChatSecretId } from "../src/chat/chat-keychain.js";
import { getChatSecret } from "../src/chat/chat-keychain.js";
import { KEYCHAIN_PROVIDER_IDS, loadKeyForProvider } from "../src/providers/keychain.js";

function bw(args: string[], stdin?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("bw", args, { encoding: "utf8", input: stdin });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function findItem(name: string, session: string): { id: string; notes: string } | null {
  const r = bw(["list", "items", "--search", name, "--session", session]);
  if (!r.ok) return null;
  try {
    const items = JSON.parse(r.stdout) as Array<{ id: string; name: string; notes?: string }>;
    const match = items.find((it) => it.name === name);
    return match ? { id: match.id, notes: match.notes ?? "" } : null;
  } catch {
    return null;
  }
}

function upsertSecureNote(name: string, value: string, session: string): "created" | "updated" | "unchanged" | "error" {
  const existing = findItem(name, session);
  if (existing) {
    if (existing.notes === value) return "unchanged";
    // Get full item to update
    const getR = bw(["get", "item", existing.id, "--session", session]);
    if (!getR.ok) return "error";
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(getR.stdout);
    } catch {
      return "error";
    }
    item.notes = value;
    const encoded = bw(["encode"], JSON.stringify(item));
    if (!encoded.ok) return "error";
    const editR = bw(["edit", "item", existing.id, encoded.stdout.trim(), "--session", session]);
    return editR.ok ? "updated" : "error";
  }
  // Create new
  const template = { type: 2, name, notes: value, secureNote: { type: 0 }, login: null, fields: [] };
  const encoded = bw(["encode"], JSON.stringify(template));
  if (!encoded.ok) return "error";
  const createR = bw(["create", "item", encoded.stdout.trim(), "--session", session]);
  return createR.ok ? "created" : "error";
}

async function main() {
  const session = process.env.BW_SESSION;
  if (!session) {
    console.error("BW_SESSION not set. Run first:");
    console.error("  $env:BW_SESSION = (bw unlock --raw)   # PowerShell");
    console.error("  export BW_SESSION=$(bw unlock --raw)  # bash");
    process.exit(2);
  }
  const status = bw(["status", "--session", session]);
  let parsed: { status?: string } = {};
  try {
    parsed = JSON.parse(status.stdout);
  } catch {}
  if (parsed.status !== "unlocked") {
    console.error(`BW vault not unlocked (status: ${parsed.status ?? "unknown"})`);
    process.exit(2);
  }

  const chatIds: ChatSecretId[] = ["discord-token", "discord-guild-id", "slack-token", "slack-team-id"];
  const results: Array<{ name: string; outcome: string }> = [];

  for (const provider of KEYCHAIN_PROVIDER_IDS) {
    let value: string | null = null;
    try {
      value = await loadKeyForProvider(provider);
    } catch {
      // ProviderKeyMissingError — provider not configured, skip silently
    }
    if (!value) continue;
    const name = `muonroi-cli/${provider}`;
    const outcome = upsertSecureNote(name, value, session);
    results.push({ name, outcome });
  }
  for (const id of chatIds) {
    const value = await getChatSecret(id);
    if (!value) continue;
    const name = `muonroi-cli/chat-${id}`;
    const outcome = upsertSecureNote(name, value, session);
    results.push({ name, outcome });
  }

  console.log("Upsert results:");
  for (const r of results) console.log(`  [${r.outcome.padEnd(9)}] ${r.name}`);
  const created = results.filter((r) => r.outcome === "created").length;
  const updated = results.filter((r) => r.outcome === "updated").length;
  const unchanged = results.filter((r) => r.outcome === "unchanged").length;
  const errors = results.filter((r) => r.outcome === "error").length;
  console.log(
    `\nTotal: ${results.length}  (created=${created}, updated=${updated}, unchanged=${unchanged}, errors=${errors})`,
  );
  if (errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
