/**
 * src/usage/product-ledger.ts
 *
 * Per-product JSONL ledger for tracking spend scoped to a specific runId.
 * Stores entries at ~/.muonroi-cli/usage/products/<runId>.jsonl
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";

/**
 * Optional cost-attribution metadata. Lets `usage report --by callsite|role|phase`
 * pinpoint WHERE the cost grew without changing the ledger contract.
 * All fields optional → existing callers and old entries remain valid.
 */
export interface CostMeta {
  callsite?: string;
  role?: string;
  phase?: string;
  iteration?: number;
  stepCount?: number;
  systemChars?: number;
  promptChars?: number;
  estInputTokens?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  cachedInputTokens?: number;
  durationMs?: number;
}

export interface ProductLedgerEntry extends CostMeta {
  ts: number;
  productRunId: string;
  reservationId: string;
  actualUsd: number;
  model: string;
  provider: string;
}

function muonroiHome(homeOverride?: string): string {
  return homeOverride ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function getProductLedgerPath(productRunId: string, homeOverride?: string): string {
  return path.join(muonroiHome(homeOverride), "usage", "products", `${productRunId}.jsonl`);
}

async function ensureDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Atomic append to the product-specific JSONL ledger.
 * Uses proper-lockfile to ensure concurrent appends from multiple processes don't interleave.
 */
export async function appendProductLedger(
  productRunId: string,
  entry: ProductLedgerEntry,
  homeOverride?: string,
): Promise<void> {
  const filePath = getProductLedgerPath(productRunId, homeOverride);
  await ensureDirectory(filePath);

  // Ensure file exists for lockfile to target without truncating it concurrently
  try {
    await fs.access(filePath);
  } catch {
    await fs.appendFile(filePath, "");
  }

  const releaseLock = await lockfile.lock(filePath, {
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
    stale: 5_000,
    realpath: false,
  });

  try {
    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(filePath, line);
  } finally {
    await releaseLock();
  }
}

/**
 * Read all entries for a specific product run.
 * Returns empty array if file does not exist.
 */
export async function readProductLedger(productRunId: string, homeOverride?: string): Promise<ProductLedgerEntry[]> {
  const filePath = getProductLedgerPath(productRunId, homeOverride);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ProductLedgerEntry);
  } catch (err) {
    if ((err as any).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Calculate total spent USD for a specific product run.
 */
export async function getProductSpentUsd(productRunId: string, homeOverride?: string): Promise<number> {
  const entries = await readProductLedger(productRunId, homeOverride);
  return entries.reduce((sum, entry) => sum + entry.actualUsd, 0);
}

/**
 * Calculate total tokens consumed for a specific product run.
 */
export async function getProductTotalTokens(productRunId: string, homeOverride?: string): Promise<number> {
  const entries = await readProductLedger(productRunId, homeOverride);
  return entries.reduce((sum, entry) => sum + (entry.actualInputTokens ?? 0) + (entry.actualOutputTokens ?? 0), 0);
}
