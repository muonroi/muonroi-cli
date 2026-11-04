import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import { createProviderFactoryAsync } from "../runtime.js";
import { ALL_PROVIDER_IDS } from "../types.js";
import { rewarmProviderFactory, warmProviderFactories } from "../warm.js";

vi.mock("../runtime.js", () => ({ createProviderFactoryAsync: vi.fn(), hasProviderFactory: () => false }));
vi.mock("../keychain.js", () => ({ loadKeyForProvider: async () => "fixture" }));
vi.mock("../auth/registry.js", () => ({ getOAuthProviderConfig: async () => null }));
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings: () => ({}),
  isProviderDisabled: (id: string) => id !== ALL_PROVIDER_IDS[0],
}));

afterEach(() => vi.restoreAllMocks());

describe("provider warmup file-only diagnostics", () => {
  it.each([false, true])("retains warm results and failures off the terminal (failure=%s)", async (failure) => {
    const file = vi.spyOn(logger, "file").mockImplementation(() => undefined);
    const terminal = ["log", "warn", "error"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined),
    );
    vi.mocked(createProviderFactoryAsync).mockReset();
    if (failure) vi.mocked(createProviderFactoryAsync).mockRejectedValue(new Error("fixture warm failure"));
    const result = await warmProviderFactories();
    for (const sink of terminal) expect(sink).not.toHaveBeenCalled();
    expect(file).toHaveBeenCalledWith("info", "cli", expect.stringContaining("registry warmed"), result);
    if (failure) {
      expect(result.skipped).toContainEqual({ id: ALL_PROVIDER_IDS[0], reason: "error: fixture warm failure" });
      expect(file).toHaveBeenCalledWith(
        "warn",
        "cli",
        expect.stringContaining("fixture warm failure"),
        expect.any(Object),
      );
    } else expect(result.warmed).toEqual([ALL_PROVIDER_IDS[0]]);
  });

  it("keeps credential rewarm failures on disk without changing the false result", async () => {
    const file = vi.spyOn(logger, "file").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(createProviderFactoryAsync).mockRejectedValue(new Error("fixture rewarm failure"));
    await expect(rewarmProviderFactory(ALL_PROVIDER_IDS[0])).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(file).toHaveBeenCalledWith(
      "warn",
      "cli",
      expect.stringContaining("fixture rewarm failure"),
      expect.any(Object),
    );
  });
});
