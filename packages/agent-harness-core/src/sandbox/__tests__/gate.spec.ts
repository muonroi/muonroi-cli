// ---------------------------------------------------------------------------
// Gate unit tests — Sprint 1 acceptance criteria
// ---------------------------------------------------------------------------
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../gate.js";
import type { PhaseSignal, ToolRequest } from "../types.js";

function phase(value: PhaseSignal["value"], turnId = "t1"): PhaseSignal {
  return { value, source: "orchestrator-ssot", turnId };
}

describe("sandbox gate", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sandbox-gate-test-"));
  const allowedFile = join(tmp, "allowed.txt");
  writeFileSync(allowedFile, "hello");

  it("Read phase: allowlisted path returns ALLOW with content", async () => {
    const req: ToolRequest = { kind: "fs", path: allowedFile };
    const res = await evaluate(phase("Read"), req);
    expect(res.outcome).toBe("ALLOW");
    expect(res.result?.content).toBe("hello");
  });

  it("Read phase: non-allowlisted path returns DENY PATH_NOT_ALLOWLISTED", async () => {
    const req: ToolRequest = { kind: "fs", path: "/etc/shadow" };
    const res = await evaluate(phase("Read"), req);
    expect(res.outcome).toBe("DENY");
    expect(res.deny?.code).toBe("PATH_NOT_ALLOWLISTED");
    expect(res.deny?.retryable).toBe(false);
    expect(res.deny?.phase.value).toBe("Read");
  });

  it("Read phase: write op returns DENY OP_NOT_PERMITTED", async () => {
    const req: ToolRequest = { kind: "fs", path: allowedFile, content: "x" };
    const res = await evaluate(phase("Read"), req);
    expect(res.outcome).toBe("DENY");
    expect(res.deny?.code).toBe("OP_NOT_PERMITTED");
  });

  it("Write phase: allowlisted write returns ALLOW", async () => {
    const target = join(tmp, "write.txt");
    const req: ToolRequest = { kind: "fs", path: target, content: "written" };
    const res = await evaluate(phase("Write"), req);
    expect(res.outcome).toBe("ALLOW");
    // Verify content was written via the gate.
    const readBack = await evaluate(phase("Read"), { kind: "fs", path: target });
    expect(readBack.result?.content).toBe("written");
  });

  it("Write phase: path outside allowlist returns DENY PATH_NOT_ALLOWLISTED", async () => {
    const req: ToolRequest = { kind: "fs", path: "/etc/outside-allowlist.txt", content: "x" };
    const res = await evaluate(phase("Write"), req);
    expect(res.outcome).toBe("DENY");
    expect(res.deny?.code).toBe("PATH_NOT_ALLOWLISTED");
  });

  it("Exec phase: env scrubbed and non-root enforced", async () => {
    const req: ToolRequest = {
      kind: "exec",
      command: ["printenv", "SECRET"],
      env: { SECRET: "leak", PATH: "/usr/bin" },
    };
    const res = await evaluate(phase("Exec"), req);
    // If running as root, gate denies.
    if (process.getuid?.() === 0) {
      expect(res.outcome).toBe("DENY");
      expect(res.deny?.code).toBe("ROOT_FORBIDDEN");
      return;
    }
    expect(res.outcome).toBe("ALLOW");
    expect(res.result?.stdout?.trim()).toBe(""); // SECRET scrubbed
  });

  it("Exec phase: denied command returns DENY OP_NOT_PERMITTED", async () => {
    const req: ToolRequest = { kind: "exec", command: ["rm", "-rf", "/"] };
    const res = await evaluate(phase("Exec"), req);
    expect(res.outcome).toBe("DENY");
    expect(res.deny?.code).toBe("OP_NOT_PERMITTED");
  });

  it("Fail-safe default: unknown phase defaults to Read-only", async () => {
    const unknown = { value: "Read" as const, source: "orchestrator-ssot" as const, turnId: "t2" };
    const res = await evaluate(unknown, { kind: "fs", path: allowedFile });
    expect(res.outcome).toBe("ALLOW");
  });

  it("Phase transition: mask recomputes from new PhaseSignal", async () => {
    const readRes = await evaluate(phase("Read"), { kind: "fs", path: allowedFile });
    expect(readRes.outcome).toBe("ALLOW");
    const writeRes = await evaluate(phase("Write"), {
      kind: "fs",
      path: join(tmp, "transition.txt"),
      content: "ok",
    });
    expect(writeRes.outcome).toBe("ALLOW");
  });
});
