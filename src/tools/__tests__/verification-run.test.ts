import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVerificationTests } from "../verification-run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function workspace(runner?: string) {
  const dir = mkdtempSync(join(tmpdir(), "bounded-tests-"));
  dirs.push(dir);
  writeFileSync(join(dir, "fixture.test.ts"), "// fixture");
  if (runner) {
    mkdirSync(join(dir, "node_modules/vitest"), { recursive: true });
    writeFileSync(join(dir, "node_modules/vitest/vitest.mjs"), runner);
  }
  return dir;
}
describe("bounded local verification runner", () => {
  it("requires selection when installed runners are ambiguous and supports exact local Jest/Mocha arguments", async () => {
    const cwd = workspace("process.exit(0)");
    for (const [runner, entry] of [
      ["jest", "jest/bin/jest.js"],
      ["mocha", "mocha/bin/mocha.js"],
    ] as const) {
      const target = join(cwd, "node_modules", entry);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "console.log(JSON.stringify(process.argv.slice(2)));process.exit(0)");
      const result = await runVerificationTests(cwd, ["fixture.test.ts"], 1000, undefined, runner);
      expect(result.success).toBe(true);
      expect(result.output).toContain(runner);
      expect(result.output).toContain(runner === "jest" ? "--runTestsByPath" : "--reporter");
    }
    expect((await runVerificationTests(cwd, ["fixture.test.ts"])).output).toContain("Multiple local runners");
  });
  it("runs real Node tests without downloading dependencies and rejects unsupported runner inputs", async () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, "real.test.cjs"),
      "const {test}=require('node:test'); const assert=require('node:assert/strict');test('actual node runner',()=>assert.equal(2+2,4));",
    );
    const result = await runVerificationTests(cwd, ["real.test.cjs"], 5000, undefined, "node");
    expect(result.success).toBe(true);
    expect(result.output).toContain("actual node runner");
    expect((await runVerificationTests(cwd, ["real.test.cjs"], 1000, undefined, "shell" as never)).success).toBe(false);
    expect((await runVerificationTests(cwd, ["fixture.test.ts"], 1000, undefined, "node")).success).toBe(false);
  });
  it("requires an installed workspace virtualenv for pytest and rejects mixed-language tests", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "test_real.py"), "def test_true(): assert True\n");
    expect((await runVerificationTests(cwd, ["test_real.py"], 1000, undefined, "pytest")).output).toContain(
      "virtualenv",
    );
    expect((await runVerificationTests(cwd, ["test_real.py", "fixture.test.ts"])).success).toBe(false);
  });
  it("rejects options, arbitrary code, directories, parent paths and missing local runner", async () => {
    const cwd = workspace();
    for (const files of [
      [],
      ["--help"],
      ["src"],
      ["../../elsewhere.test.ts"],
      ["fixture.test.ts; touch injected"],
      ["fixture.test.ts"],
    ]) {
      expect((await runVerificationTests(cwd, files)).success).toBe(false);
    }
  });
  it("passes only explicit test paths to an installed local runner with no shell expansion", async () => {
    const cwd = workspace("console.log(JSON.stringify(process.argv.slice(2))); process.exit(0);");
    const result = await runVerificationTests(cwd, ["fixture.test.ts"]);
    expect(result.success).toBe(true);
    expect(result.output).toContain('"run"');
    expect(result.output).toContain(JSON.stringify(join(cwd, "fixture.test.ts")));
    expect(result.output).toContain('"--reporter=verbose"');
    expect(result.output).toContain("exit=0");
  });
  it("reports timeout and cancellation as failures rather than a passing partial run", async () => {
    const cwd = workspace("setInterval(() => {}, 1000);");
    expect((await runVerificationTests(cwd, ["fixture.test.ts"], 100)).output).toContain("timed out");
    const controller = new AbortController();
    controller.abort();
    expect((await runVerificationTests(cwd, ["fixture.test.ts"], 1000, controller.signal)).success).toBe(false);
    const runningController = new AbortController();
    const timer = setTimeout(() => runningController.abort(), 100);
    try {
      const result = await runVerificationTests(cwd, ["fixture.test.ts"], 5000, runningController.signal);
      expect(result.success).toBe(false);
      expect(result.output).toContain("cancelled");
    } finally {
      clearTimeout(timer);
    }
  });
  it("rejects existing tests reached through an external directory symlink", async () => {
    const cwd = workspace();
    const external = workspace();
    symlinkSync(external, join(cwd, "outside"), process.platform === "win32" ? "junction" : "dir");
    const result = await runVerificationTests(cwd, ["outside/fixture.test.ts"]);
    expect(result.success).toBe(false);
    expect(result.output).toContain("outside the requested workspace");
  });
});
