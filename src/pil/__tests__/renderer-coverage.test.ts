/**
 * Build-time guard: every PIL response schema must have a UI renderer case in
 * StructuredResponseView (src/ui/app.tsx). Without this, adding a new taskType
 * + schema and forgetting to update the UI silently falls back to raw-JSON
 * dump (or the graceful "renderer missing" warning).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("StructuredResponseView renderer coverage", () => {
  it("has a case for every RESPONSE_SCHEMAS key", async () => {
    // Pull canonical schema map by reading the source — keeps this test
    // independent of any future re-export shuffling.
    const responseToolsSrc = readFileSync(resolve("src/pil/response-tools.ts"), "utf8");
    const mapMatch = responseToolsSrc.match(/RESPONSE_SCHEMAS[^=]*=\s*\{([\s\S]*?)\n\}/);
    expect(mapMatch, "could not locate RESPONSE_SCHEMAS literal").toBeTruthy();
    const schemaKeys = Array.from(mapMatch![1].matchAll(/^\s*(\w+)\s*:/gm)).map((m) => m[1]);
    expect(schemaKeys.length).toBeGreaterThan(0);

    // The codebase has TWO consumers of sr.taskType: the React renderer
    // (src/ui/components/structured-response-view.tsx) and the text formatter
    // (`_formatStructuredResponse` in src/ui/app.tsx). Both must cover every key.
    // Note: after the app.tsx split, the React renderer switch lives in
    // structured-response-view.tsx — scan both files.
    const appSrc = readFileSync(resolve("src/ui/app.tsx"), "utf8");
    const rendererSrc = readFileSync(resolve("src/ui/components/structured-response-view.tsx"), "utf8");
    const combinedSrc = appSrc + "\n" + rendererSrc;

    const switchOffsets: number[] = [];
    let idx = 0;
    while ((idx = combinedSrc.indexOf("switch (sr.taskType)", idx)) !== -1) {
      switchOffsets.push(idx);
      idx += 1;
    }
    expect(switchOffsets.length, "expected at least 2 switches on sr.taskType").toBeGreaterThanOrEqual(2);

    for (const start of switchOffsets) {
      const body = combinedSrc.slice(start, start + 8000);
      const caseKeys = Array.from(body.matchAll(/case\s+"(\w+)"\s*:/g)).map((m) => m[1]);
      const missing = schemaKeys.filter((k) => !caseKeys.includes(k));
      expect(missing, `switch at offset ${start} missing case(s): ${missing.join(", ")}`).toEqual([]);
    }
  });
});
