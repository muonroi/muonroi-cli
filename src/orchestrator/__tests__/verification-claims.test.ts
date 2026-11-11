import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetVerificationLedger,
  buildVerificationFootnote,
  checkVerificationClaims,
  classifyVerificationCommand,
  findVerificationClaims,
  formatHostVerificationRecord,
  outcomesFromMessages,
  outcomesFromToolCall,
  parseHostVerificationRecords,
  type RecordedVerification,
  recordVerifications,
} from "../verification-claims.js";

const passTest: RecordedVerification = {
  id: "c1:test",
  tool: "bash",
  kind: "test",
  command: "bunx vitest run",
  passed: true,
};

describe("classifyVerificationCommand", () => {
  it("recognises test and build runners, including chained and cd-prefixed commands", () => {
    expect(classifyVerificationCommand("bunx vitest run src/a.test.ts")).toEqual(["test"]);
    expect(classifyVerificationCommand("cd D:/x && dotnet test Foo.sln | tail -20")).toEqual(["test"]);
    expect(classifyVerificationCommand("npm test && npm run build")).toEqual(["test", "build"]);
    expect(classifyVerificationCommand("bunx tsc --noEmit")).toEqual(["build"]);
    expect(classifyVerificationCommand("python -m pytest -q")).toEqual(["test"]);
  });

  it("does not treat file reads or unrelated commands that mention test as test runs", () => {
    expect(classifyVerificationCommand("cat test/fixture.txt")).toEqual([]);
    expect(classifyVerificationCommand("grep -rn 'tests pass' src")).toEqual([]);
    expect(classifyVerificationCommand("ls tests")).toEqual([]);
  });
});

describe("outcomesFromToolCall", () => {
  it("bash: success and ERROR outcomes; piped failures override exit 0", () => {
    expect(outcomesFromToolCall("a", "bash", { command: "bunx vitest run" }, "Tests  12 passed (12)")).toMatchObject([
      { kind: "test", passed: true },
    ]);
    expect(outcomesFromToolCall("b", "bash", { command: "bunx vitest run" }, "ERROR: exit 1")).toMatchObject([
      { kind: "test", passed: false },
    ]);
    expect(
      outcomesFromToolCall("c", "bash", { command: "bunx vitest run | tail -5" }, "Tests  2 failed | 10 passed (12)"),
    ).toMatchObject([{ passed: false }]);
  });

  it("bash: a refused or backgrounded command did not run", () => {
    expect(outcomesFromToolCall("d", "bash", { command: "bunx vitest run" }, "ERROR: BLOCKED: refusing")).toEqual([]);
    expect(
      outcomesFromToolCall("e", "bash", { command: "npm test" }, "Started; running in the background (id 3)"),
    ).toEqual([]);
  });

  it("verification_run: launched runner only; validation refusals are not runs", () => {
    const ran = JSON.stringify({ success: true, output: "Local verification runner=vitest: x\ncwd=/r\nexit=0" });
    expect(outcomesFromToolCall("v1", "verification_run", { files: ["a.test.ts"] }, ran)).toMatchObject([
      { kind: "test", passed: true },
    ]);
    const refused = JSON.stringify({ success: false, output: "Test file not found: a.test.ts" });
    expect(outcomesFromToolCall("v2", "verification_run", { files: ["a.test.ts"] }, refused)).toEqual([]);
  });

  it("run_gate: passed/failed verdicts; zero executed tests is not a pass; refusal is not a run", () => {
    expect(outcomesFromToolCall("g1", "run_gate", {}, "gate test `bun test` passed (exit 0, 10ms)")).toMatchObject([
      { kind: "test", passed: true },
    ]);
    expect(
      outcomesFromToolCall(
        "g2",
        "run_gate",
        {},
        "gate test `bun test` passed (exit 0, 10ms)\nzero tests executed (x): y",
      ),
    ).toMatchObject([{ passed: false }]);
    expect(outcomesFromToolCall("g3", "run_gate", {}, "ERROR: run_gate_refused: unknown gate")).toEqual([]);
  });
});

describe("findVerificationClaims", () => {
  it("finds asserted English and Vietnamese test/build claims", () => {
    expect(findVerificationClaims("Done. All tests pass.")).toMatchObject([{ kind: "test", polarity: "pass" }]);
    expect(
      findVerificationClaims("The build succeeded and 12/12 passed.")
        .map((c) => c.kind)
        .sort(),
    ).toEqual(["build", "test"]);
    expect(findVerificationClaims("Đã chạy test, tất cả test đều pass.")).toMatchObject([
      { kind: "test", polarity: "pass" },
    ]);
    expect(findVerificationClaims("I ran the tests.")).toMatchObject([{ kind: "test", polarity: "ran" }]);
  });

  it("ignores quoted, code, question, conditional, future, negated and attributed text", () => {
    const quiet = [
      'The issue title is "all tests pass on CI".',
      "Run `bunx vitest run` until all tests pass.",
      "```\n✓ all tests pass\n```",
      "> all tests pass",
      "Do all tests pass?",
      "If the build succeeds, merge it.",
      "Once the fix lands, all tests pass.",
      "The tests should pass after this change.",
      "Not all tests pass yet.",
      "The build is not green.",
      "The worker reported that all tests pass.",
      "Make sure the build succeeds before pushing.",
      "Nếu test pass thì merge.",
      "Test chưa pass.",
    ];
    for (const text of quiet) expect(findVerificationClaims(text), text).toEqual([]);
  });

  it("keeps apostrophes from swallowing a claim", () => {
    expect(findVerificationClaims("The worker's change is in and all tests pass, it's merged.")).toHaveLength(1);
  });
});

describe("checkVerificationClaims", () => {
  it("flags a pass claim with no recorded run of its kind", () => {
    const flags = checkVerificationClaims("All tests pass.", []);
    expect(flags).toMatchObject([{ kind: "test", reason: expect.stringContaining("no test command ran") }]);
    expect(buildVerificationFootnote(flags)).toContain("Host verification check");
  });

  it("supports a claim backed by a passing latest run and flags one whose latest run failed", () => {
    expect(checkVerificationClaims("All tests pass.", [passTest])).toEqual([]);
    const failedLater = { ...passTest, id: "c2:test", passed: false, command: "bunx vitest run x" };
    expect(checkVerificationClaims("All tests pass.", [passTest, failedLater])).toMatchObject([
      { reason: expect.stringContaining("latest recorded test run failed") },
    ]);
    // A "ran" claim only needs the run to have happened.
    expect(checkVerificationClaims("I ran the tests.", [failedLater])).toEqual([]);
  });

  it("does not let a test run support a build claim", () => {
    expect(checkVerificationClaims("The build succeeded.", [passTest])).toMatchObject([{ kind: "build" }]);
  });
});

describe("conversation scan + host records", () => {
  beforeEach(() => __resetVerificationLedger());

  it("pairs tool calls with their results and reads worker host records", () => {
    const record = formatHostVerificationRecord("worker brave-owl", [passTest]);
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: { command: "bunx tsc --noEmit" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: { type: "text", value: "" } }],
      },
      { role: "system", content: `Background agent complete: \`brave-owl\`\n${record}` },
    ];
    const outcomes = outcomesFromMessages(messages);
    expect(outcomes.map((o) => [o.kind, o.passed, o.source ?? null])).toEqual([
      ["build", true, null],
      ["test", true, "worker brave-owl"],
    ]);
    expect(parseHostVerificationRecords("[host-verification] {bad json")).toEqual([]);
  });

  it("session ledger dedupes by id and survives a history that no longer has the tool messages", () => {
    recordVerifications("s1", [passTest]);
    expect(recordVerifications("s1", [passTest])).toHaveLength(1);
    expect(checkVerificationClaims("All tests pass.", recordVerifications("s1", []))).toEqual([]);
    expect(recordVerifications("other", [])).toEqual([]);
  });
});
