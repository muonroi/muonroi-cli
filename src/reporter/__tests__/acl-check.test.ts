/**
 * src/reporter/__tests__/acl-check.test.ts
 *
 * Tests for stakeholder ACL verification.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../product-loop/stakeholder-acl.js", () => ({
  listStakeholders: vi.fn(),
}));

import { listStakeholders } from "../../product-loop/stakeholder-acl.js";
import { buildUnauthorizedReply, checkStakeholder } from "../acl-check.js";

const mockList = listStakeholders as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkStakeholder", () => {
  it("returns authorized=true when user is in stakeholder list", async () => {
    mockList.mockResolvedValue([
      { discordUserId: "user-1", displayName: "Alice", addedAtUtc: "", addedBy: "owner" },
      { discordUserId: "user-2", displayName: "Bob", addedAtUtc: "", addedBy: "cli" },
    ]);

    const result = await checkStakeholder("my-product", "user-1");
    expect(result.authorized).toBe(true);
  });

  it("returns authorized=false with stakeholderUsernames when user is not in list", async () => {
    mockList.mockResolvedValue([
      { discordUserId: "user-1", displayName: "Alice", addedAtUtc: "", addedBy: "owner" },
      { discordUserId: "user-2", displayName: "Bob", addedAtUtc: "", addedBy: "cli" },
    ]);

    const result = await checkStakeholder("my-product", "stranger-99");
    expect(result.authorized).toBe(false);
    expect(result.stakeholderUsernames).toEqual(["Alice", "Bob"]);
  });

  it("returns authorized=false with empty list when no stakeholders configured", async () => {
    mockList.mockResolvedValue([]);

    const result = await checkStakeholder("my-product", "stranger-99");
    expect(result.authorized).toBe(false);
    expect(result.stakeholderUsernames).toEqual([]);
  });
});

describe("buildUnauthorizedReply", () => {
  it("mentions stakeholder names when list is non-empty", () => {
    const reply = buildUnauthorizedReply({
      authorized: false,
      stakeholderUsernames: ["Alice", "Bob"],
    });
    expect(reply).toContain("@Alice");
    expect(reply).toContain("@Bob");
    expect(reply).toContain("Not authorized");
  });

  it("gives generic message when stakeholder list is empty", () => {
    const reply = buildUnauthorizedReply({
      authorized: false,
      stakeholderUsernames: [],
    });
    expect(reply).toContain("No stakeholders configured");
  });
});
