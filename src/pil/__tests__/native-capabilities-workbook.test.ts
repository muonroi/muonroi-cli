import { afterEach, describe, expect, it } from "vitest";
import { buildNativeCapabilitiesSection, NATIVE_CAPABILITIES } from "../native-capabilities-workbook.js";

describe("buildNativeCapabilitiesSection", () => {
  afterEach(() => {
    process.env.MUONROI_DISABLE_NATIVE_CAPABILITIES = undefined;
  });

  it("emits the manifest for agent mode (non-chitchat)", () => {
    const out = buildNativeCapabilitiesSection({ mode: "agent", chitchat: false });
    expect(out).toContain("NATIVE CAPABILITIES");
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("names the load-bearing affordances the agent previously could not see", () => {
    // Regression: these are the capabilities the in-CLI agent reconstructed by
    // grepping source (session d95113d3be09). They MUST appear in the manifest.
    for (const token of [
      "ee_query",
      "tool-artifact",
      'task(agent="explore"',
      "delegate(",
      "self-verify",
      "usage forensics",
      "bash_output_get",
      "[Discovery]",
    ]) {
      expect(NATIVE_CAPABILITIES).toContain(token);
    }
  });

  it("is empty for chitchat turns", () => {
    expect(buildNativeCapabilitiesSection({ mode: "agent", chitchat: true })).toBe("");
  });

  it("is empty for non-agent modes (plan/ask have a restricted toolset)", () => {
    expect(buildNativeCapabilitiesSection({ mode: "plan", chitchat: false })).toBe("");
    expect(buildNativeCapabilitiesSection({ mode: "ask", chitchat: false })).toBe("");
  });

  it("respects the MUONROI_DISABLE_NATIVE_CAPABILITIES escape hatch", () => {
    process.env.MUONROI_DISABLE_NATIVE_CAPABILITIES = "1";
    expect(buildNativeCapabilitiesSection({ mode: "agent", chitchat: false })).toBe("");
  });
});
