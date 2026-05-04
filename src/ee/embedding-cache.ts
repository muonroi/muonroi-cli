import { createHash } from "node:crypto";

const MAX_ENTRIES = 200;
const TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  vector: number[];
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function hashKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function getCachedEmbedding(text: string): number[] | null {
  const key = hashKey(text);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.vector;
}

export function setCachedEmbedding(text: string, vector: number[]): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(hashKey(text), { vector, timestamp: Date.now() });
}

export function clearEmbeddingCache(): void {
  cache.clear();
}

export function embeddingCacheStats(): { size: number; maxEntries: number } {
  return { size: cache.size, maxEntries: MAX_ENTRIES };
}
