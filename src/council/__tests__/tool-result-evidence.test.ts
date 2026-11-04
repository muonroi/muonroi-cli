import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText: streamMock }));

import { completeDelegation, DelegationManager, saveDelegationToolResult } from "../../orchestrator/delegations.js";
import { __testCollectStreamText as collectStreamText } from "../llm.js";

const base = { model: {} as never, system: "system", prompt: "prompt" };
function stream(parts: Record<string, unknown>[]) {
  streamMock.mockReturnValueOnce({
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
  });
}
const call = {
  type: "tool-call",
  toolCallId: "actual-sdk-call",
  toolName: "docs_search",
  input: { query: "messaging" },
};
const result = { type: "tool-result", toolCallId: "actual-sdk-call", output: { chunks: [{ title: "Messaging" }] } };

describe("council host tool-result evidence", () => {
  it("persists observed results with model/phase provenance and retrieves them by the owner after restart", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "council-sdk-evidence-"));
    const cwd = path.join(home, "workspace");
    const dir = path.join(
      home,
      "delegations",
      `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`,
    );
    const jobPath = path.join(dir, "council-fixture.json");
    fs.mkdirSync(dir, { recursive: true });
    vi.stubEnv("MUONROI_CLI_HOME", home);
    try {
      fs.writeFileSync(
        jobPath,
        JSON.stringify({
          id: "council-fixture",
          kind: "council",
          agent: "council",
          description: "SDK fixture",
          prompt: "Read evidence",
          cwd,
          model: "fixture-model",
          sandboxMode: "off",
          maxToolRounds: 2,
          maxTokens: 100,
          status: "running",
          startedAt: new Date().toISOString(),
          outputPath: path.join(dir, "council-fixture.md"),
          parentSessionId: "owner",
        }),
      );
      const output = { content: "observed output\n".repeat(300), tail: "EXACT_COUNCIL_TAIL" };
      stream([call, { ...result, output }]);
      await collectStreamText({
        ...base,
        onToolResult: (r) =>
          saveDelegationToolResult(jobPath, r.toolCallId, r.toolName, r.input, r.output, {
            modelId: "fixture-model",
            phase: "research",
          }),
      });
      await completeDelegation(jobPath, "Advice is not independent verification.");
      const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      expect(job.toolArtifacts).toHaveLength(1);
      const main = new DelegationManager(
        () => cwd,
        () => "owner",
      );
      const read = await main.readToolArtifact(job.id, call.toolCallId, job.resultVersion, 0, 24000);
      expect(read.success).toBe(true);
      expect(read.output).toContain("EXACT_COUNCIL_TAIL");
      expect(read.output).toContain('"provenance":{"modelId":"fixture-model","phase":"research"}');
      expect((await main.readToolArtifact(job.id, job.resultVersion, job.resultVersion)).success).toBe(false);
      const foreign = new DelegationManager(
        () => cwd,
        () => "foreign-owner",
      );
      expect((await foreign.readToolArtifact(job.id, call.toolCallId, job.resultVersion)).success).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it("awaits the matched SDK result with exact ID/input/output before consuming more text", async () => {
    let saved = false;
    streamMock.mockReturnValueOnce({
      fullStream: (async function* () {
        yield call;
        yield result;
        expect(saved).toBe(true);
        yield { type: "text-delta", text: "advice" };
      })(),
    });
    const onToolResult = vi.fn(async () => {
      await Promise.resolve();
      saved = true;
    });
    const collected = await collectStreamText({ ...base, onToolResult } as Parameters<typeof collectStreamText>[0]);
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      output: result.output,
    });
    expect(collected.text).toBe("advice");
  });
  it("never archives unexecuted calls, unmatched results or model text claiming a digest", async () => {
    stream([
      call,
      { ...result, toolCallId: "not-a-call" },
      { type: "text-delta", text: "I independently checked digest ABC" },
    ]);
    const onToolResult = vi.fn();
    await collectStreamText({ ...base, onToolResult } as Parameters<typeof collectStreamText>[0]);
    expect(onToolResult).not.toHaveBeenCalled();
  });
  it("propagates persistence failure instead of treating missing evidence as a completed capture", async () => {
    stream([call, result]);
    const onToolResult = vi.fn(async () => {
      throw new Error("artifact write failed");
    });
    await expect(
      collectStreamText({ ...base, onToolResult } as Parameters<typeof collectStreamText>[0]),
    ).rejects.toThrow("artifact write failed");
  });
  it("retains a completed result even when the provider stream fails afterwards", async () => {
    stream([call, result, { type: "error", error: new Error("provider interrupted") }]);
    const onToolResult = vi.fn();
    await expect(
      collectStreamText({ ...base, onToolResult } as Parameters<typeof collectStreamText>[0]),
    ).rejects.toThrow("provider interrupted");
    expect(onToolResult).toHaveBeenCalledOnce();
  });
  it("captures a matched tool error as failure evidence without turning it into success", async () => {
    stream([call, { type: "tool-error", toolCallId: call.toolCallId, error: new Error("MCP denied") }]);
    const onToolResult = vi.fn();
    await collectStreamText({ ...base, onToolResult });
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      output: { error: "MCP denied" },
    });
  });
});
