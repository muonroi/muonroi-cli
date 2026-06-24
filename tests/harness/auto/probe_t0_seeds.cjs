#!/usr/bin/env node
/**
 * Probe the 2 seed T0 entries surface from /api/intercept.
 *
 *   probe 1 — Write on a >1000-line TS file -> expect file-size-cap-1000-lines
 *   probe 2 — Bash that mirrors an exp-feedback flow -> expect followed-feedback-habit
 *
 * Reads SERVER_URL + SERVER_AUTH_TOKEN from env (or falls back to local config).
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
  /* allow env-only */
}
const SERVER = process.env.SERVER_URL || cfg.serverBaseUrl;
const TOKEN = process.env.SERVER_AUTH_TOKEN || cfg.serverAuthToken;
if (!SERVER || !TOKEN) {
  console.error("ERROR: need SERVER_URL + SERVER_AUTH_TOKEN (or ~/.experience/config.json).");
  process.exit(2);
}

const SEED_IDS = {
  "beb2ad31-f520-5734-883c-3604042d1b7f": "followed-feedback-habit",
  // file-size-cap-1000-lines moved to engine static-rules — see probe_static_rules.cjs.
};

function request(url, body) {
  const u = new URL(url);
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  };
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, opts, (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(s) });
        } catch (_err) {
          resolve({ status: res.statusCode, raw: s.slice(0, 400) });
        }
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function probe(label, body, expectedSlug) {
  console.log(`\n=== probe: ${label} (expect ${expectedSlug}) ===`);
  const r = await request(`${SERVER}/api/intercept`, body);
  console.log("  status:", r.status);
  if (!r.body) {
    console.log("  raw:", r.raw);
    return false;
  }
  const { hasSuggestions, surfacedIds = [], suggestions } = r.body;
  console.log("  hasSuggestions:", hasSuggestions);
  const idStrings = surfacedIds.map((h) => (typeof h === "string" ? h : h?.id)).filter(Boolean);
  console.log("  surfacedIds (top 3):", JSON.stringify(idStrings.slice(0, 3)));
  const seedHits = idStrings.filter((id) => SEED_IDS[id]).map((id) => SEED_IDS[id]);
  console.log("  seed hits:", seedHits.length ? seedHits.join(", ") : "(none)");
  if (suggestions) {
    const s = typeof suggestions === "string" ? suggestions : JSON.stringify(suggestions);
    console.log("  suggestion preview:", s.slice(0, 280).replace(/\n/g, " | "));
  }
  return seedHits.includes(expectedSlug);
}

(async () => {
  const ok = await probe(
    "experience-feedback context",
    {
      toolName: "Bash",
      toolInput: {
        command:
          "node ~/.experience/exp-feedback.js followed 00a2f97e experience-behavioral # PreToolUse hint shaped action",
      },
      sourceKind: "probe",
      sourceSession: "t0-seed-probe",
      project_slug: "muonroi-cli",
      skipRoute: true,
    },
    "followed-feedback-habit",
  );

  console.log("\n=== SUMMARY ===");
  console.log("  followed-habit surfaced:", ok ? "YES" : "NO");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
