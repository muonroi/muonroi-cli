import { getDefaultEEClient } from "./intercept.js";

/**
 * Check EE health using the default client.
 * Used by plan 00.07's session-resume bootstrap to determine if EE is reachable.
 * Never throws — returns { ok: false, status: 0 } on network error.
 */
export async function health(): Promise<{ ok: boolean; status: number }> {
  return getDefaultEEClient().health();
}
