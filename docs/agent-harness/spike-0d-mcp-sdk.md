# Phase 0d spike findings — MCP SDK 1.29.0 API

## SDK version (verified)
`@modelcontextprotocol/sdk: 1.29.0`

## McpServer constructor

```ts
constructor(serverInfo: Implementation, options?: ServerOptions);
```

Creates a high-level MCP server wrapping a lower-level `Server` instance. The `serverInfo` parameter requires `{ name: string, version: string }`. The `options` object is optional and inherits from `ServerOptions`, which extends `ProtocolOptions` and can include `capabilities`, `instructions`, and `jsonSchemaValidator`.

## server.tool() — all overloads

```ts
// Overload 1: zero-argument tool
tool(name: string, cb: ToolCallback): RegisteredTool;

// Overload 2: zero-argument tool with description
tool(name: string, description: string, cb: ToolCallback): RegisteredTool;

// Overload 3: tool with schema or annotations
tool<Args extends ZodRawShapeCompat>(
  name: string,
  paramsSchemaOrAnnotations: Args | ToolAnnotations,
  cb: ToolCallback<Args>
): RegisteredTool;

// Overload 4: tool with description, schema or annotations
tool<Args extends ZodRawShapeCompat>(
  name: string,
  description: string,
  paramsSchemaOrAnnotations: Args | ToolAnnotations,
  cb: ToolCallback<Args>
): RegisteredTool;

// Overload 5: tool with schema and annotations
tool<Args extends ZodRawShapeCompat>(
  name: string,
  paramsSchema: Args,
  annotations: ToolAnnotations,
  cb: ToolCallback<Args>
): RegisteredTool;

// Overload 6: tool with description, schema, and annotations
tool<Args extends ZodRawShapeCompat>(
  name: string,
  description: string,
  paramsSchema: Args,
  annotations: ToolAnnotations,
  cb: ToolCallback<Args>
): RegisteredTool;
```

**Deprecated?** YES

```ts
/**
 * @deprecated Use `registerTool` instead.
 */
```

All six overloads carry the `@deprecated` JSDoc comment, indicating that `tool()` is deprecated in favor of `registerTool()`.

## server.registerTool() — signature

```ts
registerTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool;
```

`registerTool()` is the **recommended** method. It takes:
1. A tool name string
2. A configuration object with optional metadata and schemas
3. A callback function of type `ToolCallback<InputArgs>`

This single overload replaces the six deprecated `tool()` overloads.

## Schema argument type

The `paramsSchema` / `inputSchema` argument expects: **`ZodRawShapeCompat`**

### Type Definition

```ts
export type ZodRawShapeCompat = Record<string, AnySchema>;

export type AnySchema = z3.ZodTypeAny | z4.$ZodType;

export type AnyObjectSchema = z3.AnyZodObject | z4.$ZodObject | AnySchema;
```

**Important distinction:**
- **NOT** `z.object({ ... })` (a constructed ZodObject)
- **NOT** `ZodRawShape` (which is a Zod v3-specific type)
- **YES** `Record<string, AnySchema>` — a plain object where keys are field names and values are Zod schemas

The SDK is designed to accept raw shape objects (plain objects with schema values) rather than pre-constructed `z.object()` instances. This allows it to handle both Zod v3 and v4 schemas transparently.

## StdioServerTransport constructor

```ts
constructor(_stdin?: Readable, _stdout?: Writable);
```

The transport accepts optional streams (from `node:stream`). If omitted, it defaults to `process.stdin` and `process.stdout`. The transport implements the `Transport` interface and provides:
- `start(): Promise<void>` — begins listening for messages
- `send(message: JSONRPCMessage): Promise<void>` — sends a message
- `close(): Promise<void>` — shuts down the transport

## Recommended usage for muonroi-harness-driver

### Pattern: registerTool() with raw shape

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';

const server = new McpServer({ name: 'muonroi-harness', version: '1.0.0' });

// Raw shape (NOT z.object)
const tuiStartSchema = {
  session_id: z.string(),
  message: z.string(),
};

server.registerTool(
  'tui.start',
  {
    title: 'Start TUI Session',
    description: 'Initialize a TUI session for the agent',
    inputSchema: tuiStartSchema,
  },
  async (args) => {
    // args is inferred as { session_id: string; message: string }
    console.log(`Session: ${args.session_id}, Message: ${args.message}`);
    return {
      content: [{ type: 'text', text: 'TUI started' }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Key differences from deprecated `tool()` approach

1. **Use `registerTool()`, not `tool()`** — The latter is deprecated and will likely be removed in SDK 2.0.
2. **Pass raw shape, not `z.object()`** — Use `{ field: z.string(), ... }` not `z.object({ field: z.string(), ... })`.
3. **Config object with `inputSchema` / `outputSchema`** — More explicit than the overloaded `tool()` signatures.
4. **Type safety preserved** — The SDK infers argument types from the raw shape for full type checking.

## Notes for Task 4.1 / 4.3 implementer

- **The 3-arg form `server.tool(name, z.object({...}), cb)` will NOT work as expected in 1.29.0.** The SDK expects a raw shape (`ZodRawShapeCompat`), not a wrapped `z.object()`. If you pass `z.object()`, it will be treated as a `ToolAnnotations` object and type-check incorrectly.

- **Use `registerTool()` exclusively** for new code. The `tool()` API carries full deprecation notices and should be avoided in Phase 4.1/4.3 implementation to ensure longevity.

- **Type inference works correctly with raw shapes.** `server.registerTool('name', { inputSchema: { field: z.string() } }, cb)` will properly infer `args: { field: string }` inside the callback.

- **StdioServerTransport works out-of-the-box.** No configuration needed for simple CLI use cases — it defaults to stdin/stdout.

- **Always call `await server.connect(transport)`** before the server will begin listening. The `connect()` method attaches the transport, assumes ownership of it, and starts message processing.
