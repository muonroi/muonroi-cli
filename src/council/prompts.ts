import { buildStackLockSection } from "./decisions-lock.js";
import type { ClarifiedSpec, DebatePlan, DebateStance, OutputSection, OutputShape } from "./types.js";

// ── Clarification prompts ────────────────────────────────────────────────────

export function buildClarificationPrompt(
  topic: string,
  conversationContext: string,
  previousQA?: Array<{ question: string; answer: string }>,
): {
  system: string;
  prompt: string;
} {
  const qaSection = previousQA?.length
    ? `\n\n## Already Clarified\n${previousQA.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")}`
    : "";

  return {
    system:
      `You are a senior technical lead preparing for a multi-expert discussion. ` +
      `Your job is to surface the FEW genuine ambiguities that would make experts talk past each other — NOT to run a questionnaire.\n\n` +
      `Read the topic and the conversation context — especially any "## Current Project" section — carefully. ` +
      `Ask ONLY about things you genuinely cannot infer and that would actually change the plan:\n` +
      `- SCOPE: what is in/out of scope for THIS change?\n` +
      `- CONSTRAINTS: hard technical/time/business constraints not already implied by the context.\n` +
      `- SUCCESS CRITERIA: how "done" is judged, when it isn't already obvious.\n\n` +
      `## How many questions\n` +
      `Ask the minimum that unblocks a focused discussion — typically 0-2. A well-scoped topic, or one ` +
      `whose context already answers the gaps, needs ZERO questions: return []. Do NOT pad to a quota, ` +
      `and never ask a question whose answer is already in the topic or the project context.\n\n` +
      `## Existing-repo grounding (IMPORTANT)\n` +
      `If a "## Current Project" section is present you are working in an EXISTING repository — NOT a ` +
      `greenfield project. Ground every question and every option in what that snapshot actually shows ` +
      `(its language, framework, modules, conventions). Do NOT ask generic greenfield questions — product ` +
      `type, target audience, which language/framework, which database, hosting — when the repo already ` +
      `answers them; asking those signals you ignored the context and wastes the user's time. Ask only ` +
      `about intent/scope decisions specific to THIS change, phrased in terms of the real codebase.\n\n` +
      `IMPORTANT — defaults from the workspace:\n` +
      `- If the topic refers to "this project", "current project", "repo này", "dự án hiện tại" or similar, ` +
      `the project IS the one described in the "## Current Project" section of the context. DO NOT ask which project.\n` +
      `- Only ask about project identity when the topic mentions multiple distinct projects or external products.\n` +
      `- Use the project's package.json name and description as implicit context for follow-up questions.\n\n` +
      `## Language Rule (mandatory)\n` +
      `Write the "question", "why", and every "suggestions"/"recommended" option in the SAME ` +
      `language the user used in the Topic below — detect it; if the user wrote Vietnamese, write ` +
      `Vietnamese; if English, English. The user reads and answers these on a card, so they must ` +
      `NOT default to English. Keep code identifiers, file paths, tech/product names, and JSON keys in English.\n\n` +
      `Output ONLY a JSON array (no markdown, no preamble):\n` +
      `[{"question": "...", "why": "why this matters for a focused discussion", "suggestions": ["option A", "option B"], "recommended": "option A", "isRequired": true}]\n\n` +
      `Rules for "recommended" (be decisive — the user should never face an unranked list):\n` +
      `- ALWAYS include "recommended" — the single option you would choose if the user said "you decide", given the topic + project context.\n` +
      `- Its value MUST be exactly equal to one of the entries in "suggestions".\n` +
      `- Omit it ONLY in a genuine 50/50 tie where recommending either option would be misleading. A missing recommendation must be the rare exception, not the default.\n` +
      `Return [] if no clarification is needed.`,
    prompt:
      `## Topic\n${topic}\n\n` +
      (conversationContext ? `## Conversation Context\n${conversationContext}\n` : "") +
      qaSection,
  };
}

export function buildSpecSynthesisPrompt(
  topic: string,
  conversationContext: string,
  qa: Array<{ question: string; answer: string }>,
): {
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
      `}\n\n` +
      `## Language Rule (mandatory)\n` +
      `Write EVERY field (problemStatement, constraints, successCriteria, scope) in the SAME ` +
      `language the user used — detect it from the Original Topic and Clarification Q&A below. ` +
      `If the user wrote Vietnamese, write Vietnamese; if English, English. Do NOT default to ` +
      `English. This brief is shown to the user on the approval card AND the final synthesis ` +
      `detects its output language from this problemStatement, so writing it in the wrong ` +
      `language drags the whole council's output off the user's language. Keep code identifiers, ` +
      `tech/product names, and JSON keys in English.`,
    prompt:
      `## Original Topic\n${topic}\n\n` +
      (conversationContext ? `## Context\n${conversationContext}\n\n` : "") +
      `## Clarification Q&A\n${qa.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")}`,
  };
}

// ── P5: Readiness judge prompt ───────────────────────────────────────────────

/**
 * Build system + prompt for the ready-gate judge.
 *
 * The judge receives the topic, all Q&A so far, and the current partial spec,
 * then decides whether enough context exists to start a productive debate or
 * whether there are still critical gaps.
 *
 * Output shape: { ready: boolean, confidence: number, gaps: string[] }
 *   - ready: true when a debate can start without blind spots
 *   - confidence: 0.0–1.0 (1.0 = judge is certain, 0.0 = major unknowns)
 *   - gaps: 1-line descriptions of WHAT is still missing (empty when ready)
 */
export function buildReadinessJudgePrompt(
  topic: string,
  qa: Array<{ question: string; answer: string }>,
  spec: { problemStatement: string; constraints: string[]; successCriteria: string[]; scope: string },
): { system: string; prompt: string } {
  return {
    system:
      `You are a senior debate facilitator deciding whether a clarification session has collected ` +
      `enough context for a productive multi-expert debate.\n\n` +
      `A debate can start when ALL of the following are true:\n` +
      `1. The problem statement is specific enough that experts won't derail into "what are we solving?"\n` +
      `2. At least one success criterion is measurable/observable.\n` +
      `3. Any hard constraints (platform, budget, tech stack) are either stated or provably irrelevant.\n` +
      `4. Scope boundaries are clear enough that debate stays focused.\n\n` +
      `Output ONLY a JSON object (no markdown, no preamble):\n` +
      `{ "ready": true|false, "confidence": 0.0-1.0, "gaps": ["gap 1", "gap 2"] }\n\n` +
      `Rules:\n` +
      `- "gaps" MUST be empty when "ready" is true.\n` +
      `- Each gap is a single sentence starting with a noun: what info is missing (not a question).\n` +
      `  Example: "Target platform (web, mobile, or both) not specified."\n` +
      `- "confidence" reflects how sure you are; a ready=true with confidence=0.6 means "probably ready but some ambiguity remains". confidence=1.0 means zero remaining blind spots.\n` +
      `- When the topic is a simple one-answer technical question (no design/scope), set ready=true, ` +
      `  confidence=1.0, gaps=[].`,
    prompt:
      `## Topic\n${topic}\n\n` +
      `## Current Spec\n` +
      `Problem: ${spec.problemStatement}\n` +
      `Constraints: ${spec.constraints.length > 0 ? spec.constraints.join("; ") : "(none)"}\n` +
      `Success Criteria: ${spec.successCriteria.join("; ")}\n` +
      `Scope: ${spec.scope || "(unspecified)"}\n\n` +
      (qa.length > 0
        ? `## Clarification Q&A So Far\n${qa.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join("\n\n")}\n\n`
        : "## Clarification Q&A So Far\n(none — topic only)\n\n") +
      `Is this sufficient to start a focused, productive debate? Respond with JSON only.`,
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
// Opening turns run tool-free (openingWithRetry → llm.generate, no verification
// tools wired). The rule must NOT advertise tools the model cannot call, or it
// hallucinates `[CONFIRMED via grep:...]` tags for searches it never ran.
const EVIDENCE_RULE_OPENING =
  `\n## Evidence Rule\n` +
  `Stay analytical and ground every claim in the brief + context you were given. ` +
  `You have NO tools in this opening turn — do not claim to have run grep / read_file / web searches.\n` +
  `- For any number or library spec you cannot support from the provided context, mark it \`[UNVERIFIED: <claim>]\` instead of asserting it.\n` +
  `- A later round can verify disputed claims; your job now is a clear, honest analysis.\n`;
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

/**
 * Length discipline injected into every debate turn (F13 token-thrift). The
 * debate-turn ceilings are generous (4096-6144 maxTokens) and reasoning models
 * left unbounded emit ~400-600 words/turn — ~17 turns/debate is token-heavy and
 * directly fights the "tiết kiệm token" goal. A concrete word cap + "density
 * over length" cuts filler / preamble / brief-restating while keeping the
 * analytical core (position, reasoning bullets, the cross-question). This does
 * NOT lower maxTokens: reasoning models need that headroom to think without
 * empty-turn truncation (see llm.ts) — the saving comes from the model writing
 * less, not from a hard output ceiling. The text deliberately contains none of
 * the prompt substrings the council mocks route on (e.g. "responding to",
 * "continuing a discussion", "team lead", "Summarize this discussion").
 */
function concisenessRule(maxWords: number): string {
  return (
    `\n## Length (be token-thrifty)\n` +
    `Keep this turn under ~${maxWords} words. Open with your position in one line, ` +
    `then 2-4 bullets of your strongest reasoning. No preamble, no restating the ` +
    `brief, no filler — density over length. A tight argument beats a long one.\n`
  );
}

/** Resolve the persona label used inside debate prompts. Stance wins; role is fallback. */
function personaOf(role: string, stance?: DebateStance): { label: string; lens: string; focus: string } {
  if (stance) {
    return {
      label: stance.name,
      lens: stance.lens,
      focus: stance.focus ?? "",
    };
  }
  return {
    label: `${role} specialist`,
    lens: `the ${role} discipline — what a proposal costs, breaks, or unlocks in your domain, judged with a practitioner's scar tissue`,
    focus: "",
  };
}

/**
 * Ongoing-task context block, threaded from `spec.parentContext`. Both the
 * explicit `/council` path and auto-council attach the session/task context onto
 * the spec (see council/index.ts), so EVERY debate stage — rebuttal, follow-up,
 * leader evaluation, synthesis — stays anchored to the parent task and the
 * decisions already made, instead of drifting off the isolated sub-task.
 *
 * `buildOpeningPrompt` already injects `conversationContext` directly, so it does
 * NOT call this (avoids double-inclusion in the opening statement). Capped so a
 * long session context cannot blow the per-turn debate prompt budget.
 */
function ongoingContextBlock(spec: ClarifiedSpec, cap = 4000): string {
  const ctx = spec.parentContext?.trim();
  if (!ctx) return "";
  const body = ctx.length > cap ? `${ctx.slice(0, cap)}\n…(earlier context truncated)` : ctx;
  return (
    `\n## Ongoing Task Context\n` +
    `You are mid-way through a larger task — this debate continues that work; it does not restart it. ` +
    `Treat every decision recorded below as settled input: build directly on it, and make your arguments advance the parent task from where it stands now. ` +
    `Do not reopen settled decisions, do not propose starting over, and do not wander onto any problem other than the one this step serves.\n` +
    `${body}\n\n---\n\n`
  );
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
  const stackLock = buildStackLockSection(ctx.spec);
  return {
    system:
      `You are the "${me.label}", and you own that chair. Your lens: ${me.lens}. ` +
      `Speak like someone who has watched this exact class of problem fail before — not like a document.\n` +
      `You are entering a discussion with the "${them.label}" (${them.lens}). ` +
      `They are sharp and they will push back; a claim you cannot defend is a claim you should not open with.\n` +
      focusLine +
      ENGLISH_ONLY_RULE +
      EVIDENCE_RULE_OPENING +
      concisenessRule(220) +
      (stackLock ? `\n${stackLock}\n` : "") +
      guardrails +
      (ctx.conversationContext ? `\n## Conversation Context\n${ctx.conversationContext}\n\n---\n\n` : "\n") +
      `## Discussion Brief\n` +
      `Problem: ${ctx.spec.problemStatement}\n` +
      `Constraints: ${ctx.spec.constraints.join("; ")}\n` +
      `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n` +
      `Scope: ${ctx.spec.scope}\n\n` +
      `Deliver your opening analysis in your own voice. Take the success criteria one by one: say plainly ` +
      `which are easy, which are hard, and where — from your seat — the bodies are buried. ` +
      `Close by putting one pointed question to the "${them.label}": the question you most need answered before you would sign off.`,
    prompt: `Open the debate from your stated lens. Stake out a real position — a stance nobody could disagree with is not a stance. Be specific and evidence-based, and do not drift into another role's perspective; your value here is depth, not coverage.`,
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
  const stackLock = buildStackLockSection(ctx.spec);
  return {
    system:
      `You are the "${me.label}" (lens: ${me.lens}) responding to the "${them.label}" (lens: ${them.lens}). ` +
      `This is a working session between peers — candid, specific, zero diplomacy theater.\n` +
      ENGLISH_ONLY_RULE +
      EVIDENCE_RULE_RESPONSE +
      concisenessRule(160) +
      (stackLock ? `\n${stackLock}\n` : "") +
      `\n## Discussion Brief\n` +
      `Problem: ${ctx.spec.problemStatement}\n` +
      `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n\n` +
      ongoingContextBlock(ctx.spec) +
      `React the way a good colleague does:\n` +
      `- Where they are right, concede fast — one line — then build their point somewhere they did not take it\n` +
      `- Where they are wrong, say so plainly and name the exact assumption that breaks\n` +
      `- Name the blind spot: the thing your lens sees that theirs structurally cannot\n\n` +
      `End by pressing them with one sharp question — aimed at the weakest joint in their argument.\n\n` +
      `Do NOT include round numbers (e.g. "Round N", "Round 2 Response", "Reply #3") ` +
      `or any numeric counter referring to the discussion round in your output. ` +
      `The orchestrator already prints round headers above your response.`,
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
  const stackLock = buildStackLockSection(ctx.spec);
  return {
    system:
      `You are the "${me.label}" (lens: ${me.lens}) continuing a discussion (round ${ctx.round}) with the "${them.label}" (lens: ${them.lens}). ` +
      `The easy points are settled; what remains is the hard residue — spend your words only there.\n` +
      ENGLISH_ONLY_RULE +
      EVIDENCE_RULE_FOLLOWUP +
      concisenessRule(140) +
      (stackLock ? `\n${stackLock}\n` : "") +
      `\n` +
      ongoingContextBlock(ctx.spec) +
      (ctx.runningSummary
        ? `## Discussion State So Far\n${ctx.runningSummary}\n\nFocus on UNRESOLVED points only. Restating agreed positions is dead weight — the summary above already holds them.\n\n`
        : "") +
      `## Success Criteria (what we need to resolve)\n` +
      ctx.spec.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\n` +
      `Read their latest response like a peer, not a debater scoring points. Then:\n` +
      `- If they landed a real hit, say so and update — changing your mind on evidence is strength, not defeat\n` +
      `- If you still disagree, do not repeat yourself louder; bring NEW evidence or attack from an angle you have not used\n` +
      `- If you have genuinely converged, declare it in one sentence and stop arguing\n\n` +
      `Stay in your lane — your lens, not theirs. ` +
      `Be concise. End with: do you agree on where we've landed?\n\n` +
      `Do NOT include round numbers (e.g. "Round N", "Response Round 2", "Round 4") ` +
      `or any numeric counter referring to the discussion round in your output. ` +
      `The orchestrator already prints round headers above your response.`,
    prompt:
      (ctx.speakerLastPosition ? `Your previous position:\n${ctx.speakerLastPosition}\n\n` : "") +
      `Their latest (${them.label}):\n${ctx.partnerPosition}`,
  };
}

// ── Leader evaluation prompt (replaces convergence-check) ────────────────────

export function buildLeaderEvaluationPrompt(ctx: { spec: ClarifiedSpec; exchangeLogs: string; round: number }): {
  system: string;
  prompt: string;
} {
  const stackLock = buildStackLockSection(ctx.spec);
  const outOfStackCheck = stackLock
    ? `\n## Out-of-stack enforcement\n` +
      `Scan the final positions for proposals that cite frameworks or technologies NOT in the STACK LOCK above.\n` +
      `If any participant's final position cites an out-of-stack technology (e.g. Next.js, shadcn, NestJS), ` +
      `set "outOfStackViolations" to the list of offending tech names and set "consensusQuality" to "partial". ` +
      `When all positions stay within the locked stack, set "consensusQuality" to "full".\n\n`
    : "";
  return {
    system:
      `You are the discussion moderator evaluating whether a multi-expert debate has produced sufficient results.\n` +
      ENGLISH_ONLY_RULE +
      (stackLock ? `\n${stackLock}\n` : "") +
      `\n## Success Criteria to Evaluate\n` +
      ctx.spec.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\n` +
      ongoingContextBlock(ctx.spec) +
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
      outOfStackCheck +
      `Output ONLY a JSON object (no markdown):\n` +
      `{\n` +
      `  "allCriteriaMet": true/false,\n` +
      `  "criteriaStatus": [{"criterion": "...", "met": true/false, "evidence": "..."}],\n` +
      `  "unresolvedPoints": ["point 1"],\n` +
      `  "needsResearch": false,\n` +
      `  "researchQuery": null,\n` +
      `  "shouldContinue": true/false,\n` +
      `  "reason": "one sentence explaining your decision",\n` +
      `  "extendRounds": 0  // set to 1-3 ONLY when one critical point is genuinely close to resolving but not yet there; 0 otherwise. The orchestrator applies this only if rounds remain — do not try to track the round count yourself.\n` +
      (stackLock
        ? `  ,\n  "consensusQuality": "full",  // "full" when all positions stay within locked stack; "partial" when out-of-stack violations found\n` +
          `  "outOfStackViolations": []  // list of out-of-stack tech names cited by participants (empty when none)\n`
        : "") +
      `}`,
    prompt: `## Debate (Round ${ctx.round})\n${ctx.exchangeLogs}`,
  };
}

// ── Round summary ────────────────────────────────────────────────────────────

export function buildRoundSummaryPrompt(
  allExchanges: string,
  topic: string,
  round: number,
): {
  system: string;
  prompt: string;
} {
  return {
    system:
      `Summarize this discussion in 3-5 bullet points.` +
      ENGLISH_ONLY_RULE +
      `\nYou are the debate's working memory — later turns see ONLY your bullets, so anything you drop is lost. Capture:\n` +
      `1. AGREED — points both sides now share\n` +
      `2. DISPUTED — live disagreements, with each side's strongest single argument (not their weakest)\n` +
      `3. NEW — evidence, verified facts, or angles that first surfaced this round\n` +
      `Be concise — one line per bullet. No preamble, no color commentary. ` +
      `Do NOT write "Round N" or any round-number counter in your bullets — this summary is fed into later turns, where round labels read as robotic noise. Refer to points by their content.`,
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
      `   **When \`outputShape.kind === "implementation_plan"\`, AT LEAST ONE stance MUST be a Product/User-side voice** — ` +
      `e.g. "Product Owner", "User Advocate", "Customer Proxy", "MVP Skeptic". Its lens MUST challenge scope: ` +
      `"what does the user actually need on day 1?", "what are we over-building?", "would the user pay for this if it shipped tomorrow?". ` +
      `This counter-balances engineering stances (Architect/Cost/Skeptic) that historically inflate scope ` +
      `(e.g. proposing multi-tenant SaaS for a 5-word "todo app" prompt). Engineering-only rosters are REJECTED.\n` +
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
      `  - entities: objectList of {name, fields, relationships} — the domain model. ` +
      `\`fields\` is a CSV of \`name:type[?]\` (e.g. "id:uuid, title:string, completed:bool, createdAt:timestamp"). ` +
      `\`relationships\` lists FK/nav properties (e.g. "userId → User(id)"). REQUIRED for any topic that involves persistence; ` +
      `omit only when the change is pure-refactor with zero schema impact.\n` +
      `  - endpoints: objectList of {method, path, request_body, response_body, auth_required} — the HTTP/RPC surface. ` +
      `Use concrete names (e.g. \`POST /todos\` not "create endpoint"). REQUIRED for any topic that exposes an API.\n` +
      `  - acceptance_criteria: list of Gherkin-style "Given X / When Y / Then Z" assertions OR ` +
      `concrete pass/fail predicates ("User can create a todo and see it in the list within 1s"). ` +
      `These are what the verify step uses to score Done. REQUIRED — at least 3.\n` +
      `  - tradeoffs: objectList of {decision, option_a, option_b, chosen, why}\n` +
      `  - risks: objectList of {description, severity: "High"|"Medium"|"Low", mitigation}\n` +
      `  - actionItems: objectList of {step, owner_lens, time_estimate, depends_on, acceptance_criteria}\n` +
      `  - dissenting_notes: list — minority opinions NOT to lose in synthesis (e.g. "X argued for B over A; if assumption Y fails, revisit")\n` +
      `  - mvp_definition: objectList of {feature, included_in_v1: "yes"|"no", reason} — ` +
      `EVERY major feature must appear here with an explicit v1-include decision and a one-line reason. ` +
      `This forces the council to make scope decisions instead of writing fluff like "lean MVP". ` +
      `Features marked "no" must still appear, with the deferral reason.\n` +
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
      `Examples: "cite sources for numbers", "do not propose code changes", "stay within YYYY constraint".\n` +
      `   For \`implementation_plan\` debates, ALWAYS include this scope-drift guardrail verbatim: ` +
      `"If any actionItem, entity, or endpoint requires multi-tenancy, enterprise auth-as-a-service, ` +
      `org/team hierarchy, or other enterprise infrastructure when the user's original prompt is < 25 words ` +
      `AND mentions none of those words explicitly, move it to \`dissenting_notes\` with reason 'scope inflation beyond user prompt'. ` +
      `Default to single-user / personal scope unless the prompt says otherwise." ` +
      `This counters the historical pattern where a 5-word prompt like 'tạo todo app' produced a multi-tenant SaaS plan.\n\n` +
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
      `## Scope\n${spec.scope || "(unspecified)"}` +
      ongoingContextBlock(spec),
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
  refineContext?: string; // User answers from post-debate refinement askcard
  planEmphasis?: boolean; // If true, instruct LLM to produce a concrete action plan
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

  const sectionLines = finalShape.sections.map((s) => `  "${s.key}": ${shapeHint(s)}, // ${s.prompt}`).join("\n");
  const headingLines = finalShape.sections.map((s) => `## ${s.heading}\n${renderHintFor(s)}`).join("\n");
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

  const stackLockForSynth = buildStackLockSection(ctx.spec);
  // De-robotize: for choice/plan outputs, force a single decisive recommendation
  // (mirrors the clarifier's mandatory-default rule). Scoped to decision/plan kinds
  // so evaluation/investigation/exploration shapes keep their neutral analytical tone.
  const decisiveness =
    finalShape.kind === "decision" || finalShape.kind === "implementation_plan"
      ? `\n## Decisiveness (recommendation/verdict)\n` +
        `Lead with the single choice you would make if the user said "you decide" — name it in the first sentence of the recommendation. ` +
        `Do NOT hedge with "it depends", "both have merits", or an unranked list of options; the user hired a panel to get a call, not a menu. ` +
        `If the debate genuinely did not converge, say so in one sentence and STILL give your best single recommendation plus the one condition that would change it.\n`
      : "";
  let system =
    `You are the team lead synthesizing a multi-specialist discussion. The panel has argued; now you rule. ` +
    `Work like an editor-in-chief: keep what survived scrutiny, cut what got refuted, credit the dissent worth keeping, ` +
    `and hand the user something they can act on without re-reading the debate.\n\n` +
    `## Original Brief\n` +
    `Problem: ${ctx.spec.problemStatement}\n` +
    `Constraints: ${ctx.spec.constraints.join("; ")}\n` +
    `Success Criteria: ${ctx.spec.successCriteria.join("; ")}\n` +
    ongoingContextBlock(ctx.spec) +
    intent +
    (stackLockForSynth ? `\n${stackLockForSynth}\n` : "") +
    guardrailBlock +
    decisiveness +
    `\nProduce the answer the user actually asked for — do NOT default to an implementation plan ` +
    `unless the output shape explicitly asks for actionItems/plan. ` +
    `Stay grounded in what was actually said in the debate: you may sharpen and arbitrate, but never invent facts ` +
    `the specialists did not raise, and mark unverified claims explicitly.\n\n` +
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
    sectionLines +
    "\n" +
    `}\n\n` +
    `**Part 2: Human-readable** — after \`---READABLE---\`, write in markdown with these headings (in this order):\n` +
    headingLines +
    `\n\nBe decisive but evidence-grounded — a verdict without evidence is noise; evidence without a verdict is homework handed back to the user.`;

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
 * When `hasUrl` is true, injects a mandatory instruction to use fetch_url (preferred
 * for content) or a browser tool (playwright/chrome when screenshots or heavy JS interaction
 * are required) before reporting Frontend Findings (CQ-04).
 *
 * Output format enforces 3 labelled sections with citation requirements (CQ-05).
 */
export function buildResearchSystemPrompt(hasUrl: boolean, internetFirst = false): string {
  const urlInstruction = hasUrl
    ? `\n## URL Research Requirement\n` +
      `This topic contains a URL. You MUST use the native fetch_url tool (preferred for most pages) ` +
      `or a browser tool (playwright/chrome-devtools when you need screenshots, rendered layout, or interaction) ` +
      `before reporting Frontend Findings. Do not skip this step.\n`
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
    `Each finding must cite [snapshot:uid] from a Playwright/Chrome-DevTools screenshot/inspection **if** a browser tool was used.\n` +
    `For ordinary pages, cite the result of fetch_url. If no URL inspection happened, write: _No live frontend inspection performed._\n\n` +
    `Do NOT speculate. Only report what you verified with tools.`
  );
}
