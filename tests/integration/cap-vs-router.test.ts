/**
 * ROUTE-06 Integration Test: Cap-driven downgrade overrides classifier output.
 *
 * Setup: tmpdir home with tiny cap ($0.01), force classifier to return a hot result
 * preferring opus. decide() should downgrade due to cap projection exceeding cap.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { startStubEEServer, type StubHandle } from '../stubs/ee-server.js';
import { createEEClient } from '../../src/ee/client.js';
import { setDefaultEEClient } from '../../src/ee/intercept.js';
import { decide, type DecideOpts } from '../../src/router/decide.js';
import { midstreamPolicy } from '../../src/usage/midstream.js';

describe('ROUTE-06: cap-driven downgrade overrides classifier', () => {
  let home: string;
  let stub: StubHandle;

  beforeAll(async () => {
    // Create tmpdir home with extremely low cap so even haiku breaches.
    // Haiku costs ~$0.0072 for 4k/1k tokens; cap at $0.001 forces downgrade chain.
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'muonroi-cap-router-'));
    await fs.writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ cap: { monthly_usd: 0.001 } }),
    );

    // EE stub that returns null (both warm/cold fail -> fallback to defaultModel)
    stub = await startStubEEServer({});
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
  });

  afterAll(async () => {
    await stub.stop();
    await fs.rm(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    midstreamPolicy.clear();
  });

  it('downgrades and sets cap_overridden when all models breach cap', async () => {
    // With $0.001 cap, all models breach -> chain exhausts to HALT.
    // Classifier returns hot with haiku hint for "create file" but haiku also
    // costs ~$0.0072 which exceeds $0.001.
    const opts: DecideOpts = {
      tenantId: 'local',
      cwd: process.cwd(),
      defaultModel: 'claude-3-opus-latest',
      defaultProvider: 'anthropic',
      homeOverride: home,
    };

    const result = await decide('create file foo.ts', opts);

    expect(result.cap_overridden).toBe(true);
    expect(result.reason).toContain('cap-driven-downgrade');
    // With $0.001 cap, entire chain exhausted -> HALT
    expect(result.model).toBe('HALT');
    expect(result.tier).toBe('degraded');
  });

  it('returns HALT immediately when midstreamPolicy.refuseNext() is true', async () => {
    midstreamPolicy.forceRefuseNext();

    const opts: DecideOpts = {
      tenantId: 'local',
      cwd: process.cwd(),
      defaultModel: 'claude-3-opus-latest',
      defaultProvider: 'anthropic',
      homeOverride: home,
    };

    const result = await decide('create file foo.ts', opts);

    expect(result.cap_overridden).toBe(true);
    expect(result.model).toBe('HALT');
    expect(result.tier).toBe('degraded');
    expect(result.reason).toContain('cap-halt');
  });
});
