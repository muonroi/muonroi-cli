/**
 * Patch tool schema serialization for Zod v4 + AI SDK v6 compatibility.
 *
 * AI SDK v6 internally uses zod-to-json-schema v3 which doesn't support
 * Zod v4. Tool parameter schemas arrive at the API missing the `type`
 * field, causing DeepSeek and other strict APIs to reject with 400.
 *
 * This patch wraps global `fetch` to intercept `/chat/completions`
 * requests and ensure every tool function.parameters has `type: "object"`.
 */
export function patchZodToJsonSchema(): void {
  const originalFetch = globalThis.fetch;
  if ((originalFetch as any).__zodPatched) return;

  globalThis.fetch = async function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (init?.method === "POST" && init.body && typeof init.body === "string") {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/completions")) {
        try {
          const body = JSON.parse(init.body);
          if (fixBrokenToolSchemas(body)) {
            init = { ...init, body: JSON.stringify(body) };
          }
        } catch {}
      }
    }
    return originalFetch(input, init!);
  } as typeof fetch;
  (globalThis.fetch as any).__zodPatched = true;
}

function fixBrokenToolSchemas(body: Record<string, unknown>): boolean {
  const tools = body.tools as Array<{
    type: string;
    function: { name: string; parameters: Record<string, unknown> };
  }> | undefined;
  if (!Array.isArray(tools)) return false;
  let modified = false;
  for (const tool of tools) {
    const params = tool?.function?.parameters;
    if (!params) continue;
    if (!params.type) {
      params.type = "object";
      if (!params.properties) params.properties = {};
      modified = true;
    }
  }
  return modified;
}
