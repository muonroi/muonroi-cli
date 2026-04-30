import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStubEEServer, type StubHandle } from '../../tests/stubs/ee-server.js';
import { createEEClient } from '../ee/client.js';
import { setDefaultEEClient } from '../ee/intercept.js';
import { callColdRoute } from './cold.js';

describe('callColdRoute', () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStubEEServer({
      coldRoute: (req) => ({
        model: 'deepseek-v3',
        provider: 'siliconflow',
        tier: 'cold' as const,
        reason: 'fallback',
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
  });

  afterAll(async () => {
    await stub.stop();
  });

  it('returns RouteDecision when stub responds successfully', async () => {
    const result = await callColdRoute('write a function', {
      tenantId: 'default',
      cwd: '/tmp',
    });
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('cold');
    expect(result!.model).toBe('deepseek-v3');
    expect(result!.provider).toBe('siliconflow');
    expect(result!.reason).toContain('cold:');
  });

  it('returns null when cold path times out (>1000ms)', async () => {
    const slowStub = await startStubEEServer({
      latencyMs: 1500,
      coldRoute: () => ({
        model: 'deepseek-v3',
        provider: 'siliconflow',
        tier: 'cold' as const,
        reason: 'fallback',
      }),
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${slowStub.port}` }));

    const result = await callColdRoute('write a function', {
      tenantId: 'default',
      cwd: '/tmp',
    });
    expect(result).toBeNull();

    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    await slowStub.stop();
  });
});
