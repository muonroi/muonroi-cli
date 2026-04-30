/**
 * Shared test helper: load JSONL fixture files and create a mock fullStream async iterable.
 * Used by all provider adapter tests to replay recorded streams without network.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Parse a JSONL fixture file into an array of AI SDK v6 TextStreamPart-like objects.
 */
export function loadFixtureChunks(provider: string, scenario: string): unknown[] {
  const filePath = resolve(__dirname, provider, `${scenario}.jsonl`);
  const text = readFileSync(filePath, 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Create a mock async iterable that yields fixture chunks,
 * simulating AI SDK v6's result.fullStream.
 */
export function createMockFullStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}
