import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'node:net', re: /from\s+['"]node:net['"]/ },
  { name: 'node:http', re: /from\s+['"]node:https?['"]/ },
  { name: 'undici', re: /from\s+['"]undici['"]/ },
  { name: 'axios', re: /from\s+['"]axios['"]/ },
  { name: 'ee-import', re: /from\s+['"](\.\.\/)+ee\// },
  { name: 'global-fetch', re: /\bfetch\s*\(/ },
];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

describe('ROUTE-01: no network in hot-path classifier', () => {
  it('src/router/classifier/** must not import network APIs or call fetch()', () => {
    const offenders: string[] = [];
    for (const file of walk('src/router/classifier')) {
      const src = readFileSync(file, 'utf8');
      for (const f of FORBIDDEN) {
        if (f.re.test(src)) offenders.push(`${file}: ${f.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
