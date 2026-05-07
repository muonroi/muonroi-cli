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
 * Dispatches coverage parsing based on ecosystem.
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
    default:
      // Try generic Istanbul-style table match if unknown
      return parseVitestCoverage(output);
  }
}
