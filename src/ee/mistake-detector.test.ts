import { beforeEach, describe, expect, it } from "vitest";
import { _internals, MistakeDetector } from "./mistake-detector.js";

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
    expect(_internals.jaccardSimilarity(a, b)).toBeCloseTo(0.5, 3);
  });

  it("returns 1 when both sets are empty", () => {
    expect(_internals.jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty", () => {
    expect(_internals.jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("mistake-detector / path extraction", () => {
  it("extracts file_path from Edit tool input", () => {
    expect(_internals.extractFilePath("Edit", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("extracts path from MCP edit_file tool input", () => {
    expect(_internals.extractFilePath("mcp__filesystem__edit_file", { path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("extracts path from lowercase write_file tool input", () => {
    expect(_internals.extractFilePath("write_file", { path: "src/foo.ts", content: "x" })).toBe("src/foo.ts");
  });

  it("returns null for non-edit tools", () => {
    expect(_internals.extractFilePath("Bash", { command: "ls" })).toBeNull();
    expect(_internals.extractFilePath("Read", { file_path: "src/foo.ts" })).toBeNull();
  });

  it("normalizes Windows drive letters and backslashes", () => {
    expect(_internals.extractFilePath("Edit", { file_path: "D:\\src\\Foo.ts" })).toBe("d:/src/Foo.ts");
  });

  it("returns null for missing/empty path", () => {
    expect(_internals.extractFilePath("Edit", {})).toBeNull();
    expect(_internals.extractFilePath("Edit", { file_path: "" })).toBeNull();
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
    for (let i = 0; i < 4; i++) {
      det.recordPreTool("Bash", { command: `echo ${i}` }, false);
      det.recordPostTool("Bash", true);
    }
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, false);
    det.recordPostTool("Edit", true);
    expect(det.detectRetryPattern()).toBeNull();
  });
});

describe("mistake-detector / file-revert", () => {
  let det: MistakeDetector;
  beforeEach(() => {
    det = new MistakeDetector();
  });

  it("fires when current edit targets a prior-batch file that had warnings", () => {
    // Prior batch: agent edits foo.ts with a warning surfaced.
    det.recordPreTool("Edit", { file_path: "src/foo.ts", old_string: "a", new_string: "b" }, true);
    det.recordPostTool("Edit", true);
    // Turn boundary.
    det.resetBatch();
    // New turn: re-edit on same file → revert detected.
    const events = det.detectFileRevert("Edit", { file_path: "src/foo.ts", old_string: "b", new_string: "c" });
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("user-veto");
    expect(events[0]!.evidence.signal).toBe("file-revert");
    expect(events[0]!.evidence.filePath).toBe("src/foo.ts");
  });

  it("emits one event per matching prior-batch entry on the same file", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, true);
    det.recordPostTool("Edit", true);
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, true);
    det.recordPostTool("Edit", true);
    det.resetBatch();
    const events = det.detectFileRevert("Edit", { file_path: "src/foo.ts" });
    expect(events.length).toBe(2);
  });

  it("skips when prior-batch entry on the same file had no warnings", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, false);
    det.recordPostTool("Edit", true);
    det.resetBatch();
    expect(det.detectFileRevert("Edit", { file_path: "src/foo.ts" }).length).toBe(0);
  });

  it("skips when current edit is on a different file", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, true);
    det.recordPostTool("Edit", true);
    det.resetBatch();
    expect(det.detectFileRevert("Edit", { file_path: "src/bar.ts" }).length).toBe(0);
  });

  it("matches across different edit tool variants on the same file", () => {
    // Prior batch wrote with Write; current batch edits with mcp edit_file.
    det.recordPreTool("Write", { file_path: "src/foo.ts", content: "x" }, true);
    det.recordPostTool("Write", true);
    det.resetBatch();
    const events = det.detectFileRevert("mcp__filesystem__edit_file", { path: "src/foo.ts" });
    expect(events.length).toBe(1);
    expect(events[0]!.evidence.nextEditTool).toBe("mcp__filesystem__edit_file");
  });

  it("does not fire on the same-turn re-edit (only across turn boundary)", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, true);
    det.recordPostTool("Edit", true);
    // No resetBatch() — still same turn.
    expect(det.detectFileRevert("Edit", { file_path: "src/foo.ts" }).length).toBe(0);
  });

  it("does not fire on non-edit tools (e.g. Read of the same file)", () => {
    det.recordPreTool("Edit", { file_path: "src/foo.ts" }, true);
    det.recordPostTool("Edit", true);
    det.resetBatch();
    expect(det.detectFileRevert("Read", { file_path: "src/foo.ts" }).length).toBe(0);
  });
});

describe("mistake-detector / abort", () => {
  let det: MistakeDetector;
  beforeEach(() => {
    det = new MistakeDetector();
  });

  it("emits one event per current-batch tool that had warnings", () => {
    det.recordPreTool("Edit", { file_path: "a.ts" }, true);
    det.recordPostTool("Edit", true);
    det.recordPreTool("Edit", { file_path: "b.ts" }, true);
    det.recordPostTool("Edit", true);
    const events = det.detectAbort("user-pressed-esc");
    expect(events.length).toBe(2);
    expect(events.every((e) => e.kind === "user-veto")).toBe(true);
    expect(events[0]!.evidence.signal).toBe("abort");
    expect(events[0]!.evidence.reason).toBe("user-pressed-esc");
  });

  it("skips tools without warnings (avoid noise on unrelated abort)", () => {
    det.recordPreTool("Bash", { command: "git status" }, false);
    det.recordPostTool("Bash", true);
    expect(det.detectAbort().length).toBe(0);
  });

  it("only fires for current batch — resetBatch clears", () => {
    det.recordPreTool("Edit", { file_path: "a.ts" }, true);
    det.recordPostTool("Edit", true);
    det.resetBatch();
    expect(det.detectAbort().length).toBe(0);
  });
});

describe("mistake-detector / resetBatch", () => {
  it("captures prior batch and clears current", () => {
    const det = new MistakeDetector();
    det.recordPreTool("Edit", { file_path: "a.ts" }, true);
    det.recordPostTool("Edit", true);
    det.resetBatch();
    const snap = det.snapshot();
    expect(snap.batch.length).toBe(0);
    expect(snap.priorBatch.length).toBe(1);
    expect(snap.priorBatch[0]!.toolName).toBe("Edit");
    // Ring still preserved.
    expect(snap.ring.length).toBe(1);
  });
});
