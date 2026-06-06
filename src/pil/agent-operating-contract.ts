/**
 * src/pil/agent-operating-contract.ts
 *
 * The Agent Operating Contract — a compact, phase-keyed behavioural prelude
 * placed at the FRONT of the system prompt for EVERY tier (not just fast).
 *
 * Motivation. The anti-hallucination principle already exists in the repo
 * conventions (AGENTS.md "Evidence-First Rule") and IS loaded into the runtime
 * system prompt via loadCustomInstructions → the CUSTOM INSTRUCTIONS section.
 * But that section lands AFTER the (large) mode prompt, buried inside the
 * concatenated AGENTS.md + CLAUDE.md text. Live forensics (deepseek-v4-flash
 * repo-eval, session 17fc23f0) showed the model fabricate a test count (claimed
 * 67, actual 401) and invent a bug with fake file:line refs DESPITE the rule
 * being present — the classic primacy problem the cheap-model playbook already
 * documents: rules that are not front-loaded get underweighted.
 *
 * So this contract does NOT introduce new rules. It DISTILS the rules that are
 * already scattered across AGENTS.md (Evidence-First, No Silent Catch), the
 * cheap-model playbook (tool-use), and the grounding clause (#39) into one
 * short, ordered-by-work-phase block positioned for maximum primacy.
 *
 * Layering note. For fast-tier models the cheap-model shell line / playbook /
 * workbook are prepended in message-processor AFTER buildSystemPrompt returns,
 * so they sit IN FRONT of this contract. That is intentional: fast tier keeps
 * its detailed, proven tool-use prelude at the very front; this contract adds
 * the same discipline for balanced/premium tiers (which otherwise only had the
 * buried CUSTOM INSTRUCTIONS copy). The grounding clause therefore lives in
 * BOTH the fast-tier workbook (front-most for fast tier) and this contract
 * (front-most for every other tier) — minor duplication accepted as cheap
 * insurance against primacy loss; see cheap-model-workbooks.ts.
 *
 * Escape hatch: MUONROI_DISABLE_AGENT_CONTRACT=1.
 */

/**
 * The contract text. Ordered by the phase of work an agent moves through:
 * BEFORE ACTING → READING → EXECUTING → WHEN UNSURE → REPORTING. Each phase is
 * one imperative line targeting that phase's most damaging failure mode. Kept
 * tight (primacy matters more than detail; tokens are the cost).
 */
export const AGENT_OPERATING_CONTRACT = `[AGENT OPERATING CONTRACT — read first; applies to every step you take]

1. BEFORE ACTING: do only what was asked. Do not assume scope, intent, or facts that are not in the request — if it is genuinely ambiguous, ask or pick a clearly-stated default; never invent requirements.
2. READING: base every statement on what you actually read or ran THIS turn. Do not infer the contents of a file you did not open.
3. EXECUTING: make the smallest correct change; never widen scope; never mask a failure (no \`|| true\`, no skipped/deleted tests, no swallowed catch).
4. WHEN UNSURE: verify or research and cross-check BEFORE concluding. A bug needs a reproduction or trace — reading the code is not proof on its own.
5. REPORTING: answer ONLY what was asked; don't volunteer extra numbers. Every fact, count, name, or file:line MUST come from something you ran or read this turn — else label it "unverified"; never guess or invent. Never claim a build/test/verification ran or passed, or describe edits, you did not actually do this turn; if a check can't run, fix it or say so — don't imply success.

[END CONTRACT — your regular instructions follow]`;

export interface ContractSectionOptions {
  /** Chitchat turns carry no tools and make no factual claims — skip the contract. */
  chitchat?: boolean;
}

/**
 * Build the contract block for insertion at the front of the system prompt.
 * Returns "" when disabled (env override) or for chitchat turns; otherwise the
 * contract followed by a blank-line separator so it sits cleanly before the
 * mode prompt.
 */
export function buildContractSection(options?: ContractSectionOptions): string {
  if (process.env.MUONROI_DISABLE_AGENT_CONTRACT === "1") return "";
  if (options?.chitchat === true) return "";
  return `${AGENT_OPERATING_CONTRACT}\n\n`;
}
