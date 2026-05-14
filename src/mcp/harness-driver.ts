import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PROTOCOL_VERSION } from "../agent-harness/protocol.js";

const FEATURES = ["capabilities", "snapshot", "press", "type", "wait_for", "query", "expect", "render_text"] as const;

export function buildCapabilitiesPayload(): { protocol: string; features: readonly string[] } {
  return {
    protocol: PROTOCOL_VERSION,
    features: FEATURES,
  };
}

export async function runHarnessDriver(): Promise<void> {
  const server = new McpServer({ name: "muonroi-harness-driver", version: "0.1.0" });

  server.registerTool(
    "tui.capabilities",
    {
      description: "Report the harness protocol version and supported feature list.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(buildCapabilitiesPayload()),
        },
      ],
    }),
  );

  await server.connect(new StdioServerTransport());
}
