import { describe, expect, it, vi } from "vitest";

const recall = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ createEEClient: () => ({ recall }) }));
vi.mock("./auth.js", () => ({ loadEEAuthToken: async () => null, getCachedServerBaseUrl: () => undefined }));

import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { formatRecallForAgent, hasVerifiedRecallScope, recallEE } from "./search.js";

describe("strict project recall before injection", () => {
  const result = { text: "scoped lesson", count: 1, entries: [{ id: "fixture", collection: "fixture" }] };
  it("rejects legacy advisory responses, false proofs and another project", () => {
    const expected = { project: "repo-a", cwd: "/repo-a" };
    expect(hasVerifiedRecallScope(result, expected)).toBe(false);
    expect(hasVerifiedRecallScope({ ...result, scope: { strict: false, project: "repo-a" } }, expected)).toBe(false);
    expect(hasVerifiedRecallScope({ ...result, scope: { strict: true, project: "repo-b" } }, expected)).toBe(false);
    expect(hasVerifiedRecallScope({ ...result, scope: { strict: true, project: "repo-a" } }, expected)).toBe(true);
  });
  it("requires caller cwd proof when no explicit project was requested", () => {
    expect(hasVerifiedRecallScope({ ...result, scope: { strict: true, cwd: "/repo-b" } }, { cwd: "/repo-a" })).toBe(
      false,
    );
    expect(
      hasVerifiedRecallScope(
        { ...result, scope: { strict: true, project: "repo", cwd: "D:\\repo\\" } },
        { cwd: "D:/repo" },
      ),
    ).toBe(true);
    expect(hasVerifiedRecallScope({ ...result, scope: { strict: true, cwd: "D:\\repo\\" } }, { cwd: "D:/repo" })).toBe(
      false,
    );
  });
  it("recognizes the client's own home-relative cwd spelling without accepting another directory", () => {
    const expected = { cwd: path.join(os.homedir(), "repo-a") };
    expect(
      hasVerifiedRecallScope({ ...result, scope: { strict: true, project: "repo-a", cwd: "~/repo-a" } }, expected),
    ).toBe(true);
    expect(hasVerifiedRecallScope({ ...result, scope: { strict: true, cwd: "~/repo-b" } }, expected)).toBe(false);
  });
  it("keeps the server incompatibility explanation visible instead of claiming an empty brain", () => {
    expect(formatRecallForAgent({ text: "[ee_scope_unverified] server lacks proof", count: 0, entries: [] })).toContain(
      "server lacks proof",
    );
  });
  it("does not inject or mirror lessons when a legacy server ignores strict scope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = vi.spyOn(logger, "file").mockImplementation(() => {});
    try {
      recall.mockResolvedValue({
        text: "WRONG_REPO_PRIVATE_LESSON",
        entries: [{ id: "foreign", collection: "fixture" }],
        count: 1,
      });
      const response = await recallEE("assigned project", {
        cwd: "/actual-shell-cwd",
        strictProject: true,
        project: "repo-a",
      });
      expect(recall).toHaveBeenCalledWith(
        "assigned project",
        expect.objectContaining({ cwd: "/actual-shell-cwd", project: "repo-a", strictProject: true }),
      );
      expect(response?.entries).toEqual([]);
      expect(response?.text).not.toContain("WRONG_REPO_PRIVATE_LESSON");
      expect(response?.text).toContain("ee_scope_unverified");
      expect(response?.text).toContain("Health 200 proves reachability only");
      expect(response?.text).toContain("strict_project");
      expect(warn).not.toHaveBeenCalled();
      expect(file).toHaveBeenCalledWith(
        "warn",
        "ee",
        expect.any(String),
        expect.objectContaining({ scopePresent: false }),
      );
    } finally {
      warn.mockRestore();
      file.mockRestore();
    }
  });
});
