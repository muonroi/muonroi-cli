import os from "node:os";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { BashTool } from "../bash.js";
import { createBuiltinTools, setLiveToolSet } from "../registry.js";

afterEach(() => setLiveToolSet(null));
describe("child-local tool inventory", () => {
  it("discovers and describes its granted MCP independently of the parent's current set", async () => {
    const bash = new BashTool(os.tmpdir());
    try {
      const parent = createBuiltinTools(bash, "agent");
      setLiveToolSet(parent);
      let visible: ToolSet = {};
      const native = createBuiltinTools(bash, "agent", { getToolSet: () => visible });
      const name = "mcp_fixture__read";
      visible = {
        ...native,
        [name]: dynamicTool({
          description: "Child fixture read",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => "fixture",
        }),
      };
      const context = { toolCallId: "inventory-fixture", messages: [] };
      const inventory = JSON.parse((await native.list_tools!.execute!({ category: "mcp" }, context)) as string);
      expect(inventory.mcp_count).toBe(1);
      const description = JSON.parse((await native.describe_tool!.execute!({ name }, context)) as string);
      expect(description.description).toContain("Child fixture read");
      expect(await visible[name]!.execute!({}, context)).toBe("fixture");
      visible = { ...native };
      expect(JSON.parse((await native.list_tools!.execute!({ category: "mcp" }, context)) as string).mcp_count).toBe(0);
    } finally {
      await bash.cleanup();
    }
  });
});
