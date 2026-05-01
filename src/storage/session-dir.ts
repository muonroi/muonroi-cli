/**
 * B-3: Sibling on-disk audit/staging directory for a session.
 *
 * This is NOT the session store.  Sessions remain SQLite ROWS in muonroi.db
 * via SessionStore (src/storage/sessions.ts).  This sibling directory holds
 * crash-recovery artifacts only:
 *   • pending_calls.jsonl  — in-flight tool call log (see orchestrator/pending-calls.ts)
 *   • *.tmp files          — staged partial writes before atomic rename
 *
 * Keeping this module isolated (no bun:sqlite imports) allows it to be loaded
 * safely in Vitest (Node) test environments.
 *
 * Path: <home>/.muonroi-cli/sessions/<sessionId>/
 *   or  <homeOverride>/sessions/<sessionId>/   (used in tests via MUONROI_CLI_HOME)
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Returns the sibling on-disk directory for a session — used as an audit log
 * and .tmp staging area (pending_calls.jsonl, partial-write .tmp files).
 *
 * Creates the directory on demand (idempotent via mkdir recursive).
 *
 * @param sessionId      The session identifier (from SessionStore).
 * @param homeOverride   Optional override for the home base directory.
 *                       Falls back to MUONROI_CLI_HOME env var, then
 *                       ~/.muonroi-cli.
 */
export async function getSessionDir(sessionId: string, homeOverride?: string): Promise<string> {
  const home = homeOverride ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
  const dir = path.join(home, "sessions", sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
