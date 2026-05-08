import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Thin wrapper around the Bitwarden CLI for writing secrets into the user's
 * vault. Mirrors the assumptions of `runKeysImportBw`: the secret lives in the
 * `notes` field of a Secure Note item named `<prefix><id>`.
 *
 * Auth contract: caller must have `bw` in PATH and `BW_SESSION` exported.
 * On any error the returned object has `ok: false` so callers can degrade
 * gracefully (e.g. fall back to writing only the OS keychain).
 */

export interface BwWriteResult {
  ok: boolean;
  action?: "created" | "updated";
  error?: string;
}

interface BwListItem {
  id: string;
  name: string;
  notes?: string | null;
  type: number;
}

type Runner = (cmd: string, args: string[], input?: string) => SpawnSyncReturns<string>;

const defaultRunner: Runner = (cmd, args, input) =>
  spawnSync(cmd, args, { encoding: "utf8", input });

function ensureUnlocked(session: string, run: Runner): { ok: true } | { ok: false; error: string } {
  const status = run("bw", ["status", "--session", session]);
  if (status.status !== 0) {
    return { ok: false, error: `bw status failed: ${status.stderr || status.stdout}` };
  }
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    parsed = {};
  }
  if (parsed.status !== "unlocked") {
    return { ok: false, error: `Bitwarden vault is not unlocked (status: ${parsed.status ?? "unknown"})` };
  }
  return { ok: true };
}

function findExistingItem(name: string, session: string, run: Runner): BwListItem | null {
  const list = run("bw", ["list", "items", "--search", name, "--session", session]);
  if (list.status !== 0) return null;
  let items: BwListItem[];
  try {
    items = JSON.parse(list.stdout) as BwListItem[];
  } catch {
    return null;
  }
  return items.find((it) => it.name === name) ?? null;
}

/**
 * Write `notes` into a vault item named `name`. Creates a Secure Note if
 * absent; updates the notes field if present. Calls `bw sync` after a write
 * so subsequent `bw get` calls see the new value.
 */
export async function writeBwSecureNote(
  name: string,
  notes: string,
  options: { runner?: Runner } = {},
): Promise<BwWriteResult> {
  const run = options.runner ?? defaultRunner;

  const which = run("bw", ["--version"]);
  if (which.status !== 0) {
    return { ok: false, error: "Bitwarden CLI ('bw') not found in PATH. Install: https://bitwarden.com/help/cli/" };
  }

  const session = process.env.BW_SESSION;
  if (!session) {
    return { ok: false, error: "BW_SESSION not set. Run: export BW_SESSION=$(bw unlock --raw)" };
  }

  const unlock = ensureUnlocked(session, run);
  if (!unlock.ok) return { ok: false, error: unlock.error };

  const existing = findExistingItem(name, session, run);

  if (existing) {
    const updated = { ...existing, notes };
    const encoded = run("bw", ["encode"], JSON.stringify(updated));
    if (encoded.status !== 0) {
      return { ok: false, error: `bw encode failed: ${encoded.stderr || encoded.stdout}` };
    }
    const edit = run("bw", ["edit", "item", existing.id, encoded.stdout.trim(), "--session", session]);
    if (edit.status !== 0) {
      return { ok: false, error: `bw edit failed: ${edit.stderr || edit.stdout}` };
    }
    run("bw", ["sync", "--session", session]);
    return { ok: true, action: "updated" };
  }

  // Create a new Secure Note. Type 2 = secure note; secureNote.type 0 = generic.
  const item = {
    type: 2,
    name,
    notes,
    secureNote: { type: 0 },
  };
  const encoded = run("bw", ["encode"], JSON.stringify(item));
  if (encoded.status !== 0) {
    return { ok: false, error: `bw encode failed: ${encoded.stderr || encoded.stdout}` };
  }
  const create = run("bw", ["create", "item", encoded.stdout.trim(), "--session", session]);
  if (create.status !== 0) {
    return { ok: false, error: `bw create failed: ${create.stderr || create.stdout}` };
  }
  run("bw", ["sync", "--session", session]);
  return { ok: true, action: "created" };
}
