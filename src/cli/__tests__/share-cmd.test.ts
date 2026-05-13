import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordClient } from "../../discord/types.js";
import { runShareCommand } from "../share-cmd.js";

function makeClient(over: Partial<DiscordClient> = {}): DiscordClient {
  return {
    createChannel: vi.fn(),
    getChannelMessages: vi.fn(),
    postMessage: vi.fn().mockResolvedValue({ id: "m" }),
    addChannelPermission: vi.fn().mockResolvedValue(undefined),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("runShareCommand", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let cwd: string;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `share-${Math.random().toString(36).slice(2)}`);
    cwd = path.join(tmpHome, "cwd");
    await fs.mkdir(cwd, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
  });

  it("explicit --product slug + raw user ID + existing channel", async () => {
    await fs.writeFile(
      path.join(tmpHome, "discord-channels.json"),
      JSON.stringify({
        version: 1,
        items: {
          "abc-myprod": {
            productSlug: "abc-myprod",
            channelId: "c1",
            guildId: "g1",
            createdAtUtc: "t",
            displayName: "MyProd",
          },
        },
      }),
    );
    const client = makeClient();
    const result = await runShareCommand({
      cwd,
      user: "123456789012345678",
      product: "abc-myprod",
      client,
    });
    expect(result.kind).toBe("granted");
    expect(client.addChannelPermission).toHaveBeenCalled();
  });

  it("parses <@id> mention format", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd,
      user: "<@123456789012345678>",
      product: "abc",
      client,
    });
    expect(result.kind).toBe("acl-only");
  });

  it("parses <@!id> escaped mention format", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd,
      user: "<@!555555555555555555>",
      product: "abc",
      client,
    });
    expect(result.kind).toBe("acl-only");
  });

  it("rejects malformed user ID", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd,
      user: "@no-digits-here",
      product: "abc",
      client,
    });
    expect(result.kind).toBe("error");
    expect(client.addChannelPermission).not.toHaveBeenCalled();
  });

  it("missing channel → acl-only result, no API call", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd,
      user: "111111111111111111",
      product: "abc",
      client,
    });
    expect(result.kind).toBe("acl-only");
    expect(client.addChannelPermission).not.toHaveBeenCalled();
  });

  it("re-adding same user → already-stakeholder result", async () => {
    const { addStakeholder } = await import("../../product-loop/stakeholder-acl.js");
    await addStakeholder("abc", {
      discordUserId: "111111111111111111",
      displayName: "u",
      addedAtUtc: "t",
      addedBy: "cli",
    });
    const client = makeClient();
    const result = await runShareCommand({
      cwd,
      user: "111111111111111111",
      product: "abc",
      client,
    });
    expect(result.kind).toBe("already-stakeholder");
  });

  it("50007 permission error → error result, ACL persisted", async () => {
    await fs.writeFile(
      path.join(tmpHome, "discord-channels.json"),
      JSON.stringify({
        version: 1,
        items: { abc: { productSlug: "abc", channelId: "c1", guildId: "g1", createdAtUtc: "t", displayName: "x" } },
      }),
    );
    const err = Object.assign(new Error("50007"), { status: 403 });
    const client = makeClient({ addChannelPermission: vi.fn().mockRejectedValue(err) });
    const result = await runShareCommand({
      cwd,
      user: "111111111111111111",
      product: "abc",
      client,
    });
    expect(result.kind).toBe("perm-error");
    const { listStakeholders } = await import("../../product-loop/stakeholder-acl.js");
    expect(await listStakeholders("abc")).toHaveLength(1);
  });

  it("--product missing AND no recent manifest → error", async () => {
    const client = makeClient();
    const result = await runShareCommand({ cwd, user: "111111111111111111", client });
    expect(result.kind).toBe("error");
  });

  it("derives product from most recent manifest when --product absent", async () => {
    const flowDir = path.join(cwd, ".flow", "runs", "r1");
    await fs.mkdir(flowDir, { recursive: true });
    await fs.writeFile(
      path.join(flowDir, "manifest.json"),
      JSON.stringify({
        idea: "Build a chat app",
        capUsd: 10,
        maxSprints: 6,
        doneThreshold: 0.8,
        createdAt: new Date().toISOString(),
      }),
    );
    const client = makeClient();
    const result = await runShareCommand({ cwd, user: "111111111111111111", client });
    expect(result.kind).toBe("acl-only");
  });

  it("skips corrupt manifest JSON when scanning runs dir", async () => {
    const flowDir = path.join(cwd, ".flow", "runs", "r1");
    await fs.mkdir(flowDir, { recursive: true });
    // Write a corrupt manifest — should be skipped gracefully
    await fs.writeFile(path.join(flowDir, "manifest.json"), "{ bad json");
    const client = makeClient();
    // Should fall through to "no manifest found" → error
    const result = await runShareCommand({ cwd, user: "111111111111111111", client });
    expect(result.kind).toBe("error");
  });

  it("corrupt channel mapping JSON → treated as missing channel (acl-only)", async () => {
    await fs.writeFile(path.join(tmpHome, "discord-channels.json"), "{ corrupt }");
    const client = makeClient();
    const result = await runShareCommand({
      cwd,
      user: "111111111111111111",
      product: "abc",
      client,
    });
    // Corrupt mapping = null mapping = acl-only result
    expect(result.kind).toBe("acl-only");
  });
});
