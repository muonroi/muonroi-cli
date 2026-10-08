import { buildSystemPrompt } from "./src/orchestrator/prompts.js";

for (const mode of ["agent", "plan", "ask"] as const) {
  const p = buildSystemPrompt(process.cwd(), mode, "disabled");
  const est = Math.round(p.length / 4);
  console.log(
    `${mode.padEnd(6)} chars=${String(p.length).padStart(8)} estTokens(chars/4)=${String(est).padStart(6)} realApprox(2x est)=${est * 2}`,
  );
}
// agent mode with resume digest + plan context (typical heavy turn)
const p2 = buildSystemPrompt(
  process.cwd(),
  "agent",
  "disabled",
  "PLAN: do the thing",
  undefined,
  undefined,
  "default",
  "RESUME DIGEST: previously did X",
);
console.log(`agent+plan+resume chars=${p2.length} estTokens=${Math.round(p2.length / 4)}`);
