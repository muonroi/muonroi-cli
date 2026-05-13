import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addStakeholder, listStakeholders, removeStakeholder } from "../stakeholder-acl.js";

describe("stakeholder-acl", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `acl-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpHome, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
  });

  it("addStakeholder + listStakeholders round-trip", async () => {
    await addStakeholder("slug-a", {
      discordUserId: "1234",
      displayName: "alice",
      addedAtUtc: "2026-05-13T00:00:00Z",
      addedBy: "cli",
    });
    const items = await listStakeholders("slug-a");
    expect(items).toHaveLength(1);
    expect(items[0].discordUserId).toBe("1234");
  });

  it("re-adding same user is a no-op (idempotent)", async () => {
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "x", addedAtUtc: "t", addedBy: "cli" });
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "x", addedAtUtc: "t2", addedBy: "cli" });
    const items = await listStakeholders("slug-a");
    expect(items).toHaveLength(1);
  });

  it("removeStakeholder removes by id", async () => {
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "a", addedAtUtc: "t", addedBy: "cli" });
    await addStakeholder("slug-a", { discordUserId: "2", displayName: "b", addedAtUtc: "t", addedBy: "cli" });
    await removeStakeholder("slug-a", "1");
    const items = await listStakeholders("slug-a");
    expect(items.map((s) => s.discordUserId)).toEqual(["2"]);
  });

  it("listStakeholders returns [] when slug unknown", async () => {
    expect(await listStakeholders("nonexistent")).toEqual([]);
  });

  it("isolates stakeholders by slug", async () => {
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "a", addedAtUtc: "t", addedBy: "cli" });
    await addStakeholder("slug-b", { discordUserId: "2", displayName: "b", addedAtUtc: "t", addedBy: "cli" });
    expect((await listStakeholders("slug-a")).map((s) => s.discordUserId)).toEqual(["1"]);
    expect((await listStakeholders("slug-b")).map((s) => s.discordUserId)).toEqual(["2"]);
  });

  it("corrupt file backed up + reinitialized", async () => {
    const filePath = path.join(tmpHome, "stakeholders.json");
    await fs.writeFile(filePath, "{ not valid json");
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "a", addedAtUtc: "t", addedBy: "cli" });
    const entries = await fs.readdir(tmpHome);
    expect(entries.some((e) => e.startsWith("stakeholders.json.corrupt-"))).toBe(true);
    expect(await listStakeholders("slug-a")).toHaveLength(1);
  });

  it("refuses wrong schema version", async () => {
    const filePath = path.join(tmpHome, "stakeholders.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 99, items: {} }));
    await expect(listStakeholders("slug-a")).rejects.toThrow(/version|schema/i);
  });

  it("concurrent addStakeholder calls produce no duplicate entries", async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      addStakeholder("slug-x", {
        discordUserId: String(i),
        displayName: `u${i}`,
        addedAtUtc: "t",
        addedBy: "cli",
      }),
    );
    await Promise.all(calls);
    const items = await listStakeholders("slug-x");
    expect(items.length).toBe(10);
  });
});
