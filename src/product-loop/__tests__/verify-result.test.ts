import { describe, it, expect } from "vitest";
import { parseVerifyResult, VERIFY_PASS_MARKER, VERIFY_FAIL_MARKER, VERIFY_CHECK_MARKER } from "../verify-result.js";
import type { ToolResult } from "../../types/index.js";

describe("parseVerifyResult", () => {
  it("should return PASS when success is true and output has pass marker", () => {
    const tr: ToolResult = {
      success: true,
      output: `Some logs... \n${VERIFY_PASS_MARKER}\nMore logs...`
    };
    expect(parseVerifyResult(tr)).toBe("PASS");
  });

  it("should return PASS when success is true and output has checkmark marker", () => {
    const tr: ToolResult = {
      success: true,
      output: `All tests passed! \n${VERIFY_CHECK_MARKER}`
    };
    expect(parseVerifyResult(tr)).toBe("PASS");
  });

  it("should return FAIL when success is false", () => {
    const tr: ToolResult = {
      success: false,
      output: "Tests failed miserably."
    };
    expect(parseVerifyResult(tr)).toBe("FAIL");
  });

  it("should return FAIL when output contains fail marker even if success is true", () => {
    const tr: ToolResult = {
      success: true,
      output: `Something went wrong but it didn't crash. \n${VERIFY_FAIL_MARKER}`
    };
    expect(parseVerifyResult(tr)).toBe("FAIL");
  });

  it("should return ERROR when error is present", () => {
    const tr: ToolResult = {
      success: false,
      error: "Command not found: bun"
    };
    expect(parseVerifyResult(tr)).toBe("ERROR");
  });

  it("should return UNKNOWN when success is true but no marker is found", () => {
    const tr: ToolResult = {
      success: true,
      output: "Just some random output without markers."
    };
    expect(parseVerifyResult(tr)).toBe("UNKNOWN");
  });

  it("should return UNKNOWN for empty result", () => {
    const tr: ToolResult = {
      success: true
    };
    expect(parseVerifyResult(tr)).toBe("UNKNOWN");
  });
});
