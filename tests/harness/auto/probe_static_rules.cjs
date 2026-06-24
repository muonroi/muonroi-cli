#!/usr/bin/env node
/**
 * Probe the deterministic static rules wired into /api/intercept.
 * These bypass embedding semantics — they fire on hard predicates.
 *
 * Scenarios:
 *   1. Write 1500-line .ts (no semantic size hint in content) -> FIRE
 *   2. Write 50-line .ts                                       -> silent
 *   3. Write 1500-line catalog.json (excluded)                 -> silent
 *   4. Write 1500 lines to __snapshots__/foo.snap (excluded)   -> silent
 *   5. Write 1500 lines to tests/.../fixtures/x.json (excluded)-> silent
 *   6. Small Edit on existing big file                         -> silent
 *   7. MultiEdit-shaped wholesale Edit pasting 1600 lines      -> FIRE
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME, ".experience", "config.json");
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch (_err) {
  /* env-only allowed */
}
const SERVER = process.env.SERVER_URL || cfg.serverBaseUrl;
const TOKEN = process.env.SERVER_AUTH_TOKEN || cfg.serverAuthToken;
if (!SERVER || !TOKEN) {
  console.error("need SERVER_URL + TOKEN");
  process.exit(2);
}

function request(url, body) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(s) });
          } catch (_err) {
            resolve({ status: res.statusCode, raw: s.slice(0, 400) });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function bigLines(n) {
  return Array.from({ length: n }, (_, i) => `export const k${i} = ${i};`).join("\n");
}

async function probe(label, body, expectStaticFire) {
  const r = await request(`${SERVER}/api/intercept`, body);
  const ids = (r.body?.surfacedIds || []).map((h) => (typeof h === "string" ? h : h?.id)).filter(Boolean);
  const staticHit = ids.some((id) => id.startsWith("file-size-cap-"));
  const ok = staticHit === expectStaticFire;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label} -> static=${staticHit} expected=${expectStaticFire}`);
  if (!ok && r.body?.suggestions) {
    console.log("  suggestions preview:", String(r.body.suggestions).slice(0, 200).replace(/\n/g, " | "));
  }
  return ok;
}

(async () => {
  const big1500 = bigLines(1500);
  const big1600 = bigLines(1600);
  const small50 = bigLines(50);

  const results = [];
  results.push(
    await probe(
      "Write 1500-line .ts (no semantic cue)",
      {
        toolName: "Write",
        toolInput: { file_path: "/repo/src/orchestrator/big.ts", content: big1500 },
        sourceKind: "probe-static",
        lang: "typescript",
        project_slug: "muonroi-cli",
        skipRoute: true,
      },
      true,
    ),
  );
  results.push(
    await probe(
      "Write 50-line .ts",
      {
        toolName: "Write",
        toolInput: { file_path: "/repo/src/small.ts", content: small50 },
        sourceKind: "probe-static",
        lang: "typescript",
        project_slug: "muonroi-cli",
        skipRoute: true,
      },
      false,
    ),
  );
  results.push(
    await probe(
      "Write 1500-line catalog.json (excluded)",
      {
        toolName: "Write",
        toolInput: { file_path: "/repo/src/models/catalog.json", content: big1500 },
        sourceKind: "probe-static",
        project_slug: "muonroi-cli",
        skipRoute: true,
      },
      false,
    ),
  );
  results.push(
    await probe(
      "Write 1500 lines to __snapshots__/foo.snap (excluded)",
      {
        toolName: "Write",
        toolInput: { file_path: "/repo/__snapshots__/foo.snap", content: big1500 },
        sourceKind: "probe-static",
        project_slug: "muonroi-cli",
        skipRoute: true,
      },
      false,
    ),
  );
  results.push(
    await probe(
      "Write 1500 lines to tests/.../fixtures/x.json (excluded)",
      {
        toolName: "Write",
        toolInput: { file_path: "/repo/tests/harness/fixtures/x.json", content: big1500 },
        sourceKind: "probe-static",
        project_slug: "muonroi-cli",
        skipRoute: true,
      },
      false,
    ),
  );
  results.push(
    await probe(
      "Small Edit on existing file (silent)",
      {
        toolName: "Edit",
        toolInput: { file_path: "/repo/src/orchestrator.ts", old_string: "const a = 1", new_string: "const a = 2" },
        sourceKind: "probe-static",
        lang: "typescript",
        project_slug: "muonroi-cli",
        skipRoute: true,
      },
      false,
    ),
  );
  results.push(
    await probe(
      "Edit pasting 1600-line replacement (wholesale)",
      {
        toolName: "Edit",
        toolInput: { file_path: "/repo/src/orchestrator.ts", old_string: "x", new_string: big1600 },
        sourceKind: "probe-static",
        lang: "typescript",
        project_slug: "muonroi-cli",
        skipRoute: true,
      },
      true,
    ),
  );

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
