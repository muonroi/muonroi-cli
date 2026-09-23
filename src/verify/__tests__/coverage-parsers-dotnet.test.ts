/**
 * The .NET branch of `extractCoverageFromOutput`.
 *
 * Why it exists: before this, the dispatcher's `switch` had no `dotnet` case, so
 * a .NET repo fell through to the default Istanbul-style match, which `dotnet
 * test` output never satisfies. That meant coverage on every .NET repo could ONLY
 * ever come from a number the verify sub-agent hand-wrote — and when it did not,
 * `done-gate.ts` read the absence as zero. Run `muauw6u93e1c` scored 0 on both
 * sprints for that reason.
 *
 * The expected shape is taken from coverlet's own renderer, not invented — see
 * `parseDotnetCoverage`'s doc comment for the source lines
 * (`CoverageSummary.BuildCoverageSummaryTable` + `ConsoleTable.ToStringAlternative`).
 */

import { describe, expect, it } from "vitest";
import { extractCoverageFromOutput, parseDotnetCoverage } from "../coverage-parsers.js";

/**
 * coverlet's summary as `ToStringAlternative()` renders it: `+---+` dividers and
 * `| {0,-N} | ... |` rows, percentages in InvariantCulture with a literal `%`.
 */
const COVERLET_OUTPUT = `
Calculating coverage result...
  Generating report 'D:\\repo\\coverage.cobertura.xml'

+-----------------------+------+--------+--------+
| Module                | Line | Branch | Method |
+-----------------------+------+--------+--------+
| TCIS.CodeStandards    | 78%  | 64.7%  | 81.2%  |
+-----------------------+------+--------+--------+
| TCIS.EventBus         | 55%  | 40%    | 60%    |
+-----------------------+------+--------+--------+

+---------+-------+--------+--------+
|         | Line  | Branch | Method |
+---------+-------+--------+--------+
| Total   | 67.5% | 52.3%  | 70.6%  |
+---------+-------+--------+--------+
| Average | 66.5% | 52.35% | 70.6%  |
+---------+-------+--------+--------+
`;

/**
 * A REAL `dotnet test` run with no coverage collection — the exact situation of
 * run `muauw6u93e1c`. Excerpt copied from
 * `D:\sources\CompanyLibs\tcis-libraries\.muonroi-cli\verify-artifacts\test.log`,
 * whose 20KB contain no percent table, no "Total" row and no "coverage" at all.
 */
const REAL_DOTNET_TEST_OUTPUT_NO_COVERAGE = `
Failed!  - Failed:    19, Passed:     0, Skipped:     0, Total:    19, Duration: 27 ms - TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.dll (net8.0)

Passed!  - Failed:     0, Passed:    17, Skipped:     0, Total:    17, Duration: 3 s - TCIS.Logging.Wolverine.Tests.dll (net8.0)

Passed!  - Failed:     0, Passed:    87, Skipped:     0, Total:    87, Duration: 7 s - TCIS.EventBus.Tests.dll (net8.0)
`;

describe("parseDotnetCoverage", () => {
  it("reads the Line column of coverlet's Total row", () => {
    expect(parseDotnetCoverage(COVERLET_OUTPUT)).toBe(0.675);
  });

  it("ignores the Average row (a mean of per-module percentages)", () => {
    // 0.665 is the Average line figure; it must not be what comes back.
    expect(parseDotnetCoverage(COVERLET_OUTPUT)).not.toBe(0.665);
  });

  it("parses an integer percentage", () => {
    const out = ["|         | Line | Branch | Method |", "| Total   | 91%  | 80%    | 88%    |"].join("\n");
    expect(parseDotnetCoverage(out)).toBe(0.91);
  });

  it("parses a measured ZERO as 0, not as null — the two mean different things", () => {
    const out = ["|         | Line | Branch | Method |", "| Total   | 0%   | 0%     | 0%     |"].join("\n");
    expect(parseDotnetCoverage(out)).toBe(0);
  });

  it("returns null on a real `dotnet test` run that printed no coverage", () => {
    expect(parseDotnetCoverage(REAL_DOTNET_TEST_OUTPUT_NO_COVERAGE)).toBeNull();
  });

  it("returns null rather than guessing when the row is not coverlet's shape", () => {
    // `Total:` appears all over vstest's own summary lines; none of them is a
    // coverage figure, and matching one would invent a measurement.
    expect(parseDotnetCoverage("Total: 19, Duration: 27 ms")).toBeNull();
    expect(parseDotnetCoverage("| Total   | n/a  |")).toBeNull();
    // InvariantCulture always emits a `.` separator, so a comma form is not
    // coverlet output and is not accepted.
    expect(parseDotnetCoverage("| Total   | 67,5% |")).toBeNull();
  });

  it("returns null on empty output", () => {
    expect(parseDotnetCoverage("")).toBeNull();
  });
});

describe("extractCoverageFromOutput — dotnet dispatch", () => {
  it("routes the `dotnet` ecosystem to the coverlet grammar", () => {
    expect(extractCoverageFromOutput(COVERLET_OUTPUT, "dotnet")).toBe(0.675);
  });

  it("routes `csharp` the same way, case-insensitively", () => {
    expect(extractCoverageFromOutput(COVERLET_OUTPUT, "CSharp")).toBe(0.675);
  });

  it("returns null for the real uninstrumented .NET run — the run muauw6u93e1c case", () => {
    expect(extractCoverageFromOutput(REAL_DOTNET_TEST_OUTPUT_NO_COVERAGE, "dotnet")).toBeNull();
  });
});
