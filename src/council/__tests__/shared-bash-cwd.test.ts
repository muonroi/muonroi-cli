/**
 * Council tools must never move the caller's BashTool cwd.
 *
 * Evidence: live `/ideal` session 7b2886c90a51 (2026-11-09). `createCouncilLLM`
 * was handed the MAIN session's BashTool; the research path builds the full
 * builtin set (including bash) on it, and the bash tool's in-band `cd` handler
 * permanently mutates `BashTool.cwd`. A council member `cd`'d into a sibling
 * `probe/` project, the session's cwd_last ended there (outside the run root),
 * the planning tree resolved empty, and the run was declared complete.
 *
 * These tests run a real `cd` through whatever BashTool `createBuiltinTools`
 * receives from `research()` / `debate()` and assert the session's tool did not
 * move.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashTool } from "../../tools/bash.js";

const FINISH = { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } };

type ToolBag = Record<string, { execute?: (input: { command: string }) => Promise<unknown> }>;

let root: string;
let sub: string;

beforeEach(() => {
  vi.resetModules();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "council-bash-cwd-")));
  sub = path.join(root, "sub");
  mkdirSync(sub);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Wire the mocks. `createBuiltinTools` is replaced by a stub whose tools run the
 * command on the BashTool it was GIVEN, so what the test observes is exactly
 * which BashTool createCouncilLLM hands to the tool factory. `ai.streamText`
 * then executes that tool (as the model would) before replaying a text reply.
 */
function wire(toolName: "bash" | "grep", command: string, received: BashTool[]) {
  vi.doMock("ai", () => ({
    generateText: vi.fn(),
    stepCountIs: vi.fn().mockReturnValue({}),
    streamText: vi.fn().mockImplementation((args: { tools?: ToolBag }) => ({
      fullStream: (async function* () {
        // The model "calls" the tool mid-stream, exactly as a real tool step would.
        await args.tools?.[toolName]?.execute?.({ command });
        yield { type: "text-delta", text: "ok" };
        yield FINISH;
      })(),
    })),
  }));
  // The tool wrapper pings the EE intercept before each call; keep it offline.
  vi.doMock("../../ee/intercept.js", () => ({
    getDefaultEEClient: () => ({ intercept: async () => ({ matches: [] }) }),
  }));
  vi.doMock("../../ee/render.js", () => ({ emitMatches: vi.fn() }));
  vi.doMock("../../providers/keychain.js", () => ({
    loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
  }));
  vi.doMock("../../providers/runtime.js", () => ({
    hasProviderFactory: vi.fn().mockReturnValue(true),
    detectProviderForModel: vi.fn().mockReturnValue("openai"),
    createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
    createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
    resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    shouldDropParam: vi.fn().mockReturnValue(false),
    resolveMaxOutputTokensParam: vi.fn((_rt: unknown, n: number) => ({ maxOutputTokens: n })),
  }));
  vi.doMock("../../tools/registry.js", () => ({
    createBuiltinTools: vi.fn().mockImplementation((b: BashTool) => {
      received.push(b);
      const run = async ({ command }: { command: string }) => b.execute(command);
      return { bash: { execute: run }, grep: { execute: run }, read_file: { execute: run } };
    }),
  }));
  vi.doMock("../../mcp/runtime.js", () => ({
    buildMcpToolSet: vi.fn().mockResolvedValue({ tools: {}, errors: [], close: vi.fn().mockResolvedValue(undefined) }),
  }));
  vi.doMock("../../utils/settings.js", () => ({
    loadMcpServers: vi.fn().mockReturnValue([]),
    getProviderStallTimeoutMs: vi.fn().mockReturnValue(0),
  }));
}

describe("council tools run on a fork, never the session's BashTool", () => {
  it("research(): a `cd` through the council bash tool leaves the session cwd unchanged", async () => {
    const session = new BashTool(root);
    const received: BashTool[] = [];
    wire("bash", `cd "${sub}"`, received);

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM(session, "agent", undefined, stats);
    await llm.research("gpt-4o", "inspect the repo", "", undefined);

    expect(received).toHaveLength(1);
    expect(received[0]).not.toBe(session);
    // The member's cd really ran (on the fork) ...
    expect(received[0]!.getCwd()).toBe(sub);
    // ... and the session's tool did not move.
    expect(session.getCwd()).toBe(root);
  });

  it("debate() with verification tools: tools are built on a fork, session cwd unchanged", async () => {
    const session = new BashTool(root);
    const received: BashTool[] = [];
    wire("grep", `cd "${sub}"`, received);

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM(session, "agent", undefined, stats);
    await llm.debate("gpt-4o", "system", "prompt", undefined, undefined, { enableVerificationTools: true });

    expect(received).toHaveLength(1);
    expect(received[0]).not.toBe(session);
    expect(received[0]!.getCwd()).toBe(sub);
    expect(session.getCwd()).toBe(root);
  });

  it("each research call gets its own fork starting at the session's CURRENT cwd", async () => {
    const session = new BashTool(root);
    const received: BashTool[] = [];
    wire("bash", `cd "${sub}"`, received);

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM(session, "agent", undefined, stats);
    await llm.research("gpt-4o", "first", "", undefined);
    // The previous member's cd must not leak into the next member's start point.
    await llm.research("gpt-4o", "second", "", undefined);

    expect(received).toHaveLength(2);
    expect(received[0]).not.toBe(received[1]);
    expect(session.getCwd()).toBe(root);
  });
});

describe("BashTool.fork", () => {
  it("starts at the parent's cwd, then diverges: a cd on the fork never moves the parent (and vice versa)", async () => {
    const parent = new BashTool(root);
    const child = parent.fork();
    expect(child.getCwd()).toBe(root);

    const res = await child.execute(`cd "${sub}"`);
    expect(res.success).toBe(true);
    expect(child.getCwd()).toBe(sub);
    expect(parent.getCwd()).toBe(root);

    parent.setCwd(sub);
    const other = path.join(root, "other");
    mkdirSync(other);
    parent.setCwd(other);
    expect(child.getCwd()).toBe(sub);
  });

  it("carries sandbox and shell settings, and forks workerScope only on request", async () => {
    const parent = new BashTool(root, { sandboxSettings: { allowNet: false }, shellSettings: {} });
    expect(parent.fork().getSandboxSettings()).toBe(parent.getSandboxSettings());

    // workerScope refuses process termination before running anything.
    const open = await parent.fork().execute("kill -9 999999");
    expect(open.error ?? "").not.toContain("worker_process_boundary");
    const scoped = await parent.fork({ workerScope: true }).execute("kill -9 999999");
    expect(scoped.success).toBe(false);
    expect(scoped.error).toContain("worker_process_boundary");
  });
});
