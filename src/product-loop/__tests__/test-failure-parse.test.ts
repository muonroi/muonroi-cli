import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFailingTestIds } from "../test-failure-parse.js";

/**
 * The delta gate is only as good as its ability to name a failing test. These
 * tests pin the grammars against output shapes real runners emit — including
 * the VERBATIM tail recorded by the /ideal run that motivated the change.
 */

const FIXTURE = join(import.meta.dirname, "fixtures", "tcis-mttwpmu8ee5b-sprint-1-verify.md");

describe("parseFailingTestIds — the real artifact", () => {
  const recorded = readFileSync(FIXTURE, "utf8");

  it("names every failing test in the recorded tcis-libraries sprint-1 output", () => {
    const { ids, formats } = parseFailingTestIds(recorded);

    expect(formats).toEqual(["xunit"]);
    // 24 fully-formed identities plus one clipped by the artifact's own
    // truncation marker (see the truncation test below).
    expect(ids.length).toBe(25);
    expect(ids).toContain(
      "TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.TenantSchemaWins_OverFallbackSchema",
    );
    expect(ids).toContain(
      "TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.TenantSeesOnlyItsOwnRows",
    );
    expect(ids).toContain(
      "TCIS.EventBus.Kafka.IntegrationTests.KafkaReceivePathIntegrationTests.Publish_and_consume_round_trip_through_a_real_broker",
    );
  });

  it("keeps parameterised xUnit cases distinct", () => {
    const ids = parseFailingTestIds(recorded).ids.filter((i) =>
      i.includes("InjectionPayloadInFallbackSchema_IsRejectedAtConstruction"),
    );
    expect(ids).toHaveLength(2);
    expect(ids.some((i) => i.includes("DROP TABLE gate_transactions"))).toBe(true);
  });

  it("shows why the floor must parse the FULL output, not a tail", () => {
    // The recorded artifact is an already-truncated tail: its first visible
    // line is a test name clipped mid-word. Parsing a tail therefore invents an
    // identity ("ts.UnknownSchema…") that would look NEWLY failing next run.
    // verify-floor.runFloorCommand parses `combined` before `tail()` for exactly
    // this reason.
    expect(parseFailingTestIds(recorded).ids).toContain("ts.UnknownSchema_FailsLoudly_AtQueryTime");
  });
});

describe("parseFailingTestIds — runner grammars", () => {
  it("reads vstest / dotnet test default reporter lines", () => {
    const out = [
      "  Failed Ns.Cls.MethodA [12 ms]",
      "    X Ns.Cls.MethodB [< 1 ms]",
      "Failed!  - Failed: 2, Passed: 8",
    ].join("\n");
    const { ids, formats } = parseFailingTestIds(out);
    expect(formats).toEqual(["vstest"]);
    expect(ids).toEqual(["Ns.Cls.MethodA", "Ns.Cls.MethodB"]);
  });

  it("reads vitest, jest, pytest, go and cargo failure lines", () => {
    expect(parseFailingTestIds(" FAIL  src/a.test.ts > suite > name").ids).toEqual(["src/a.test.ts > suite > name"]);
    expect(parseFailingTestIds("   × suite > name 3ms").ids).toEqual(["suite > name"]);
    expect(parseFailingTestIds("  ● MySuite › does a thing").ids).toEqual(["MySuite › does a thing"]);
    expect(parseFailingTestIds("FAILED tests/test_x.py::test_name - AssertionError").ids).toEqual([
      "tests/test_x.py::test_name",
    ]);
    expect(parseFailingTestIds("--- FAIL: TestFoo (0.00s)").ids).toEqual(["TestFoo"]);
    expect(parseFailingTestIds("test tests::foo ... FAILED").ids).toEqual(["tests::foo"]);
  });

  it("yields the SAME id for the same test across runs with different durations", () => {
    const a = parseFailingTestIds("  Failed Ns.Cls.M [12 ms]").ids;
    const b = parseFailingTestIds("  Failed Ns.Cls.M [1408 ms]").ids;
    // Without duration stripping every pre-existing failure would read as new.
    expect(a).toEqual(b);
  });

  it("ignores colour codes so a TTY run matches a piped one", () => {
    const esc = String.fromCharCode(27);
    const coloured = `${esc}[31m  Failed Ns.Cls.M [12 ms]${esc}[0m`;
    expect(parseFailingTestIds(coloured).ids).toEqual(["Ns.Cls.M"]);
  });

  it("does not turn prose into a test identity", () => {
    const prose = [
      "The login test failed last week and nobody fixed it.",
      "I think this FAILED because of a flake.",
      "Note: build succeeded.",
    ].join("\n");
    expect(parseFailingTestIds(prose).ids).toEqual([]);
    expect(parseFailingTestIds("").ids).toEqual([]);
  });

  it("drops runner summary lines that would churn between runs", () => {
    const out = [" FAIL  src/a.test.ts > real > case", "Failed: 3", "Total tests: 42"].join("\n");
    expect(parseFailingTestIds(out).ids).toEqual(["src/a.test.ts > real > case"]);
  });
});
