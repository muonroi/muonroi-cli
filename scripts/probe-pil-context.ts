#!/usr/bin/env bun
// Brain deployment verifier — pings /api/pil-context with representative
// fixtures and reports schema compliance + latency. Run before Phase 4
// to confirm the unified endpoint is deployed and healthy in production.
//
// Usage:
//   bun scripts/probe-pil-context.ts                     # use config.json baseUrl
//   bun scripts/probe-pil-context.ts --url http://...    # override URL
//   bun scripts/probe-pil-context.ts --json              # machine-readable
//
// Exits 0 if all probes pass, 1 if any fail (auth, schema, timeout).

import { getCachedAuthToken, getCachedServerBaseUrl, loadEEAuthToken } from "../src/ee/auth.js";
import { PilContextResponseSchema } from "../src/pil/schema.js";

interface Args {
  url?: string;
  json: boolean;
  timeoutMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let url: string | undefined;
  let json = false;
  let timeoutMs = 5000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      url = argv[++i];
    } else if (argv[i] === "--json") {
      json = true;
    } else if (argv[i] === "--timeout" && argv[i + 1]) {
      timeoutMs = Number(argv[++i]);
    }
  }
  return { url, json, timeoutMs };
}

const FIXTURES = [
  { prompt: "refactor this function to be async", expectTaskType: "refactor" },
  { prompt: "tại sao test fail?", expectTaskType: "debug" },
  { prompt: "thiết kế hệ thống auth cho team", expectTaskType: "plan" },
  { prompt: "hi", expectTaskType: "general" },
  { prompt: "phân tích lỗi memory leak", expectTaskType: "analyze" },
];

interface ProbeResult {
  prompt: string;
  status: "pass" | "schema_fail" | "http_error" | "network_error" | "auth_error";
  httpStatus?: number;
  taskType?: string | null;
  outputStyle?: string;
  cacheHit?: boolean;
  inferenceMs?: number;
  latencyMs: number;
  schemaError?: string;
  networkError?: string;
  taskTypeMismatch?: boolean;
}

async function probeOne(
  baseUrl: string,
  token: string,
  prompt: string,
  expectTaskType: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/pil-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (resp.status === 401 || resp.status === 403) {
      return { prompt, status: "auth_error", httpStatus: resp.status, latencyMs };
    }
    if (!resp.ok) {
      return { prompt, status: "http_error", httpStatus: resp.status, latencyMs };
    }
    const raw = await resp.json();
    const parsed = PilContextResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        prompt,
        status: "schema_fail",
        httpStatus: resp.status,
        latencyMs,
        schemaError: parsed.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; "),
      };
    }
    const d = parsed.data;
    return {
      prompt,
      status: "pass",
      httpStatus: resp.status,
      taskType: d.taskType,
      outputStyle: d.outputStyle,
      cacheHit: d.cache_hit,
      inferenceMs: d.inference_ms,
      latencyMs,
      taskTypeMismatch: d.taskType !== expectTaskType,
    };
  } catch (err) {
    return {
      prompt,
      status: "network_error",
      latencyMs: Date.now() - started,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const args = parseArgs();
  await loadEEAuthToken();
  const baseUrl = args.url ?? getCachedServerBaseUrl();
  const token = getCachedAuthToken();

  if (!baseUrl) {
    console.error("No baseUrl: pass --url or set serverBaseUrl in ~/.experience/config.json");
    process.exit(1);
  }
  if (!token) {
    console.error("No auth token: set serverAuthToken in ~/.experience/config.json");
    process.exit(1);
  }

  // Run probes sequentially so we can see cache behavior on the 2nd identical hit.
  const results: ProbeResult[] = [];
  for (const f of FIXTURES) {
    results.push(await probeOne(baseUrl, token, f.prompt, f.expectTaskType, args.timeoutMs));
  }
  // Repeat the first fixture to test cache.
  const cacheProbe = await probeOne(baseUrl, token, FIXTURES[0]!.prompt, FIXTURES[0]!.expectTaskType, args.timeoutMs);

  const allPassed = results.every((r) => r.status === "pass") && cacheProbe.status === "pass";
  const cacheWorking = cacheProbe.cacheHit === true;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          baseUrl,
          fixtures: results,
          cache_probe: cacheProbe,
          all_passed: allPassed,
          cache_working: cacheWorking,
        },
        null,
        2,
      ),
    );
    process.exit(allPassed ? 0 : 1);
  }

  console.log(`\nBrain endpoint probe — ${baseUrl}/api/pil-context\n`);
  console.log("First-call probes:");
  for (const r of results) {
    const flag =
      r.status === "pass" && !r.taskTypeMismatch
        ? "PASS"
        : r.status === "pass" && r.taskTypeMismatch
          ? "WARN" // classification differed from expectation — not a deployment fail
          : "FAIL";
    const detail =
      r.status === "pass"
        ? `${r.latencyMs}ms taskType=${r.taskType} style=${r.outputStyle} cache=${r.cacheHit} inference=${r.inferenceMs}ms`
        : `${r.status} ${r.httpStatus ?? ""} ${r.schemaError ?? r.networkError ?? ""}`;
    console.log(`  ${flag}  "${r.prompt.slice(0, 40)}"  ${detail}`);
    if (r.taskTypeMismatch && r.status === "pass") {
      console.log(`        (expected taskType but got "${r.taskType}" — classifier judgement, not deployment fail)`);
    }
  }
  console.log("\nCache probe (repeat of first fixture):");
  console.log(
    `  ${cacheProbe.status === "pass" ? "PASS" : "FAIL"}  cache_hit=${cacheProbe.cacheHit}  latency=${cacheProbe.latencyMs}ms  inference=${cacheProbe.inferenceMs}ms`,
  );
  if (cacheProbe.status === "pass" && !cacheWorking) {
    console.log("        (cache MISS on identical second hit — server cache disabled or TTL bug)");
  }

  console.log(`\nDeployment gates:`);
  const httpHealthy = results.every((r) => r.status === "pass") && cacheProbe.status === "pass";
  console.log(`  ${httpHealthy ? "PASS" : "FAIL"}  endpoint deployed + all probes return 200`);
  console.log(`  ${results.every((r) => r.status !== "auth_error") ? "PASS" : "FAIL"}  auth token accepted`);
  console.log(`  ${results.every((r) => r.status !== "schema_fail") ? "PASS" : "FAIL"}  schema_version 1.0 compliance`);
  console.log(`  ${cacheWorking ? "PASS" : "FAIL"}  server-side cache active`);

  process.exit(httpHealthy ? 0 : 1);
}

main().catch((err) => {
  console.error("probe error:", err);
  process.exit(1);
});
