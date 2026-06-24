import { getCachedAuthToken, getCachedServerBaseUrl, loadEEAuthToken } from "../src/ee/auth.js";
import { detectEEClientMode, getCachedEEClientMode } from "../src/ee/client-mode.js";
import { healthDetailed } from "../src/ee/health.js";
import { formatDoctorReport, runDoctor } from "../src/ops/doctor.js";

await loadEEAuthToken();

console.log("=== auth/cache state ===");
console.log("serverBaseUrl =", getCachedServerBaseUrl());
console.log("authToken     =", getCachedAuthToken() ? "(set)" : "(none)");

console.log("\n=== detectEEClientMode (boot) ===");
const mode = await detectEEClientMode();
console.log(JSON.stringify(mode, null, 2));
console.log("cached mode =", JSON.stringify(getCachedEEClientMode()));

console.log("\n=== healthDetailed() ===");
const detail = await healthDetailed();
console.log(JSON.stringify(detail, null, 2));

console.log("\n=== runDoctor() ===");
const results = await runDoctor();
console.log(formatDoctorReport(results, "probe"));
