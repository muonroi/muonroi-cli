import { buildCapabilitiesPayload } from "@muonroi/agent-harness-core/mcp-server";
import { PROTOCOL_VERSION } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";

describe("harness-driver capabilities", () => {
  it("reports current protocol version", () => {
    expect(buildCapabilitiesPayload().protocol).toBe(PROTOCOL_VERSION);
  });

  it("advertises core feature set", () => {
    const { features } = buildCapabilitiesPayload();
    expect(features).toContain("capabilities");
    expect(features).toContain("snapshot");
    expect(features).toContain("press");
    expect(features).toContain("type");
    expect(features).toContain("wait_for");
    expect(features).toContain("query");
    expect(features).toContain("expect");
    expect(features).toContain("render_text");
  });
});
