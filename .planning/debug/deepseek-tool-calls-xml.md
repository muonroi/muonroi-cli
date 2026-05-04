---
status: resolved
trigger: DeepSeek v4-flash outputs XML/DSML tool calls as text instead of using structured function calling API
created: 2026-05-04
updated: 2026-05-04
---

## Symptoms

- **Expected**: DeepSeek v4-flash uses structured function calling (tool_calls in API response) when tools are passed
- **Actual**: Model outputs XML text (`<bash>`, `<read_file>`, `<task>`, DSML `<| |DSML| |tool_calls>`) instead of structured tool calls
- **Error messages**: "Invalid schema for function: schema must be a JSON Schema of 'type: object', got 'type: null'" when tool schemas are sent
- **Timeline**: Discovered during caching optimization work. Pre-existing issue -- DeepSeek tools never worked via structured API
- **Reproduction**: Run `bun run src/index.ts --model deepseek-v4-flash -p "ban explore project va danh gia no" --format json` -- finishReason is "stop" not "tool-calls", text contains XML

## Root Cause

`createTools()` in orchestrator.ts returned `{}` (empty ToolSet). All tools were expected to come from MCP servers, but no MCP servers were configured. Result: DeepSeek API received zero tools, so the model had no function calling available and fell back to XML text output.

Secondary issue: `captureToolSchemas()` only checked `t.parameters` (tool() helper pattern) but MCP tools use `t.inputSchema` (dynamicTool pattern), so the fetch interceptor could never fix schemas for MCP tools.

## Resolution

1. Created `src/tools/registry.ts` -- `createBuiltinTools()` that wraps existing tool implementations (bash, file, grep) as AI SDK `dynamicTool()` definitions with proper `jsonSchema()` schemas
2. Updated `createTools()` in orchestrator.ts to call `createBuiltinTools()` instead of returning `{}`
3. Fixed `captureToolSchemas()` to handle both `inputSchema` (MCP/dynamicTool) and `parameters` (tool() helper) properties
4. Added `$schema` field removal in fetch interceptor for providers that don't accept it

## Evidence

- timestamp: 2026-05-04 direct DeepSeek API test with correct schemas: structured tool_calls returned successfully
- timestamp: 2026-05-04 confirmed asSchema(undefined) produces {properties:{}, additionalProperties:false} (missing type:"object")
- timestamp: 2026-05-04 confirmed DeepSeek rejects schemas without type field: "schema must be a JSON Schema of 'type: object', got 'type: null'"
- timestamp: 2026-05-04 end-to-end test with createBuiltinTools: finishReason="tool-calls", DeepSeek calls bash/read_file correctly

## Eliminated

- AI SDK v6 asSchema() bug -- works correctly for both jsonSchema() and Zod v4 Standard Schema
- MCP tool schema corruption -- MCP tools via dynamicTool() have correct inputSchema
- DeepSeek API limitation -- API supports structured tool calling perfectly when schemas are valid
