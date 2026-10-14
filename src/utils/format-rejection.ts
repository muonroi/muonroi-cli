/**
 * Render an unhandled-rejection `reason` into something a human can act on.
 *
 * `JSON.stringify(reason, Object.getOwnPropertyNames(reason))` — the previous
 * implementation in `src/index.ts` — returns the literal string `{}` for any
 * object whose data lives on the prototype rather than as own properties.
 * Bun's `ResolveMessage` is exactly that shape (measured 2026-09-09:
 * `instanceof Error` === false, `Object.getOwnPropertyNames()` === `[]`), so a
 * failed dynamic import — the most common startup rejection — printed
 * `Unhandled rejection: {}` and nothing else. Reproduced live:
 * `muonroi-cli mcp-driver` exits 1 with that exact string while the real reason
 * is "Cannot find module '@muonroi/agent-harness-core/mcp-server'".
 */
export function formatRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.stack || reason.message;
  if (reason && typeof reason === "object") {
    const own = JSON.stringify(reason, Object.getOwnPropertyNames(reason));
    // `{}` / `undefined` mean the own-property view carried no information.
    if (own && own !== "{}") return own;
    const name = (reason as { constructor?: { name?: string } }).constructor?.name;
    const message = (reason as { message?: unknown }).message;
    const text = String(reason);
    const parts = [
      name && text.startsWith(name) ? undefined : name,
      typeof message === "string" && message.length > 0 && !text.includes(message) ? message : undefined,
      text === "[object Object]" ? undefined : text,
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    return parts.length > 0 ? parts.join(": ") : `${name ?? "object"} (no enumerable properties)`;
  }
  return String(reason);
}
