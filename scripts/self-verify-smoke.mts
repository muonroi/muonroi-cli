/**
 * Manual smoke for /self-verify — feeds a fake diff list so the planner
 * builds scenarios against KNOWN UI files, then drives the child and prints
 * the report. Run with:
 *
 *   bun run scripts/self-verify-smoke.mts
 */

import { runSelfVerify } from "../src/self-qa/index.js";

const report = await runSelfVerify({
  diffFilesOverride: [
    "src/ui/agents-modal.tsx", // textbox + listbox + dialog
    "src/ui/components/halt-recovery-card.tsx", // modal dialog
  ],
  maxScenarios: 4,
  emitSpecs: false, // dry-run; don't pollute tests/harness/auto
  log: (m) => console.log(m),
});

console.log("\n=== REPORT ===");
console.log(`Scenarios planned : ${report.scenarios.length}`);
for (const s of report.scenarios) {
  console.log(`  - ${s.id} (${s.steps.length} steps, ${s.expectations.length} expectations)`);
}
console.log(`Duration          : ${report.durationMs}ms`);
console.log(`Pass rate         : ${(report.summary.passRate * 100).toFixed(0)}%`);
console.log("Verdicts:");
for (const r of report.results) {
  console.log(`  - ${r.scenarioId.padEnd(40)} → ${r.verdict.toUpperCase()} (${r.durationMs}ms)`);
  for (const c of r.checks) {
    const mark = c.passed ? "✓" : "✗";
    console.log(`      ${mark} ${c.expectation.kind}: ${c.reason}`);
  }
}
