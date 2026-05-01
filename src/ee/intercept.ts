import { getCachedAuthToken, loadEEAuthToken, refreshAuthToken } from "./auth.js";
import type { CreateEEClientOpts } from "./client.js";
import { createEEClient } from "./client.js";
import { emitMatches } from "./render.js";
import { buildScope } from "./scope.js";
import type { InterceptRequest, InterceptResponse, Scope } from "./types.js";

/**
 * Module-level default EE client instance (lazy-initialized on first use).
 * Use setDefaultEEClient() to inject a custom client (e.g. in tests or at boot
 * after loading auth token from config).
 */
let _defaultClient: ReturnType<typeof createEEClient> | null = null;

export function setDefaultEEClient(c: ReturnType<typeof createEEClient>): void {
  _defaultClient = c;
}

export function getDefaultEEClient(): ReturnType<typeof createEEClient> {
  if (!_defaultClient)
    _defaultClient = createEEClient({
      authToken: getCachedAuthToken() ?? undefined,
    });
  return _defaultClient;
}

/**
 * Call the EE intercept endpoint using the default client.
 * Blocks until a decision is received or the timeout elapses (falls back to allow).
 *
 * Phase 1: requires tenantId + scope explicitly.
 * - On 401 (surfaced as reason='auth-required'): refreshes token, rebuilds client, retries once.
 * - On allow + matches[]: emits rendered ⚠ lines via render sink.
 */
export async function intercept(req: InterceptRequest, opts?: CreateEEClientOpts): Promise<InterceptResponse> {
  const client = opts ? createEEClient(opts) : getDefaultEEClient();
  let resp = await client.intercept(req);

  // 401 refresh path: client surfaces 401 as { decision: 'allow', reason: 'auth-required' }
  if ((resp as any).reason === "auth-required") {
    await refreshAuthToken();
    _defaultClient = createEEClient({
      authToken: getCachedAuthToken() ?? undefined,
    });
    resp = await getDefaultEEClient().intercept(req);
  }

  // Emit rendered warnings for allow + matches
  if (resp.decision === "allow" && resp.matches) {
    emitMatches(resp.matches);
  }

  return resp;
}

/**
 * @deprecated — pass tenantId + scope explicitly. This helper fills defaults
 * for Phase 0 callers that haven't been migrated yet.
 *
 * Fills tenantId='local' and scope (computed via buildScope({ cwd })) when omitted.
 */
export async function interceptWithDefaults(
  req: Omit<InterceptRequest, "tenantId" | "scope"> & Partial<Pick<InterceptRequest, "tenantId" | "scope">>,
): Promise<InterceptResponse> {
  const tenantId = req.tenantId ?? "local";
  const scope: Scope = req.scope ?? (await buildScope({ cwd: req.cwd }));
  return intercept({
    toolName: req.toolName,
    toolInput: req.toolInput,
    cwd: req.cwd,
    tenantId,
    scope,
  });
}

/**
 * Bootstrap the EE client with auth token from ~/.experience/config.json.
 * Called once at session boot.
 */
export async function bootstrapEEClient(home?: string): Promise<void> {
  await loadEEAuthToken({ home });
  _defaultClient = createEEClient({
    authToken: getCachedAuthToken() ?? undefined,
  });
}
