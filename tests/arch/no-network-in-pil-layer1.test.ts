// Arch guard: Layer 1 hot path must never import network modules.
// Mirrors tests/arch/no-network-in-classifier.test.ts for src/router/classifier/

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'node:net', re: /from\s+['"]node:net['"]/ },
  { name: 'node:http(s)', re: /from\s+['"]node:https?['"]/ },
  { name: 'undici', re: /from\s+['"]undici['"]/ },
  { name: 'axios', re: /from\s+['"]axios['"]/ },
  { name: 'ee-http-import', re: /from\s+['"](\.\.\/)+ee\/(?!bridge\b)/ },
  { name: 'global-fetch', re: /\bfetch\s*\(/ },
];

const LAYER1_FILE = join('src', 'pil', 'layer1-intent.ts');
const TYPES_FILE = join('src', 'pil', 'types.ts');

describe('PIL-ARCH: no network in PIL Layer 1 hot path', () => {
  it('src/pil/layer1-intent.ts does NOT import node:net', () => {
    const src = readFileSync(LAYER1_FILE, 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:net['"]/);
  });

  it('src/pil/layer1-intent.ts does NOT import node:http or node:https', () => {
    const src = readFileSync(LAYER1_FILE, 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:https?['"]/);
  });

  it('src/pil/layer1-intent.ts does NOT import undici or axios', () => {
    const src = readFileSync(LAYER1_FILE, 'utf8');
    expect(src).not.toMatch(/from\s+['"]undici['"]/);
    expect(src).not.toMatch(/from\s+['"]axios['"]/);
  });

  it('src/pil/layer1-intent.ts does NOT import HTTP ee modules (bridge.js is allowed)', () => {
    const src = readFileSync(LAYER1_FILE, 'utf8');
    expect(src).not.toMatch(/from\s+['"](\.\.\/)+ee\/(?!bridge\b)/);
  });

  it('src/pil/layer1-intent.ts does NOT use global fetch()', () => {
    const src = readFileSync(LAYER1_FILE, 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it('src/pil/types.ts does NOT import any FORBIDDEN network patterns', () => {
    const src = readFileSync(TYPES_FILE, 'utf8');
    const offenders: string[] = [];
    for (const f of FORBIDDEN) {
      if (f.re.test(src)) offenders.push(f.name);
    }
    expect(offenders).toEqual([]);
  });
});
