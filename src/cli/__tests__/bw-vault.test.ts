import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeBwSecureNote } from "../bw-vault.js";

interface FakeCall {
  cmd: string;
  args: string[];
  input?: string;
}

function makeRunner(scripted: Array<{ status: number; stdout?: string; stderr?: string }>) {
  const calls: FakeCall[] = [];
  let i = 0;
  const runner = (cmd: string, args: string[], input?: string) => {
    calls.push({ cmd, args, input });
    const next = scripted[i++] ?? { status: 0, stdout: "", stderr: "" };
    return {
      pid: 0,
      output: [],
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
      status: next.status,
      signal: null,
    } as any;
  };
  return { runner, calls };
}

describe("writeBwSecureNote", () => {
  let origSession: string | undefined;
  beforeEach(() => {
    origSession = process.env.BW_SESSION;
    process.env.BW_SESSION = "fake-session-token";
  });
  afterEach(() => {
    if (origSession === undefined) delete process.env.BW_SESSION;
    else process.env.BW_SESSION = origSession;
  });

  it("creates a new Secure Note when item does not exist", async () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "2026.4.0\n" }, // bw --version
      { status: 0, stdout: '{"status":"unlocked"}' }, // bw status
      { status: 0, stdout: "[]" }, // bw list items (empty)
      { status: 0, stdout: "ZW5jb2RlZA==" }, // bw encode
      { status: 0, stdout: '{"id":"new-uuid"}' }, // bw create item
      { status: 0, stdout: "Syncing complete." }, // bw sync
    ]);
    const res = await writeBwSecureNote("muonroi-cli/tavily", "tvly-test-1234567890", { runner });
    expect(res).toEqual({ ok: true, action: "created" });
    expect(calls[3].cmd).toBe("bw");
    expect(calls[3].args[0]).toBe("encode");
    expect(calls[3].input).toContain("tvly-test-1234567890");
    expect(calls[4].args.slice(0, 3)).toEqual(["create", "item", "ZW5jb2RlZA=="]);
  });

  it("updates an existing item rather than creating a duplicate", async () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "2026.4.0\n" },
      { status: 0, stdout: '{"status":"unlocked"}' },
      {
        status: 0,
        stdout: JSON.stringify([
          { id: "existing-uuid", name: "muonroi-cli/tavily", notes: "old-key", type: 2 },
        ]),
      },
      { status: 0, stdout: "ZW5jb2RlZA==" },
      { status: 0, stdout: '{"id":"existing-uuid"}' }, // bw edit
      { status: 0, stdout: "Syncing complete." },
    ]);
    const res = await writeBwSecureNote("muonroi-cli/tavily", "tvly-new-1234567890", { runner });
    expect(res).toEqual({ ok: true, action: "updated" });
    expect(calls[4].args.slice(0, 3)).toEqual(["edit", "item", "existing-uuid"]);
  });

  it("returns ok:false when bw is not installed", async () => {
    const { runner } = makeRunner([{ status: 127, stderr: "command not found" }]);
    const res = await writeBwSecureNote("muonroi-cli/tavily", "tvly-x", { runner });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Bitwarden CLI/);
  });

  it("returns ok:false when BW_SESSION is missing", async () => {
    delete process.env.BW_SESSION;
    const { runner } = makeRunner([{ status: 0, stdout: "2026.4.0" }]);
    const res = await writeBwSecureNote("muonroi-cli/tavily", "tvly-x", { runner });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/BW_SESSION/);
  });

  it("returns ok:false when vault is locked", async () => {
    const { runner } = makeRunner([
      { status: 0, stdout: "2026.4.0" },
      { status: 0, stdout: '{"status":"locked"}' },
    ]);
    const res = await writeBwSecureNote("muonroi-cli/tavily", "tvly-x", { runner });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not unlocked/i);
  });
});
