/**
 * Zero Hardcode Rule gate for this repository (scripts/check-hardcoded-ids.ts).
 * The rule used to be prose in the product prompt; it is muonroi-cli project
 * knowledge, so it is enforced on this repo's source instead. Running the scan
 * here as well as in CI means a new literal fails the same `bunx vitest run`
 * every push already passes through.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Baseline,
  compareToBaseline,
  isExemptPath,
  loadForbiddenIds,
  scanRepo,
  scanSource,
  stringLiterals,
} from "../check-hardcoded-ids.js";

const REPO = resolve(__dirname, "..", "..");
const catalog = JSON.parse(readFileSync(join(REPO, "src/models/catalog.json"), "utf8")) as {
  models: Array<{ id: string; provider: string }>;
};
const MODEL = catalog.models[0]!.id;
const PROVIDER = catalog.models[0]!.provider;

describe("check-hardcoded-ids", () => {
  it("derives the forbidden set from catalog.json and the ProviderId union", () => {
    const ids = loadForbiddenIds(REPO);
    for (const row of catalog.models) {
      expect(ids.has(row.id)).toBe(true);
      expect(ids.has(row.provider)).toBe(true);
    }
  });

  it("flags a model or provider ID used as a fallback value", () => {
    const forbidden = new Set([MODEL, PROVIDER]);
    const src = `const m = settings.model ?? "${MODEL}";\nconst p = detected || '${PROVIDER}';\n`;
    expect(scanSource("src/x.ts", src, forbidden)).toEqual([
      { file: "src/x.ts", line: 1, literal: MODEL },
      { file: "src/x.ts", line: 2, literal: PROVIDER },
    ]);
  });

  it("skips comments, type unions, interpolated templates and partial matches", () => {
    const forbidden = new Set([MODEL, PROVIDER]);
    const src = [
      `// default was "${MODEL}"`,
      `/* "${PROVIDER}" */`,
      `export type P = "${PROVIDER}" | "other";`,
      `  | "${PROVIDER}"`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text
      "const t = `${x}" + MODEL + "`;",
      `const s = "${MODEL}-suffix";`,
      `const url = "https://example.com//${PROVIDER}";`,
    ].join("\n");
    expect(scanSource("src/x.ts", src, forbidden)).toEqual([]);
  });

  it("keeps line numbers across block comments and template literals", () => {
    const lits = stringLiterals('/*\n\n*/\nconst a = `x\ny`;\nconst b = "z";');
    expect(lits).toEqual([
      { text: "x\ny", line: 4 },
      { text: "z", line: 6 },
    ]);
  });

  it("exempts tests, fixtures and the pricing table only", () => {
    expect(isExemptPath("src/a/b.test.ts")).toBe(true);
    expect(isExemptPath("src/a/__tests__/b.ts")).toBe(true);
    expect(isExemptPath("src/providers/pricing.ts")).toBe(true);
    expect(isExemptPath("src/models/catalog.json")).toBe(true);
    expect(isExemptPath("src/providers/runtime.ts")).toBe(false);
    expect(isExemptPath("src/ui/app.tsx")).toBe(false);
  });

  it("ratchets: a new literal or a higher count is a violation, a lower count is reported", () => {
    const baseline: Baseline = { "src/a.ts": { [PROVIDER]: 1, [MODEL]: 2 } };
    const hits = [
      { file: "src/a.ts", line: 1, literal: PROVIDER },
      { file: "src/a.ts", line: 2, literal: PROVIDER },
      { file: "src/a.ts", line: 3, literal: MODEL },
      { file: "src/new.ts", line: 9, literal: MODEL },
    ];
    const { violations, improved } = compareToBaseline(hits, baseline);
    expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual(["src/a.ts:1", "src/a.ts:2", "src/new.ts:9"]);
    expect(improved).toEqual([`src/a.ts "${MODEL}": 2 -> 1`]);
  });

  it("this repository adds no hardcoded model/provider ID beyond the baseline", () => {
    const baseline = JSON.parse(readFileSync(join(REPO, "scripts/.hardcoded-ids-allow.json"), "utf8")) as Baseline;
    const { violations } = compareToBaseline(scanRepo(REPO), baseline);
    expect(violations.map((v) => `${v.file}:${v.line} "${v.literal}"`)).toEqual([]);
  });
});
