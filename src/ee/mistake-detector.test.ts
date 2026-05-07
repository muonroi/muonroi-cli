import { describe, expect, it, beforeEach } from "vitest";
import { MistakeDetector, _internals } from "./mistake-detector.js";

describe("mistake-detector / tokenize + jaccard", () => {
  it("tokenizes JSON tool input into normalized tokens", () => {
    const tokens = _internals.tokenize({ file_path: "src/Foo.ts", lines: 42 });
    expect(tokens.has("file_path")).toBe(true);
    expect(tokens.has("src")).toBe(true);
    expect(tokens.has("foo")).toBe(true);
    expect(tokens.has("ts")).toBe(true);
    expect(tokens.has("42")).toBe(true);
  });

  it("computes jaccard similarity correctly", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection 2 / union 4 = 0.5
    expect(_internals.jaccardSimilarity(a, b)).toBeCloseTo(0.5, 3);
  });

  it("returns 1 when both sets are empty", () => {
    expect(_internals.jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty", () => {
    expect(_internals.jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("mistake-detector / ring buffer", () => {
  let det: MistakeDetector;
  beforeEach(() => {
    det = new MistakeDetector();
  });

  it("evicts oldest entry when ring exceeds 5", () => {
    for (let i = 0; i < 7; i++) {
      det.recordPreTool("Bash", { command: `echo ${i}` }, false);
    }
    const snap = det.snapshot();
    expect(snap.ring.length).toBe(5);
    // First two were evicted; remaining commands should be 2..6
    const cmds = snap.ring.map((e) => (e.toolInput as { command: string }).command);
    expect(cmds).toEqual(["echo 2", "echo 3", "echo 4", "echo 5", "echo 6"]);
  });

  it("recordPostTool marks the latest matching unfinished entry", () => {
    det.recordPreTool("Bash", { command: "ls" }, false);
    det.recordPreTool("Bash", { command: "pwd" }, false);
    det.recordPostTool("Bash", true);
    const snap = det.snapshot();
    expect(snap.ring[0]!.success).toBeUndefined();
    expect(snap.ring[1]!.success).toBe(true);
  });
});

describe("mistake-detector / retry-pattern", () => {
  let det: MistakeDetector;
  beforeEach(() => {
    det = new MistakeDetector();
  });

  it("detects fail→success on similar args within lookback window", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts", old_string: "a", new_string: "b" }, false);
    det.recordPostTool("Edit", false);
    det.recordPreTool("Edit", { file_path: "src/foo.ts", old_string: "a", new_string: "b" }, false);
    det.recordPostTool("Edit", true);
    const m = det.detectRetryPattern();
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("retry-pattern");
    expect(m!.toolName).toBe("Edit");
    expect((m!.evidence.similarity as number) >= 0.7).toBe(true);
  });

  it("ignores when first attempt also succeeded (legitimate parallel calls)", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, false);
    det.recordPostTool("Edit", true);
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, false);
    det.recordPostTool("Edit", true);
    expect(det.detectRetryPattern()).toBeNull();
  });

  it("ignores when current attempt failed", () => {
    det.recordPreTool("Bash", { command: "npm test" }, false);
    det.recordPostTool("Bash", false);
    det.recordPreTool("Bash", { command: "npm test" }, false);
    det.recordPostTool("Bash", false);
    expect(det.detectRetryPattern()).toBeNull();
  });

  it("ignores when toolInputs are dissimilar", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, false);
    det.recordPostTool("Edit", false);
    det.recordPreTool("Edit", { file_path: "src/totally/different/bar.ts" }, false);
    det.recordPostTool("Edit", true);
    expect(det.detectRetryPattern()).toBeNull();
  });

  it("only looks back 3 turns", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, false);
    det.recordPostTool("Edit", false);
    // 4 unrelated tool calls in between
    for (let i = 0; i < 4; i++) {
      det.recordPreTool("Bash", { command: `echo ${i}` }, false);
      det.recordPostTool("Bash", true);
    }
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, false);
    det.recordPostTool("Edit", true);
    expect(det.detectRetryPattern()).toBeNull();
  });
});

describe("mistake-detector / user-veto", () => {
  let det: MistakeDetector;
  beforeEach(() => {
    det = new MistakeDetector();
  });

  it("fires when veto regex matches AND batch had warnings", () => {
    det.recordPreTool("Edit", { file_path: "src/db.ts" }, true);
    det.recordPostTool("Edit", true);
    const events = det.detectUserVeto("no, that broke the schema migration");
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("user-veto");
    expect(events[0]!.evidence.hadWarnings).toBe(true);
  });

  it("emits one event per tool in the active batch", () => {
    det.recordPreTool("Edit", { file_path: "a.ts" }, true);
    det.recordPostTool("Edit", true);
    det.recordPreTool("Edit", { file_path: "b.ts" }, false);
    det.recordPostTool("Edit", true);
    const events = det.detectUserVeto("undo that");
    expect(events.length).toBe(2);
  });

  it("skips veto when no tool in batch had warnings (avoid noise on unrelated 'no')", () => {
    det.recordPreTool("Bash", { command: "git status" }, false);
    det.recordPostTool("Bash", true);
    const events = det.detectUserVeto("no, let me think");
    expect(events.length).toBe(0);
  });

  it("matches Vietnamese veto words", () => {
    det.recordPreTool("Edit", { file_path: "x.ts" }, true);
    det.recordPostTool("Edit", true);
    expect(det.detectUserVeto("sai rồi, undo đi").length).toBe(1);
    det.resetBatch();
    det.recordPreTool("Edit", { file_path: "y.ts" }, true);
    det.recordPostTool("Edit", true);
    expect(det.detectUserVeto("nhầm rồi").length).toBe(1);
  });

  it("does not fire for benign next-turn messages", () => {
    det.recordPreTool("Edit", { file_path: "x.ts" }, true);
    det.recordPostTool("Edit", true);
    expect(det.detectUserVeto("ok continue").length).toBe(0);
    expect(det.detectUserVeto("looks good, ship it").length).toBe(0);
  });

  it("resetBatch clears the active batch but preserves ring", () => {
    det.recordPreTool("Edit", { file_path: "a.ts" }, true);
    det.recordPostTool("Edit", true);
    det.resetBatch();
    // No batch entries → no veto even if message matches.
    expect(det.detectUserVeto("no undo").length).toBe(0);
    // Ring still has the entry.
    expect(det.snapshot().ring.length).toBe(1);
  });
});
