import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultEEClient } from "../../ee/intercept.js";
import { composeRunTranscript, extractRunToEE } from "../cross-run-memory.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeFlowDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `ete-test-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function seedRunFiles(flowDir: string, runId: string, files: Record<string, string>): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(runDir, name), content, "utf8");
  }
}

function makeStubClient(
  returnValue: { ok: boolean; mistakes?: number; stored?: number } | null,
): ReturnType<typeof import("../../ee/client.js").createEEClient> {
  return {
    extract: vi.fn().mockResolvedValue(returnValue),
    intercept: vi.fn(),
    promptStale: vi.fn(),
    stats: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    searchPoints: vi.fn(),
  } as unknown as ReturnType<typeof import("../../ee/client.js").createEEClient>;
}

function makeThrowingClient(): ReturnType<typeof import("../../ee/client.js").createEEClient> {
  return {
    extract: vi.fn().mockRejectedValue(new Error("unexpected network failure")),
    intercept: vi.fn(),
    promptStale: vi.fn(),
    stats: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    searchPoints: vi.fn(),
  } as unknown as ReturnType<typeof import("../../ee/client.js").createEEClient>;
}

// ─── composeRunTranscript ─────────────────────────────────────────────────────

describe("composeRunTranscript", () => {
  let flowDir: string;

  beforeEach(async () => {
    flowDir = await makeFlowDir();
  });

  afterEach(async () => {
    await fs.rm(flowDir, { recursive: true, force: true });
  });

  it("returns all 4 sections in order when all files are present", async () => {
    await seedRunFiles(flowDir, "run-01", {
      "manifest.md": "manifest content",
      "roadmap.md": "roadmap content",
      "delegations.md": "delegations content",
      "gray-areas.md": "gray areas content",
    });

    const result = await composeRunTranscript(flowDir, "run-01");

    // Verify all four section headers appear in the correct order
    const manifestIdx = result.indexOf("# manifest.md");
    const roadmapIdx = result.indexOf("# roadmap.md");
    const delegationsIdx = result.indexOf("# delegations.md");
    const grayAreasIdx = result.indexOf("# gray-areas.md");

    expect(manifestIdx).toBeGreaterThan(-1);
    expect(roadmapIdx).toBeGreaterThan(manifestIdx);
    expect(delegationsIdx).toBeGreaterThan(roadmapIdx);
    expect(grayAreasIdx).toBeGreaterThan(delegationsIdx);

    expect(result).toContain("manifest content");
    expect(result).toContain("roadmap content");
    expect(result).toContain("delegations content");
    expect(result).toContain("gray areas content");
  });

  it("returns only manifest section when only manifest.md is present", async () => {
    await seedRunFiles(flowDir, "run-02", {
      "manifest.md": "only manifest",
    });

    const result = await composeRunTranscript(flowDir, "run-02");

    expect(result).toContain("# manifest.md");
    expect(result).toContain("only manifest");
    expect(result).not.toContain("# roadmap.md");
    expect(result).not.toContain("# delegations.md");
    expect(result).not.toContain("# gray-areas.md");
  });

  it("returns empty string when no files are present", async () => {
    await seedRunFiles(flowDir, "run-03", {});

    const result = await composeRunTranscript(flowDir, "run-03");
    expect(result).toBe("");
  });

  it("truncates to 32768 bytes and appends [...truncated] when over limit", async () => {
    // Create content that will exceed 32KB after header is prepended
    // The section header `\n\n# manifest.md\n\n` is 18 chars, so content needs to push past 32768
    const bigContent = "A".repeat(33000);
    await seedRunFiles(flowDir, "run-04", {
      "manifest.md": bigContent,
    });

    const result = await composeRunTranscript(flowDir, "run-04");

    // Result should be exactly 32768 chars + the truncation marker
    const TRUNCATION_MARKER = "\n\n[...truncated]";
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.length).toBe(32768 + TRUNCATION_MARKER.length);
  });
});

// ─── extractRunToEE ───────────────────────────────────────────────────────────

describe("extractRunToEE", () => {
  let flowDir: string;

  beforeEach(async () => {
    flowDir = await makeFlowDir();
  });

  afterEach(async () => {
    await fs.rm(flowDir, { recursive: true, force: true });
  });

  it("returns ok=true with mistakes/stored and calls extract with correct meta", async () => {
    await seedRunFiles(flowDir, "run-xyz", {
      "manifest.md": "some transcript content",
    });

    const stub = makeStubClient({ ok: true, mistakes: 3, stored: 7 });
    setDefaultEEClient(stub);

    const result = await extractRunToEE(flowDir, "run-xyz", "/projects/foo");

    expect(result.ok).toBe(true);
    expect(result.mistakes).toBe(3);
    expect(result.stored).toBe(7);
    expect(result.durationMs).toBeGreaterThan(0);

    expect(stub.extract).toHaveBeenCalledOnce();
    const callArg = vi.mocked(stub.extract).mock.calls[0][0];
    expect(callArg.meta?.scope).toBe("ideal:run-xyz");
    expect(callArg.meta?.source).toBe("cli-exit");
    expect(callArg.projectPath).toBe("/projects/foo");
  });

  it("returns ok=false with durationMs when EE returns null (network failure)", async () => {
    await seedRunFiles(flowDir, "run-net", {
      "manifest.md": "transcript text",
    });

    const stub = makeStubClient(null);
    setDefaultEEClient(stub);

    const result = await extractRunToEE(flowDir, "run-net", "/projects/bar");

    expect(result.ok).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(stub.extract).toHaveBeenCalledOnce();
  });

  it("returns ok=false with durationMs when EE client throws", async () => {
    await seedRunFiles(flowDir, "run-throw", {
      "manifest.md": "transcript text",
    });

    const throwing = makeThrowingClient();
    setDefaultEEClient(throwing);

    const result = await extractRunToEE(flowDir, "run-throw", "/projects/baz");

    expect(result.ok).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok=false durationMs=0 and does NOT call EE when transcript is empty", async () => {
    // No files seeded — empty run dir
    await seedRunFiles(flowDir, "run-empty", {});

    const stub = makeStubClient({ ok: true, mistakes: 0, stored: 0 });
    setDefaultEEClient(stub);

    const result = await extractRunToEE(flowDir, "run-empty", "/projects/empty");

    expect(result.ok).toBe(false);
    expect(result.durationMs).toBe(0);
    expect(stub.extract).not.toHaveBeenCalled();
  });
});
