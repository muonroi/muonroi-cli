import { describe, expect, it } from "vitest";
import {
  extractCoverageFromOutput,
  parseBunCoverage,
  parseJestCoverage,
  parsePytestCoverage,
  parseVitestCoverage,
} from "../coverage-parsers.js";

const BUN_OUTPUT = `
[0.12ms] 11 tests passed
[0.00ms] 0 tests failed

-----------------------|---------|---------|---------|---------|-----------------------
File                   | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-----------------------|---------|---------|---------|---------|-----------------------
All files              |   85.50 |   70.00 |   90.00 |   85.50 |
 index.ts              |   85.50 |   70.00 |   90.00 |   85.50 | 10-15
-----------------------|---------|---------|---------|---------|-----------------------
`;

const VITEST_OUTPUT = `
  Files                    | % Stmts | % Branch | % Funcs | % Lines | Uncovered Lines
 --------------------------|---------|---------|---------|---------|-----------------
  All files                |   92.31 |   85.71 |     100 |   92.31 | 
   reality-anchor.ts       |     100 |     100 |     100 |     100 | 
   verify-result.ts        |   83.33 |      75 |     100 |   83.33 | 12-15
 --------------------------|---------|---------|---------|---------|-----------------
`;

const JEST_OUTPUT = `
----------|---------|----------|---------|---------|-------------------
File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
----------|---------|----------|---------|---------|-------------------
All files |   75.42 |    62.15 |   80.52 |   75.42 |                   
----------|---------|----------|---------|---------|-------------------
`;

const PYTEST_OUTPUT = `
Name                      Stmts   Miss  Cover
---------------------------------------------
muonroi/__init__.py           0      0   100%
muonroi/cli.py               42      8    81%
---------------------------------------------
TOTAL                        42      8    81%
`;

describe("Coverage Parsers", () => {
  it("should parse bun coverage", () => {
    expect(parseBunCoverage(BUN_OUTPUT)).toBe(0.855);
  });

  it("should parse vitest coverage", () => {
    expect(parseVitestCoverage(VITEST_OUTPUT)).toBe(0.9231);
  });

  it("should parse jest coverage", () => {
    expect(parseJestCoverage(JEST_OUTPUT)).toBe(0.7542);
  });

  it("should parse pytest coverage", () => {
    expect(parsePytestCoverage(PYTEST_OUTPUT)).toBe(0.81);
  });

  it("should return null on parse miss", () => {
    expect(parseBunCoverage("No coverage info here")).toBeNull();
    expect(parsePytestCoverage("No coverage info here")).toBeNull();
  });

  describe("extractCoverageFromOutput", () => {
    it("should dispatch correctly by ecosystem", () => {
      expect(extractCoverageFromOutput(BUN_OUTPUT, "bun")).toBe(0.855);
      expect(extractCoverageFromOutput(VITEST_OUTPUT, "vitest")).toBe(0.9231);
      expect(extractCoverageFromOutput(JEST_OUTPUT, "jest")).toBe(0.7542);
      expect(extractCoverageFromOutput(PYTEST_OUTPUT, "python")).toBe(0.81);
    });

    it("should handle case insensitivity", () => {
      expect(extractCoverageFromOutput(BUN_OUTPUT, "BUN")).toBe(0.855);
    });

    it("should fall back to Istanbul-style for unknown ecosystems", () => {
      expect(extractCoverageFromOutput(VITEST_OUTPUT, "unknown")).toBe(0.9231);
    });
  });
});
