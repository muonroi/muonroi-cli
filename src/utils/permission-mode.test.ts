import { describe, it, expect } from "vitest";
import { toolNeedsApproval, AUTO_EDIT_ALLOWED, type PermissionMode } from "./permission-mode.js";

describe("toolNeedsApproval", () => {
  // safe mode: always requires approval for every tool
  describe("safe mode", () => {
    it("requires approval for read_file in safe mode", () => {
      expect(toolNeedsApproval("read_file", "safe")).toBe(true);
    });

    it("requires approval for write_file in safe mode", () => {
      expect(toolNeedsApproval("write_file", "safe")).toBe(true);
    });

    it("requires approval for edit_file in safe mode", () => {
      expect(toolNeedsApproval("edit_file", "safe")).toBe(true);
    });

    it("requires approval for grep in safe mode", () => {
      expect(toolNeedsApproval("grep", "safe")).toBe(true);
    });

    it("requires approval for list_directory in safe mode", () => {
      expect(toolNeedsApproval("list_directory", "safe")).toBe(true);
    });

    it("requires approval for bash in safe mode", () => {
      expect(toolNeedsApproval("bash", "safe")).toBe(true);
    });

    it("requires approval for task in safe mode", () => {
      expect(toolNeedsApproval("task", "safe")).toBe(true);
    });

    it("requires approval for computer_click in safe mode", () => {
      expect(toolNeedsApproval("computer_click", "safe")).toBe(true);
    });

    it("requires approval for an arbitrary MCP tool in safe mode", () => {
      expect(toolNeedsApproval("mcp_some_tool", "safe")).toBe(true);
    });
  });

  // auto-edit mode: file ops auto-approved, bash/task/computer_* require approval
  describe("auto-edit mode", () => {
    it("auto-approves read_file in auto-edit mode", () => {
      expect(toolNeedsApproval("read_file", "auto-edit")).toBe(false);
    });

    it("auto-approves write_file in auto-edit mode", () => {
      expect(toolNeedsApproval("write_file", "auto-edit")).toBe(false);
    });

    it("auto-approves edit_file in auto-edit mode", () => {
      expect(toolNeedsApproval("edit_file", "auto-edit")).toBe(false);
    });

    it("auto-approves grep in auto-edit mode", () => {
      expect(toolNeedsApproval("grep", "auto-edit")).toBe(false);
    });

    it("auto-approves list_directory in auto-edit mode", () => {
      expect(toolNeedsApproval("list_directory", "auto-edit")).toBe(false);
    });

    it("requires approval for bash in auto-edit mode", () => {
      expect(toolNeedsApproval("bash", "auto-edit")).toBe(true);
    });

    it("requires approval for task in auto-edit mode", () => {
      expect(toolNeedsApproval("task", "auto-edit")).toBe(true);
    });

    it("requires approval for computer_click in auto-edit mode", () => {
      expect(toolNeedsApproval("computer_click", "auto-edit")).toBe(true);
    });

    it("requires approval for an arbitrary MCP tool in auto-edit mode", () => {
      expect(toolNeedsApproval("mcp_some_tool", "auto-edit")).toBe(true);
    });
  });

  // yolo mode: auto-approves everything
  describe("yolo mode", () => {
    it("auto-approves bash in yolo mode", () => {
      expect(toolNeedsApproval("bash", "yolo")).toBe(false);
    });

    it("auto-approves read_file in yolo mode", () => {
      expect(toolNeedsApproval("read_file", "yolo")).toBe(false);
    });

    it("auto-approves computer_click in yolo mode", () => {
      expect(toolNeedsApproval("computer_click", "yolo")).toBe(false);
    });

    it("auto-approves task in yolo mode", () => {
      expect(toolNeedsApproval("task", "yolo")).toBe(false);
    });

    it("auto-approves any arbitrary tool name in yolo mode", () => {
      expect(toolNeedsApproval("anything_at_all", "yolo")).toBe(false);
    });
  });
});

describe("AUTO_EDIT_ALLOWED", () => {
  it("contains the expected auto-approved tools", () => {
    expect(AUTO_EDIT_ALLOWED.has("read_file")).toBe(true);
    expect(AUTO_EDIT_ALLOWED.has("write_file")).toBe(true);
    expect(AUTO_EDIT_ALLOWED.has("edit_file")).toBe(true);
    expect(AUTO_EDIT_ALLOWED.has("grep")).toBe(true);
    expect(AUTO_EDIT_ALLOWED.has("list_directory")).toBe(true);
  });

  it("does NOT contain bash, task, or computer tools", () => {
    expect(AUTO_EDIT_ALLOWED.has("bash")).toBe(false);
    expect(AUTO_EDIT_ALLOWED.has("task")).toBe(false);
    expect(AUTO_EDIT_ALLOWED.has("computer_click")).toBe(false);
  });
});
