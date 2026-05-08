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
      `If the topic is already specific enough (has clear scope, constraints, and criteria), return an empty array.\n\n` +
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

/** Evidence rule injected into every stance-prompt builder. */
const EVIDENCE_RULE_OPENING =
  `\n## Evidence Rule\n` +
  `If you dispute a verifiable claim made by your partner, you MUST run a tool to verify it first.\n` +
  `Tag your result:\n` +
  `- \`[REFUTED via <tool>:<evidence>]\` if the claim is false\n` +
  `- \`[CONFIRMED via <tool>:<evidence>]\` if the claim holds\n` +
  `If no tool is available, note the claim as unverified: \`[UNVERIFIED: <claim>]\`.\n`;
const EVIDENCE_RULE_RESPONSE =
  `\n## Evidence Rule\n` +
  `If you dispute a verifiable claim made by your partner, you MUST run a tool to verify it first.\n` +
  `Tag your result:\n` +
  `- \`[REFUTED via <tool>:<evidence>]\` if the claim is false\n` +
  `- \`[CONFIRMED via <tool>:<evidence>]\` if the claim holds\n` +
  `If no tool is available, note the claim as unverified: \`[UNVERIFIED: <claim>]\`.\n`;
const EVIDENCE_RULE_FOLLOWUP =
  `\n## Evidence Rule\n` +
  `If you dispute a verifiable claim made by your partner, you MUST run a tool to verify it first.\n` +
  `Tag your result:\n` +
  `- \`[REFUTED via <tool>:<evidence>]\` if the claim is false\n` +
  `- \`[CONFIRMED via <tool>:<evidence>]\` if the claim holds\n` +
  `If no tool is available, note the claim as unverified: \`[UNVERIFIED: <claim>]\`.\n`;

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
  exchangeHistory: string;
  round: number;
  runningSummary?: string;
  spec: ClarifiedSpec;
}): { system: string; prompt: string } {
  const me = personaOf(ctx.speakerRole, ctx.speakerStance);
  const them = personaOf(ctx.partnerRole, ctx.partnerStance);
  return {
    system:
      `You are the "${me.label}" (lens: ${me.lens}) continuing a discussion (round ${ctx.round}) with the "${them.label}" (lens: ${them.lens}).\n` +
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
      `Discussion so far:\n${ctx.exchangeHistory}\n\n` +
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
      `You are the discussion moderator evaluating whether a multi-expert debate has produced sufficient results.\n\n` +
      `## Success Criteria to Evaluate\n` +
      ctx.spec.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\n` +
      `For EACH criterion, determine:\n` +
      `- Is it adequately addressed by the debate? (met/not-met)\n` +
      `- What evidence from the debate supports this?\n\n` +
      `If the debate is stuck because participants lack factual information (not opinions), set needsResearch=true and provide the research query.\n\n` +
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
      `  "disagreementResolved": 0  // count of [REFUTED] + [CONFIRMED] tags and explicit concessions\n` +
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
      `Summarize this discussion in 3-5 bullet points. Focus on:\n` +
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
      `For evaluation, use sections like strengths/weaknesses/comparisons/recommendation. ` +
      `For implementation, use sections like agreed/tradeoffs/actionItems/plan. ` +
      `For decisions, use sections like options/recommendation/rationale. ` +
      `Be specific to the topic.\n` +
      `3. \`guardrails\`: behavioral rules participants must obey. ` +
      `Examples: "cite sources for numbers", "do not propose code changes", "stay within YYYY constraint".\n\n` +
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
      `  }\n` +
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
 * Synthesis prompt is now shape-driven. The leader's {@link DebatePlan} controls
 * which JSON sections the synthesizer emits and which Markdown headings render.
 * No keyword detection, no hardcoded enum.
 */
export function buildSynthesisPrompt(ctx: {
  spec: ClarifiedSpec;
  finalPositions: string;
  allExchanges: string;
  debatePlan?: DebatePlan;
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
    .map((s) => `## ${s.heading}`)
    .join("\n");
  const guardrailBlock = finalShape.guardrails.length
    ? `\n## Guardrails\n${finalShape.guardrails.map((g) => `- ${g}`).join("\n")}\n`
    : "";

  return {
    system:
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
      `Output TWO parts separated by the exact line \`---READABLE---\`:\n\n` +
      `**Part 1: JSON** — a single JSON object:\n` +
      `{\n` +
      `  "type": "${finalShape.kind}",\n` +
      `  "summary": "1-2 sentence executive summary",\n` +
      sectionLines + "\n" +
      `}\n\n` +
      `**Part 2: Human-readable** — after \`---READABLE---\`, write in markdown with these headings (in this order):\n` +
      headingLines +
      `\n\nBe decisive but evidence-grounded.`,
    prompt: `Final positions:\n${ctx.finalPositions}\n\nFull discussion:\n${ctx.allExchanges}`,
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
export function buildResearchSystemPrompt(hasUrl: boolean): string {
  const urlInstruction = hasUrl
    ? `\n## URL Research Requirement\n` +
      `This topic contains a URL. You MUST invoke a Playwright or Chrome-DevTools tool ` +
      `to navigate to it before reporting Frontend Findings. Do not skip this step.\n`
    : "";

  return (
    `You are a research specialist. Gather FACTS using available tools.\n` +
    urlInstruction +
    `\n## Output Format (MANDATORY — 3 sections, no exceptions)\n\n` +
    `## Source Code Findings\n` +
    `Each finding must cite [file:line]. Example: \`src/council/index.ts:43\`.\n` +
    `If nothing found, write: _No relevant source code found._\n\n` +
    `## Internet Findings\n` +
    `Each finding must cite [url]. Example: \`[https://example.com/page]\`.\n` +
    `If no internet search was performed, write: ` +
    `_No internet research performed (tavily unavailable or not needed)._\n\n` +
    `## Frontend Findings (live)\n` +
    `Each finding must cite [snapshot:uid] from a Playwright screenshot or Chrome-DevTools inspection.\n` +
    `If no URL was present or browser tool was not invoked, write: _No live frontend inspection performed._\n\n` +
    `Do NOT speculate. Only report what you verified with tools.`
  );
}
