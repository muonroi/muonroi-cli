import { describe, expect, it } from "vitest";
import { extractPathTokens, scoreRepoGrounding } from "../layer1_5-complexity-size.js";

describe("extractPathTokens", () => {
  it("extracts distinct path-like tokens, lowercased", () => {
    expect(extractPathTokens("refactor src/auth/login.ts and Src/Auth/Login.ts").sort()).toEqual(["src/auth/login.ts"]);
  });

  it("returns [] when no path-like token is present", () => {
    expect(extractPathTokens("explain how oauth works")).toEqual([]);
  });
});

describe("scoreRepoGrounding", () => {
  it("scores +4 for a >=5000-line indexed match, +2 for >=2000", () => {
    const hints = [
      { path: "src/ui/app.tsx", lineCount: 6200 },
      { path: "src/pil/config.ts", lineCount: 2100 },
    ];
    expect(scoreRepoGrounding(["src/ui/app.tsx"], hints)).toEqual({ score: 4, hits: 1 });
    expect(scoreRepoGrounding(["src/pil/config.ts"], hints)).toEqual({ score: 2, hits: 1 });
  });

  it("returns zero when no path or no hint matches", () => {
    expect(scoreRepoGrounding([], [{ path: "a", lineCount: 9000 }])).toEqual({ score: 0, hits: 0 });
    expect(scoreRepoGrounding(["nope.ts"], [{ path: "a.ts", lineCount: 9000 }])).toEqual({ score: 0, hits: 0 });
  });
});
