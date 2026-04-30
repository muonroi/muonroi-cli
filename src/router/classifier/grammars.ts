import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type GrammarId = 'typescript' | 'python';

export const GRAMMARS: Record<GrammarId, string> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
};

export async function loadGrammarBytes(id: GrammarId): Promise<Uint8Array> {
  const rel = GRAMMARS[id];
  // Resolve under node_modules -- works under Bun + Node
  const p = path.join(process.cwd(), 'node_modules', rel);
  const buf = await fs.readFile(p);
  return new Uint8Array(buf);
}
