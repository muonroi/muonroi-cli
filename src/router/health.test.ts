import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startStubEEServer, type StubHandle } from '../../tests/stubs/ee-server.js';
import { createEEClient } from '../ee/client.js';
import { setDefaultEEClient } from '../ee/intercept.js';
import { startHealthProbe, stopHealthProbe, getHealthStatus } from './health.js';
import { routerStore } from './store.js';

describe('health probe', () => {
  let stub: StubHandle;
  let healthy: boolean;

  beforeEach(async () => {
    healthy = true;
    stub = await startStubEEServer({
      health: () => healthy,
    });
    setDefaultEEClient(createEEClient({ baseUrl: `http://localhost:${stub.port}` }));
    // Reset store state
    routerStore.setState({ degraded: false, lastHealthCheckAtMs: 0 });
  });

  afterEach(async () => {
    stopHealthProbe();
    await stub.stop();
  });

  it('flips routerStore.degraded=true when probe returns unhealthy', async () => {
    healthy = false;
    await startHealthProbe();
    expect(routerStore.getState().degraded).toBe(true);
  });

  it('flips routerStore.degraded=false when probe returns healthy after being unhealthy', async () => {
    healthy = false;
    await startHealthProbe();
    expect(routerStore.getState().degraded).toBe(true);

    stopHealthProbe();
    healthy = true;
    await startHealthProbe();
    expect(routerStore.getState().degraded).toBe(false);
  });

  it('getHealthStatus reflects last probe result with timestamp', async () => {
    const before = Date.now();
    await startHealthProbe();
    const status = getHealthStatus();
    expect(status.ok).toBe(true);
    expect(status.staleMs).toBeLessThan(1000);
  });

  it('stopHealthProbe clears the interval', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    await startHealthProbe();
    stopHealthProbe();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
