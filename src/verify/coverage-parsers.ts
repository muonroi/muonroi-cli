/**
 * Parsers for test coverage output from various ecosystems.
 * All parsers return a number between 0 and 1 (e.g., 0.855 for 85.5%),
 * or null if coverage information could not be found.
 */

/**
 * Parses bun test --coverage output.
 * Looks for: "All files | XX.YY |"
 */
export function parseBunCoverage(stdout: string): number | null {
  const match = stdout.match(/All files\s*\|\s*(\d+(?:\.\d+)?)/m);
  if (match) {
    return parseFloat(match[1]) / 100;
  }
  return null;
}

/**
 * Parses vitest coverage output.
 * Usually same format as Istanbul/Jest: "All files | XX.YY |"
 */
export function parseVitestCoverage(stdout: string): number | null {
  // Vitest often uses the same Istanbul table format as Jest
  const match = stdout.match(/All files\s*\|\s*(\d+(?:\.\d+)?)/m);
  if (match) {
    return parseFloat(match[1]) / 100;
  }
  return null;
}

/**
 * Parses Jest coverage output.
 * Looks for: "All files | XX.YY |"
 */
export function parseJestCoverage(stdout: string): number | null {
  const match = stdout.match(/All files\s*\|\s*(\d+(?:\.\d+)?)/m);
  if (match) {
    return parseFloat(match[1]) / 100;
  }
  return null;
}

/**
 * Parses pytest-cov output.
 * Looks for: "TOTAL ... XX%"
 */
export function parsePytestCoverage(stdout: string): number | null {
  const match = stdout.match(/^TOTAL\s+\d+\s+\d+\s+(\d+(?:\.\d+)?)%/m);
  if (match) {
    return parseFloat(match[1]) / 100;
  }
  return null;
}

/**
 * Parses the coverage summary coverlet prints after `dotnet test` when coverage
 * collection is on (`/p:CollectCoverage=true`, i.e. the coverlet.msbuild
 * integration). `dotnet test` on its own prints NO coverage at all — verified
 * against a real 20KB `dotnet test` log from run `muauw6u93e1c`
 * (`.muonroi-cli/verify-artifacts/test.log`): zero occurrences of "coverage",
 * "Total" or any percent table. That case MUST come back null.
 *
 * The shape is not guessed. coverlet builds it in
 * `src/coverlet.core/CoverageSummary.cs::BuildCoverageSummaryTable`:
 *
 *     var summaryTable = new ConsoleTable(string.Empty, "Line", "Branch", "Method");
 *     summaryTable.AddRow("Total",   $"{lineCalc.Percent.ToString(CultureInfo.InvariantCulture)}%", ...);
 *     summaryTable.AddRow("Average", $"{...AverageModulePercent...}%", ...);
 *
 * rendered by `ConsoleTable.ToStringAlternative()` with the row format
 * `"| {0,-N} | {1,-M} | {2,-K} | {3,-L} |"` and `+---+` dividers, giving:
 *
 *     +---------+------+--------+--------+
 *     |         | Line | Branch | Method |
 *     +---------+------+--------+--------+
 *     | Total   | 75%  | 62.5%  | 66.6%  |
 *     +---------+------+--------+--------+
 *     | Average | 78%  | 64.1%  | 70%    |
 *     +---------+------+--------+--------+
 *
 * The first percentage after `Total` is the LINE column, which is the same
 * quantity the other parsers here return (Istanbul's leading `% Stmts`,
 * pytest-cov's `TOTAL … XX%`). `Average` is deliberately ignored: it is a mean of
 * per-module percentages, so it over-weights tiny modules.
 *
 * `CultureInfo.InvariantCulture` guarantees a `.` decimal separator, so no comma
 * form is accepted — matching an unexpected shape would be a guess, and this
 * returns null instead.
 */
export function parseDotnetCoverage(stdout: string): number | null {
  const match = stdout.match(/^\s*\|\s*Total\s*\|\s*(\d+(?:\.\d+)?)\s*%/m);
  if (match) {
    return parseFloat(match[1]) / 100;
  }
  return null;
}

/**
 * Dispatches coverage parsing based on ecosystem.
 *
 * Every branch returns `null` — never 0 — when it cannot find a figure. That
 * distinction is load-bearing: downstream, `0` means "measured, and nothing is
 * covered" and blocks the engineering floor, while `null` means "not measured"
 * and blocks nothing (see `src/product-loop/coverage-signal.ts`).
 */
export function extractCoverageFromOutput(output: string, ecosystem: string): number | null {
  switch (ecosystem.toLowerCase()) {
    case "bun":
      return parseBunCoverage(output);
    case "node":
    case "vitest":
    case "jest":
      // Many node tools use Istanbul-style tables
      return parseVitestCoverage(output) || parseJestCoverage(output);
    case "python":
    case "pytest":
    case "django":
      return parsePytestCoverage(output);
    case "dotnet":
    case "csharp":
      return parseDotnetCoverage(output);
    default:
      // Try generic Istanbul-style table match if unknown
      return parseVitestCoverage(output);
  }
}
