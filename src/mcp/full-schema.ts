/**
 * The field name under which an MCP tool's REAL JSON Schema is preserved after
 * `stripMcpInputSchema` swaps the advertised `inputSchema` for the lazy
 * placeholder (see `src/mcp/runtime.ts`, Phase M1 lazy schema loading).
 *
 * It lives in its own leaf module so `src/tools/registry.ts` can read it
 * without importing the MCP client runtime (and the MCP SDK it pulls in).
 *
 * The AI SDK serializes only `description` + `inputSchema` into a provider tool
 * definition, so this extra key never reaches the model and costs no tokens.
 */
export const MCP_FULL_INPUT_SCHEMA = "__mcpFullInputSchema" as const;
