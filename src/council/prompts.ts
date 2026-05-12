import type { ClarifiedSpec, DebatePlan, DebateStance, OutputSection, OutputShape } from "./types.js";

// ── Clarification prompts ────────────────────────────────────────────────────

export function buildClarificationPrompt(topic: string, conversationContext: string, previousQA?: Array<{ question: string; answer: string }>): {
  system: string;
  prompt: string;
} {
  const qaSection = previousQA?.length
    ? `\n\n## Already Clarified\n${previousQA.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")}`
    : "";

  return {
    system:
      `You are a senior technical lead preparing for a multi-expert discussion. ` +
      `Your job is to identify AMBIGUITIES in the topic that would cause experts to talk past each other or go off-topic.\n\n` +
      `Analyze the topic and conversation context carefully. Generate targeted clarification questions.\n` +
      `Focus on:\n` +
      `- SCOPE: What exactly is in/out of scope?\n` +
      `- CONSTRAINTS: Technical, time, resource, or business constraints?\n` +
      `- SUCCESS CRITERIA: How will we know the discussion produced a good result?\n` +
      `- CONTEXT: What existing decisions, code, or patterns are relevant?\n\n` +
      `## Minimum-question rule\n` +
      `Return [] ONLY for topics that are already a precise technical question with a single ` +
      `expected outcome (e.g. "What does X function return?", "Fix typo in README"). ` +
      `For ANY topic that describes a feature, project, idea, or design — even if the user ` +
      `gave several sentences — you MUST ask AT LEAST 2 questions, typically about:\n` +
      `- Scope boundaries (what's in/out of v1)\n` +
      `- Success metric (how is "done" measured)\n` +
      `- Hard constraint (timeline, platform, must-include / must-avoid)\n` +
      `A 1-paragraph "build me X" topic is NEVER specific enough — there are always implicit ` +
      `scope, criteria, and constraint gaps. Ask them.\n\n` +
      `If the topic is already specific enough (single technical Q&A only), return an empty array.\n\n` +
      `IMPORTANT — defaults from the workspace:\n` +
      `- If the topic refers to "this project", "current project", "repo này", "dự án hiện tại" or similar, ` +
      `the project IS the one described in the "## Current Project" section of the context. DO NOT ask which project.\n` +
      `- Only ask about project identity when the topic mentions multiple distinct projects or external products.\n` +
      `- Prefer using the project's package.json name and description as implicit context for follow-up questions.\n\n` +
      `Output ONLY a JSON array (no markdown, no preamble):\n` +
      `[{"question": "...", "why": "why this matters for a focused discussion", "suggestions": ["option A", "option B"], "recommended": "option A", "isRequired": true}]\n\n` +
      `Rules for "recommended":\n` +
      `- Only include "recommended" when, given the topic + context, ONE option is clearly the best default.\n` +
      `- Its value MUST be exactly equal to one of the entries in "suggestions".\n` +
      `- Pick at most ONE recommended option per question. If you cannot confidently single one out, OMIT the field entirely — do not guess.\n` +
      `Return [] if no clarification needed.`,
    prompt:
      `## Topic\n${topic}\n\n` +
      (conversationContext ? `## Conversation Context\n${conversationContext}\n` : "") +
      qaSection,
  };
}

export function buildSpecSynthesisPrompt(topic: string, conversationContext: string, qa: Array<{ question: string; answer: string }>): {
  system: string;
  prompt: string;
} {
  return {
    system:
      `You are synthesizing a discussion brief from the user's topic and their clarification answers.\n` +
      `Output ONLY a JSON object (no markdown, no preamble):\n` +
      `{\n` +
      `  "problemStatement": "clear 1-2 sentence problem statement",\n` +
      `  "constraints": ["constraint 1", "constraint 2"],\n` +
      `  "successCriteria": ["criterion 1", "criterion 2"],\n` +
      `  "scope": "what is in and out of scope"\n` +
      `}`,
    prompt:
      `## Original Topic\n${topic}\n\n` +
      (conversationContext ? `## Context\n${conversationContext}\n\n` : "") +
      `## Clarification Q&A\n${qa.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")}`,
  };
}

// ── Debate prompts ───────────────────────────────────────────────────────────

/**
 * Hard-language rule injected into every internal debate/evaluation/summary
 * prompt. The debate itself is engineering-internal and must stay in English
 * so quoted positions, [REFUTED]/[CONFIRMED] tags, JSON evaluations, and
 * cross-turn citations are stable and machine-readable. The user-facing
 * synthesis is what gets translated back into the user's native language.
 */
const ENGLISH_ONLY_RULE =
  `\n## Language Rule (mandatory)\n` +
  `Write your ENTIRE response in English. Do not translate to the user's language ` +
  `even if the topic, the brief, or your partner's message is in another language. ` +
  `Code identifiers, tool output, JSON keys, and citation tags must remain in English. ` +
  `The user-facing summary at the end of the council is the only place where ` +
  `the user's native language is used; the debate is engineering-internal.\n`;

/**
 * Evidence rule injected into stance prompts. Verification tools may be
 * absent (fast-tier participants skip them) — the rule covers both cases.
 *
 * Strict 1-call cap: debate runs under stepCountIs(2), so the model has at
 * most ONE tool call before it must produce final text. This prompt language
 * is critical — without "at most one" the reasoning models chain tool calls
 * and burn the step budget without producing analytical content (the bug
 * that caused session a7a5690d2049 to fail with 4/4 empty turns).
 */
const EVIDENCE_RULE_OPENING =
  `\n## Evidence Rule\n` +
  `Stay analytical. You may optionally call AT MOST ONE verification tool ` +
  `(grep / read_file / web_fetch / context7) ONLY to verify a SPECIFIC ` +
  `numerical or factual claim you would otherwise have to invent.\n` +
  `- Do NOT call tools for exploration or to gather background context.\n` +
  `- Do NOT chain multiple tool calls — you have one shot, then must produce your full response.\n` +
  `- If no claim needs verification, skip tool use entirely and answer directly.\n` +
  `Tag verified facts: \`[CONFIRMED via <tool>:<evidence>]\` or \`[REFUTED via <tool>:<evidence>]\`.\n` +
  `For uncited numbers / library specs that you cannot verify, mark them \`[UNVERIFIED: <claim>]\`.\n`;
const EVIDENCE_RULE_RESPONSE =
  `\n## Evidence Rule\n` +
  `Stay analytical. You may optionally call AT MOST ONE verification tool ` +
  `(grep / read_file / web_fetch / context7) ONLY to verify a SPECIFIC ` +
  `numerical or factual claim that your partner made (or one you'd otherwise invent).\n` +
  `- Do NOT call tools for exploration. Do NOT chain calls — one shot, then full text.\n` +
  `- If no claim needs verification, skip tool use entirely.\n` +
  `Tag verified results: \`[CONFIRMED via <tool>:<evidence>]\` or \`[REFUTED via <tool>:<evidence>]\`.\n` +
  `Uncited numbers you cannot verify: \`[UNVERIFIED: <claim>]\`.\n`;
const EVIDENCE_RULE_FOLLOWUP =
  `\n## Evidence Rule\n` +
  `Stay analytical. You may optionally call AT MOST ONE verification tool ` +
  `(grep / read_file / web_fetch / context7) ONLY when a SPECIFIC factual claim ` +
  `is in dispute and you need evidence to settle it.\n` +
  `- Do NOT call tools for exploration. Do NOT chain calls — one shot, then full text.\n` +
  `- Most follow-up turns will not need any tool call.\n` +
  `Tag verified results: \`[CONFIRMED via <tool>:<evidence>]\` or \`[REFUTED via <tool>:<evidence>]\`.\n` +
  `Uncited numbers you cannot verify: \`[UNVERIFIED: <claim>]\`.\n`;

/** Resolve the persona label used inside debate prompts. Stance wins; role is fallback. */
function personaOf(role: string, stance?: DebateStance): { label: string; lens: string; focus: string } {
  if (stance) {
    return {
      label: stance.name,
      lens: stance.lens,
      focus: stance.focus ?? "",
    };
  }
  return { label: `${role} specialist`, lens: `your ${role} perspective`, focus: "" };
}

export function buildOpeningPrompt(ctx: {
  speakerRole: string;
  partnerRole: string;
  speakerStance?: DebateStance;
  partnerStance?: DebateStance;
  spec: ClarifiedSpec;
  outputShape?: OutputShape;
  conversationContext?: string;
}): { system: string; prompt: string } {
  const me = personaOf(ctx.speakerRole, ctx.speakerStance);
  const them = personaOf(ctx.partnerRole, ctx.partnerStance);
  const guardrails = ctx.outputShape?.guardrails?.length
    ? `\nGuardrails for this discussion:\n${ctx.outputShape.guardrails.map((g) => `- ${g}`).join("\n")}\n`
    : "";
  const focusLine = me.focus ? `\nYour specific focus: ${me.focus}\n` : "";
  return {
    system:
      `You are the "${me.label}". Your lens: ${me.lens}.\n` +
      `You are entering a discussion with the "${them.label}" (${them.lens}).\n` +
      focusLine +
      ENGLISH_ONLY_RULE +
      EVIDENCE_RULE_OPENING +
      guardrails +
      (ctx.conversationContext ? `\n## Conversation Context\n${ctx.conversationContext}\n\n---\n\n` : "\n") +
      `## Discussion Brief\n` +
      `Problem: ${ctx.spec.problemStatement}\n` +
      `Constraints: ${ctx.spec.constraints.join("; ")}\n` +
      `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n` +
      `Scope: ${ctx.spec.scope}\n\n` +
      `Share your analysis from your stated lens. Focus on the success criteria — address each one. ` +
      `End by asking the "${them.label}" for their perspective on your analysis.`,
    prompt: `Analyze the problem through your stated lens. Be specific, evidence-based, and stay within your stance — do not drift into another role's perspective.`,
  };
}

export function buildResponsePrompt(ctx: {
  speakerRole: string;
  partnerRole: string;
  speakerStance?: DebateStance;
  partnerStance?: DebateStance;
  speakerPosition: string;
  partnerPosition: string;
  spec: ClarifiedSpec;
}): { system: string; prompt: string } {
  const me = personaOf(ctx.speakerRole, ctx.speakerStance);
  const them = personaOf(ctx.partnerRole, ctx.partnerStance);
  return {
    system:
      `You are the "${me.label}" (lens: ${me.lens}) responding to the "${them.label}" (lens: ${them.lens}).\n` +
      ENGLISH_ONLY_RULE +
      EVIDENCE_RULE_RESPONSE +
      `\n## Discussion Brief\n` +
      `Problem: ${ctx.spec.problemStatement}\n` +
      `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n\n` +
      `Give your honest take:\n` +
      `- Where you agree, say so briefly and build on it\n` +
      `- Where you disagree, explain why with your own reasoning\n` +
      `- Share what they might be missing from your stated lens\n\n` +
      `End with a question back to them.`,
    prompt:
      `Their analysis (${them.label}):\n${ctx.partnerPosition}\n\n` +
      `Your own analysis for context:\n${ctx.speakerPosition}`,
  };
}

export function buildFollowupPrompt(ctx: {
  speakerRole: string;
  partnerRole: string;
  speakerStance?: DebateStance;
  partnerStance?: DebateStance;
  partnerPosition: string;
  /** Speaker's own most recent stance (single message, not full history). */
  speakerLastPosition?: string;
  round: number;
  runningSummary?: string;
  spec: ClarifiedSpec;
}): { system: string; prompt: string } {
  const me = personaOf(ctx.speakerRole, ctx.speakerStance);
  const them = personaOf(ctx.partnerRole, ctx.partnerStance);
  return {
    system:
      `You are the "${me.label}" (lens: ${me.lens}) continuing a discussion (round ${ctx.round}) with the "${them.label}" (lens: ${them.lens}).\n` +
      ENGLISH_ONLY_RULE +
      EVIDENCE_RULE_FOLLOWUP +
      `\n` +
      (ctx.runningSummary
        ? `## Discussion State So Far\n${ctx.runningSummary}\n\nFocus on UNRESOLVED points only. Do not repeat agreed positions.\n\n`
        : "") +
      `## Success Criteria (what we need to resolve)\n` +
      ctx.spec.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\n` +
      `Read their latest response. Then:\n` +
      `- If they raised valid points, acknowledge them and update your thinking\n` +
      `- If you still disagree, bring new evidence or a different angle\n` +
      `- If you've changed your mind, say so explicitly\n\n` +
      `Stay within your lens; do not drift into the other specialist's role. ` +
      `Be concise. End with: do you agree on where we've landed?`,
    prompt:
      (ctx.speakerLastPosition
        ? `Your previous position:\n${ctx.speakerLastPosition}\n\n`
        : "") +
      `Their latest (${them.label}):\n${ctx.partnerPosition}`,
  };
}

// ── Leader evaluation prompt (replaces convergence-check) ────────────────────

export function buildLeaderEvaluationPrompt(ctx: {
  spec: ClarifiedSpec;
  exchangeLogs: string;
  round: number;
}): { system: string; prompt: string } {
  return {
    system:
      `You are the discussion moderator evaluating whether a multi-expert debate has produced sufficient results.\n` +
      ENGLISH_ONLY_RULE +
      `\n## Success Criteria to Evaluate\n` +
      ctx.spec.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\n` +
      `For EACH criterion, determine:\n` +
      `- Is it adequately addressed by the debate? (met/not-met)\n` +
      `- What evidence from the debate supports this?\n\n` +
      `If the debate is stuck because participants lack factual information (not opinions), set needsResearch=true and provide the research query.\n\n` +
      `## Early-exit bias (IMPORTANT)\n` +
      `Set shouldContinue=false aggressively when ANY of these convergence signals appear in the latest exchanges:\n` +
      `- Multiple participants use phrases like "final position", "where we've landed", "agreed approach", "I concede", "you're right", "I've updated my view"\n` +
      `- The remaining disagreements are minor wording, not substantive trade-offs\n` +
      `- The next round would mostly repeat already-stated positions\n` +
      `Continuing past convergence wastes ~120-150s per round and adds no new content. Prefer to stop early — the user can always /ask-followup to clarify a specific point.\n\n` +
      `Output ONLY a JSON object (no markdown):\n` +
      `{\n` +
      `  "allCriteriaMet": true/false,\n` +
      `  "criteriaStatus": [{"criterion": "...", "met": true/false, "evidence": "..."}],\n` +
      `  "unresolvedPoints": ["point 1"],\n` +
      `  "needsResearch": false,\n` +
      `  "researchQuery": null,\n` +
      `  "shouldContinue": true/false,\n` +
      `  "reason": "one sentence explaining your decision",\n` +
      `  "evidenceDensity": 0.0,  // citations / total claims ratio (0.0–1.0)\n` +
      `  "disagreementResolved": 0,  // count of [REFUTED] + [CONFIRMED] tags and explicit concessions\n` +
      `  "extendRounds": 0  // set to 1-3 ONLY when this is the last planned round AND one critical point is genuinely close to resolving but not yet there. 0 otherwise.\n` +
      `}`,
    prompt: `## Debate (Round ${ctx.round})\n${ctx.exchangeLogs}`,
  };
}

// ── Round summary ────────────────────────────────────────────────────────────

export function buildRoundSummaryPrompt(allExchanges: string, topic: string, round: number): {
  system: string;
  prompt: string;
} {
  return {
    system:
      `Summarize this discussion in 3-5 bullet points.` +
      ENGLISH_ONLY_RULE +
      `\nFocus on:\n` +
      `1. Points where participants AGREE\n` +
      `2. Points still in DISPUTE (with each side's core argument)\n` +
      `3. New EVIDENCE or perspectives raised this round\n` +
      `Be concise — one line per bullet. No preamble.`,
    prompt: `Round ${round} discussion on: ${topic}\n\n${allExchanges}`,
  };
}

// ── Synthesis + Planning ─────────────────────────────────────────────────────

/** Build the leader-LLM prompt that proposes stances + output shape for a topic. */
export function buildDebatePlanPrompt(spec: ClarifiedSpec): { system: string; prompt: string } {
  return {
    system:
      `You are the lead facilitator for a multi-expert discussion. Before the debate starts, ` +
      `you decide what KIND of conversation this is and what specialists should participate.\n\n` +
      `## Language Rule\n` +
      `All structured fields you produce — stance \`name\`, \`lens\`, \`focus\`, output-shape \`key\`/\`heading\`/\`prompt\`, and \`guardrails\` — MUST be in English. ` +
      `These power English-only debate prompts and citation tags. ` +
      `The only field allowed (and required) to be in the user's language is \`intentSummary\`, which is displayed to the user.\n\n` +
      `Read the topic carefully. Topics vary widely:\n` +
      `- Evaluation/comparison ("compare X vs Y", "review project", "đánh giá") → analyst stances, evaluation output\n` +
      `- Implementation ("build X", "fix bug Y", "add feature Z") → engineering stances, plan output\n` +
      `- Decision ("should we X?", "X or Y?") → advocate/skeptic stances, decision output\n` +
      `- Investigation ("why does X fail?", "what causes Y?") → investigator stances, finding output\n` +
      `- Open-ended exploration → diverse curious stances, exploration output\n` +
      `Do NOT force every topic into the same shape.\n\n` +
      `Propose:\n` +
      `1. \`stances\`: 2-3 specialists tailored to THIS topic. Each has a distinct lens that produces ` +
      `productive disagreement. Avoid overlap. Stances should fit the topic, NOT generic ` +
      `"implement/verify/research" labels.\n` +
      `2. \`outputShape\`: the JSON sections the synthesis should produce. ` +
      `Pick keys/headings that match what the user actually wants to receive. ` +
      `Be specific to the topic.\n` +
      `\nUse the following per-kind templates as the starting point — adapt section keys to the specific topic, but keep the shape (list vs objectList) and the structured fields for objectLists. These templates exist because earlier sessions produced loose bullet lists that the user couldn't act on.\n` +
      `\n**evaluation** — comparing or grading existing thing(s):\n` +
      `  - strengths: list — concrete strengths with evidence\n` +
      `  - weaknesses: list — concrete weaknesses with evidence\n` +
      `  - comparisons: objectList of {dimension, subject_a, subject_b, winner, why} — only when comparing multiple subjects\n` +
      `  - recommendation: text — decisive verdict\n` +
      `\n**implementation_plan** — building/changing something:\n` +
      `  - agreed_architecture: text — what the design IS, in prose\n` +
      `  - tradeoffs: objectList of {decision, option_a, option_b, chosen, why}\n` +
      `  - risks: objectList of {description, severity: "High"|"Medium"|"Low", mitigation}\n` +
      `  - actionItems: objectList of {step, owner_lens, time_estimate, depends_on, acceptance_criteria}\n` +
      `  - dissenting_notes: list — minority opinions NOT to lose in synthesis (e.g. "X argued for B over A; if assumption Y fails, revisit")\n` +
      `  - mvp_definition: text — explicit v1 cut-line\n` +
      `  Order actionItems by dependency — predecessors before dependents.\n` +
      `\n**decision** — choose between options:\n` +
      `  - options: objectList of {name, pros, cons, cost_estimate}\n` +
      `  - recommendation: text — which option, decisively\n` +
      `  - rationale: list — reasons supporting the choice\n` +
      `  - kill_criteria: list — conditions under which this decision should be revisited\n` +
      `\n**investigation** — diagnose a bug or understand a failure:\n` +
      `  - hypotheses: objectList of {hypothesis, evidence_for, evidence_against, likelihood: "High"|"Medium"|"Low", next_diagnostic}\n` +
      `  - recommended_diagnostic: text — the ONE next step that maximally discriminates between top hypotheses\n` +
      `  - confidence_level: text — how confident are we that root cause is in this list?\n` +
      `  - kill_signal: text — what evidence would tell us we've found the actual root cause\n` +
      `\n**exploration** — feasibility / greenfield idea:\n` +
      `  - feasibility_matrix: objectList of {approach, blockers, cost_estimate, mvp_scope, confidence}\n` +
      `  - competitive_landscape: list — existing solutions that already do this or part of it\n` +
      `  - kill_criteria: list — conditions under which the idea is NOT worth pursuing\n` +
      `  - recommendation: text — go / no-go / scoped pilot\n` +
      `3. \`guardrails\`: behavioral rules participants must obey. ` +
      `Examples: "cite sources for numbers", "do not propose code changes", "stay within YYYY constraint".\n\n` +
      `4. \`plannedRounds\`: 1-5. How many discussion rounds you expect this topic to need. ` +
      `Simple yes/no decisions: 1-2. Multi-faceted design or trade-off analysis: 3. ` +
      `Deep architecture / multi-system debate: 4-5. The leader can extend this ` +
      `mid-debate if needed — DO NOT pad. Cheaper is faster and uses less context.\n\n` +
      `Output ONLY a JSON object (no markdown, no preamble):\n` +
      `{\n` +
      `  "intentSummary": "one sentence in the user's language naming what they want",\n` +
      `  "stances": [{"name": "Comparative Analyst", "lens": "How does X stack up vs Y on dimension Z?", "focus": "specific concrete focus"}],\n` +
      `  "outputShape": {\n` +
      `    "kind": "evaluation|implementation_plan|decision|investigation|exploration|other",\n` +
      `    "sections": [\n` +
      `      {"key": "strengths", "heading": "Strengths", "prompt": "what the subject does well, with evidence", "shape": "list"},\n` +
      `      {"key": "recommendation", "heading": "Recommendation", "prompt": "decisive verdict in 1-2 sentences", "shape": "text"}\n` +
      `    ],\n` +
      `    "guardrails": ["cite the source for any numeric claim", "..."]\n` +
      `  },\n` +
      `  "plannedRounds": 3\n` +
      `}`,
    prompt:
      `## Topic\n${spec.problemStatement}\n\n` +
      `## Constraints\n${spec.constraints.map((c) => `- ${c}`).join("\n") || "- (none)"}\n\n` +
      `## Success Criteria\n${spec.successCriteria.map((c) => `- ${c}`).join("\n")}\n\n` +
      `## Scope\n${spec.scope || "(unspecified)"}`,
  };
}

function shapeHint(s: OutputSection): string {
  if (s.shape === "list") return `["...", "..."]`;
  if (s.shape === "objectList") return `[{"key": "value"}, {"key": "value"}]`;
  return `"..."`;
}

/**
 * Per-shape Markdown rendering hint. Without this, the LLM emits inconsistent
 * shapes — sometimes a bulleted list of "field: value" strings, sometimes a
 * table, sometimes prose. The reader needs structured output to be scannable.
 *
 * objectList → Markdown table with one row per object, columns from the
 * object keys, header derived from the keys.
 * list       → standard bulleted list (`- item`).
 * text       → prose paragraph (no markup imposed).
 */
function renderHintFor(s: OutputSection): string {
  if (s.shape === "objectList") {
    return (
      `   Render as a Markdown table. Use the JSON object keys as columns. ` +
      `One row per object. Keep cells concise — ≤ 12 words per cell. ` +
      `If a field is a list (e.g. depends_on), join with ", ". ` +
      `If the table would exceed 4 columns, drop the least-informative column or split the section.`
    );
  }
  if (s.shape === "list") {
    return `   Render as a Markdown bulleted list — one bullet per JSON array item.`;
  }
  return `   Render as one prose paragraph — no bullets, no table.`;
}

/**
 * Synthesis prompt is now shape-driven. The leader's {@link DebatePlan} controls
 * which JSON sections the synthesizer emits and which Markdown headings render.
 * No keyword detection, no hardcoded enum.
 */
export function buildSynthesisPrompt(ctx: {
  spec: ClarifiedSpec;
  finalPositions: string;
  allExchanges: string;
  debatePlan?: DebatePlan;
  outputStyle?: string | null; // CQ-18: from PIL Layer 6 ctx.outputStyle
  refineContext?: string;      // User answers from post-debate refinement askcard
  planEmphasis?: boolean;       // If true, instruct LLM to produce a concrete action plan
}): { system: string; prompt: string } {
  const shape = ctx.debatePlan?.outputShape;

  // Fallback shape — used only when the planner step failed or was skipped.
  const fallback: OutputShape = {
    kind: "decision",
    sections: [
      { key: "agreed", heading: "Agreed", prompt: "points participants converged on", shape: "list" },
      { key: "tradeoffs", heading: "Trade-offs", prompt: "real trade-offs identified", shape: "list" },
      { key: "recommendation", heading: "Recommendation", prompt: "decisive verdict", shape: "text" },
    ],
    guardrails: ["Be evidence-grounded; flag any claim that lacks support."],
  };
  const finalShape = shape ?? fallback;
  const intent = ctx.debatePlan?.intentSummary
    ? `\n## What the user actually asked for\n${ctx.debatePlan.intentSummary}\n`
    : "";

  const sectionLines = finalShape.sections
    .map((s) => `  "${s.key}": ${shapeHint(s)}, // ${s.prompt}`)
    .join("\n");
  const headingLines = finalShape.sections
    .map((s) => `## ${s.heading}\n${renderHintFor(s)}`)
    .join("\n");
  const guardrailBlock = finalShape.guardrails.length
    ? `\n## Guardrails\n${finalShape.guardrails.map((g) => `- ${g}`).join("\n")}\n`
    : "";

  // CQ-18: Respect PIL outputStyle from Layer 6 (concise/balanced/detailed)
  const styleDirective = ctx.outputStyle
    ? `Output style preference: ${ctx.outputStyle}. ` +
      (ctx.outputStyle === "concise"
        ? "Be brief and direct. Prefer bullet lists. Omit preamble."
        : ctx.outputStyle === "detailed"
        ? "Be thorough. Include rationale and evidence for each point."
        : "Balance clarity with completeness.") // balanced (default)
    : "";

  let system =
    `You are the team lead synthesizing a multi-specialist discussion.\n\n` +
    `## Original Brief\n` +
    `Problem: ${ctx.spec.problemStatement}\n` +
    `Constraints: ${ctx.spec.constraints.join("; ")}\n` +
    `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n` +
    intent +
    guardrailBlock +
    `\nProduce the answer the user requested — do NOT default to an implementation plan ` +
    `unless the output shape explicitly asks for actionItems/plan. ` +
    `Stay grounded in the discussion; do not invent facts; mark unverified claims explicitly.\n\n` +
    `## Language Rule (mandatory)\n` +
    `The debate above is entirely in English (debate language is forced). The user wrote the ` +
    `Problem Statement above in their own native language. You must:\n` +
    `- **Part 1 (JSON)**: keys, the \`type\` field, and citation/tag strings stay in ENGLISH. ` +
    `Free-text values inside JSON fields (\`summary\`, list items, prose sections) MUST use ` +
    `the SAME language the user used in the Problem Statement.\n` +
    `- **Part 2 (Markdown)**: write entirely in the user's native language. Markdown headings ` +
    `that we control (the ones listed below) stay in English as printed, but body text under ` +
    `each heading is in the user's language.\n` +
    `- Detect the user's language from the Problem Statement. If it's Vietnamese, write in ` +
    `Vietnamese. If Japanese, Japanese. If English, English. Do not translate code, identifiers, ` +
    `or quoted citation tags (\`[REFUTED via ...]\`, \`[CONFIRMED via ...]\`).\n\n` +
    `Output TWO parts separated by the exact line \`---READABLE---\`:\n\n` +
    `**Part 1: JSON** — a single JSON object:\n` +
    `{\n` +
    `  "type": "${finalShape.kind}",\n` +
    `  "summary": "1-2 sentence executive summary in the user's native language",\n` +
    sectionLines + "\n" +
    `}\n\n` +
    `**Part 2: Human-readable** — after \`---READABLE---\`, write in markdown with these headings (in this order):\n` +
    headingLines +
    `\n\nBe decisive but evidence-grounded.`;

  if (styleDirective) {
    system = `${styleDirective}\n\n${system}`;
  }

  let extraContext = "";
  if (ctx.refineContext) {
    extraContext += `
## User Refinements
${ctx.refineContext}
`;
  }
  if (ctx.planEmphasis) {
    extraContext += `
## Additional Instruction
The user has requested a concrete action plan with executable steps. Each action item MUST be an object with these fields:
  {
    "step": "<imperative action>",
    "owner_lens": "<which stance owns this — frontend / backend / architecture / etc>",
    "time_estimate": "<rough — e.g. '2h', '1d', '~30min'>",
    "depends_on": ["<step keys this requires>"] or [],
    "acceptance_criteria": "<how we know it's done>"
  }
Order action items by dependency: predecessors first, dependents after.
Risks MUST be objects with: {"description", "severity": "High|Medium|Low", "mitigation"}.
Do NOT emit loose strings for these fields — the user needs structured plan output.
`;
  }
  return {
    system,
    prompt: `Final positions:
${ctx.finalPositions}

Full discussion:
${ctx.allExchanges}${extraContext}`,
  };
}

// ── Research output template (Phase 14 CQ-05) ────────────────────────────────

/**
 * Builds the system prompt for the research role.
 *
 * When `hasUrl` is true, injects a mandatory instruction to invoke a Playwright
 * or Chrome-DevTools tool before reporting Frontend Findings (CQ-04).
 *
 * Output format enforces 3 labelled sections with citation requirements (CQ-05).
 */
export function buildResearchSystemPrompt(hasUrl: boolean, internetFirst = false): string {
  const urlInstruction = hasUrl
    ? `\n## URL Research Requirement\n` +
      `This topic contains a URL. You MUST invoke a Playwright or Chrome-DevTools tool ` +
      `to navigate to it before reporting Frontend Findings. Do not skip this step.\n`
    : "";

  const modeBlock = internetFirst
    ? `\n## Research Mode: INTERNET-FIRST\n` +
      `The workspace has no existing source code. Prefer internet search (tavily, web-fetch, ` +
      `context7 docs) and official documentation. Do NOT spend cycles grep-ing an empty repo. ` +
      `If browser/search tools are unavailable, state the gap explicitly under "Research Gap".\n`
    : `\n## Research Mode: CODEBASE-FIRST\n` +
      `The workspace contains source code. Investigate it first (grep, file read, ` +
      `repo-deep-map). Use the internet only to fill gaps the codebase cannot answer.\n`;

  return (
    `You are a research specialist. Gather FACTS using available tools.\n` +
    modeBlock +
    urlInstruction +
    `\n## Output Format (MANDATORY — 3 sections, no exceptions)\n\n` +
    `## Source Code Findings\n` +
    `Each finding must cite [file:line]. Example: \`src/council/index.ts:43\`.\n` +
    (internetFirst
      ? `If the workspace is empty, write: _No source code in workspace — internet-first mode._\n\n`
      : `If nothing found, write: _No relevant source code found._\n\n`) +
    `## Internet Findings\n` +
    `Each finding must cite [url]. Example: \`[https://example.com/page]\`.\n` +
    `If no internet search was performed, write: ` +
    `_No internet research performed (tavily/web-fetch unavailable or not needed)._\n\n` +
    `## Frontend Findings (live)\n` +
    `Each finding must cite [snapshot:uid] from a Playwright screenshot or Chrome-DevTools inspection.\n` +
    `If no URL was present or browser tool was not invoked, write: _No live frontend inspection performed._\n\n` +
    `Do NOT speculate. Only report what you verified with tools.`
  );
}
