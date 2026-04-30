/**
 * EE health probe with proper interval lifecycle.
 *
 * Pitfall 8: unref() the timer so Node/Bun process exits cleanly.
 * clearInterval() on shutdown to avoid leaked handles.
 *
 * Probe interval: 30s. TTL: 60s.
 */
import { getDefaultEEClient } from '../ee/intercept.js';
import { routerStore } from './store.js';

const PROBE_INTERVAL_MS = 30_000;
const TTL_MS = 60_000;

let handle: ReturnType<typeof setInterval> | null = null;
let lastProbeMs = 0;
let lastOk = true;

async function probe(): Promise<void> {
  const result = await getDefaultEEClient().health();
  lastOk = result.ok;
  lastProbeMs = Date.now();
  routerStore.setState({ degraded: !lastOk, lastHealthCheckAtMs: lastProbeMs });
}

export async function startHealthProbe(): Promise<void> {
  if (handle) return;
  await probe(); // initial sync probe
  handle = setInterval(() => {
    void probe();
  }, PROBE_INTERVAL_MS);
  if (typeof (handle as any).unref === 'function') {
    (handle as any).unref();
  }
}

export function stopHealthProbe(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

export function getHealthStatus(): { ok: boolean; staleMs: number } {
  return { ok: lastOk, staleMs: Date.now() - lastProbeMs };
}

// Exported for tests
export const __testing = { TTL_MS, PROBE_INTERVAL_MS };
