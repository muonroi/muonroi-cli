import { afterEach, describe, expect, it, vi } from "vitest";
const save = vi.hoisted(() => vi.fn());
vi.mock("../../utils/settings.js", () => ({ saveUserSettings: save }));
import { handlePermissionsSlash } from "./permissions.js";
import { parsePermissionMode } from "../../utils/permission-mode.js";
import { statusBarStore } from "../../state/status-bar-store.js";
const base = { cwd: ".", tenantId: "fixture", defaultProvider: "fixture-provider", defaultModel: "fixture-model" };
afterEach(() => vi.clearAllMocks());
describe("explicit host permission selection", () => {
  it("normalizes Auto, validates input and reports current effective mode", async () => {
    expect(parsePermissionMode(" Auto ")).toBe("auto-edit");
    expect(() => parsePermissionMode("invalid")).toThrow();
    const result = await handlePermissionsSlash([], { ...base, getPermissionMode: () => "safe" });
    expect(result).toContain("safe");
    expect(save).not.toHaveBeenCalled();
  });
  it.each([
    "auto",
    "yolo",
    "safe",
  ])("applies explicit %s to host, saves next default and updates status", async (choice) => {
    const set = vi.fn(async () => 2);
    const result = await handlePermissionsSlash([choice], { ...base, setPermissionMode: set });
    const expected = parsePermissionMode(choice);
    expect(set).toHaveBeenCalledWith(expected);
    expect(save).toHaveBeenCalledWith({ permissionMode: expected });
    expect(statusBarStore.getState().permission_mode).toBe(expected);
    expect(result).toContain("2 owned running");
  });
  it("does not persist an unavailable or rejected host selection", async () => {
    await handlePermissionsSlash(["yolo"], base);
    expect(save).not.toHaveBeenCalled();
    await expect(
      handlePermissionsSlash(["yolo"], {
        ...base,
        setPermissionMode: async () => {
          throw new Error("host unavailable");
        },
      }),
    ).rejects.toThrow("host unavailable");
    expect(save).not.toHaveBeenCalled();
  });
});
