import type { ClarifiedSpec } from "./types.js";

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
      `Output ONLY a JSON array (no markdown, no preamble):\n` +
      `[{"question": "...", "why": "why this matters for a focused discussion", "suggestions": ["option A", "option B"], "isRequired": true}]\n` +
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

export function buildOpeningPrompt(ctx: {
  speakerRole: string;
  partnerRole: string;
  spec: ClarifiedSpec;
  conversationContext?: string;
}): { system: string; prompt: string } {
  return {
    system:
      `You are a ${ctx.speakerRole} specialist. You are entering a discussion with a ${ctx.partnerRole} specialist.\n\n` +
      (ctx.conversationContext ? `## Conversation Context\n${ctx.conversationContext}\n\n---\n\n` : "") +
      `## Discussion Brief\n` +
      `Problem: ${ctx.spec.problemStatement}\n` +
      `Constraints: ${ctx.spec.constraints.join("; ")}\n` +
      `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n` +
      `Scope: ${ctx.spec.scope}\n\n` +
      `Share your analysis. Focus on the success criteria — address each one. ` +
      `End by asking the ${ctx.partnerRole} for their perspective on your analysis.`,
    prompt: `Analyze the problem from your ${ctx.speakerRole} perspective. Be specific and evidence-based.`,
  };
}

export function buildResponsePrompt(ctx: {
  speakerRole: string;
  partnerRole: string;
  speakerPosition: string;
  partnerPosition: string;
  spec: ClarifiedSpec;
}): { system: string; prompt: string } {
  return {
    system:
      `You are a ${ctx.speakerRole} specialist responding to a ${ctx.partnerRole} specialist.\n\n` +
      `## Discussion Brief\n` +
      `Problem: ${ctx.spec.problemStatement}\n` +
      `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n\n` +
      `Give your honest take:\n` +
      `- Where you agree, say so briefly and build on it\n` +
      `- Where you disagree, explain why with your own reasoning\n` +
      `- Share what they might be missing from your ${ctx.speakerRole} perspective\n\n` +
      `End with a question back to them.`,
    prompt:
      `Their analysis (${ctx.partnerRole}):\n${ctx.partnerPosition}\n\n` +
      `Your own analysis for context:\n${ctx.speakerPosition}`,
  };
}

export function buildFollowupPrompt(ctx: {
  speakerRole: string;
  partnerRole: string;
  partnerPosition: string;
  exchangeHistory: string;
  round: number;
  runningSummary?: string;
  spec: ClarifiedSpec;
}): { system: string; prompt: string } {
  return {
    system:
      `You are a ${ctx.speakerRole} specialist continuing a discussion (round ${ctx.round}) with a ${ctx.partnerRole} specialist.\n\n` +
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
      `Be concise. End with: do you agree on where we've landed?`,
    prompt:
      `Discussion so far:\n${ctx.exchangeHistory}\n\n` +
      `Their latest (${ctx.partnerRole}):\n${ctx.partnerPosition}`,
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
      `  "reason": "one sentence explaining your decision"\n` +
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

export function buildSynthesisPrompt(ctx: {
  spec: ClarifiedSpec;
  finalPositions: string;
  allExchanges: string;
}): { system: string; prompt: string } {
  return {
    system:
      `You are the team lead. Multiple specialists just had a structured discussion.\n\n` +
      `## Original Brief\n` +
      `Problem: ${ctx.spec.problemStatement}\n` +
      `Constraints: ${ctx.spec.constraints.join("; ")}\n` +
      `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n\n` +
      `Output TWO parts separated by the exact line \`---READABLE---\`:\n\n` +
      `**Part 1: JSON** — a single JSON object:\n` +
      `{\n` +
      `  "type": "decision"|"action_items"|"plan_update"|"resolve_question",\n` +
      `  "summary": "1-2 sentence executive summary",\n` +
      `  "agreed": ["point 1", "point 2"],\n` +
      `  "tradeoffs": ["trade-off 1"],\n` +
      `  "recommendation": "Your decisive recommendation",\n` +
      `  "actionItems": ["step 1", "step 2"],\n` +
      `  "plan": {\n` +
      `    "steps": [{"description": "...", "priority": "high|medium|low"}],\n` +
      `    "estimatedComplexity": "trivial|moderate|complex",\n` +
      `    "prerequisites": ["..."]\n` +
      `  }\n` +
      `}\n\n` +
      `**Part 2: Human-readable** — after \`---READABLE---\`, write in markdown:\n` +
      `## AGREED\n## TRADE-OFFS\n## RECOMMENDATION\n## NEXT STEPS\n\n` +
      `Be decisive.`,
    prompt: `Final positions:\n${ctx.finalPositions}\n\nFull discussion:\n${ctx.allExchanges}`,
  };
}
