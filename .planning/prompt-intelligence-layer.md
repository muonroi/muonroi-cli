# Prompt Intelligence Layer — Input Enrichment & Output Optimization (Hybrid Strategy)

**Design Document for muonroi-cli**  
**Version:** 1.0  
**Date:** April 30, 2026  
**Author:** muonroi + Grok

## 1. Why We Need This Layer (Problem Statement)

### Current Pain Points
- **Output tokens are 2–5× more expensive** than input tokens (e.g., Sonnet 4.6: $3/$15, Opus 4.7: $5/$25).
- Users often input raw, vague, or poorly structured prompts → models generate long, repetitive, unfocused responses.
- Manual prompt engineering is time-consuming and inconsistent.
- We are not fully leveraging **Experience Engine** (principles), **Who Am I** (personality), **GSD skills** (workflow discipline), and **Quick Codex** (context).

### Consequences
- Higher-than-necessary token costs.
- Inconsistent output quality.
- Poor user experience — users must become prompt engineers.
- The agent cannot reach its full potential for personalization and continuous learning.

**Core Goal:**  
Turn raw user ideas into high-quality prompts automatically, and force the model to return concise, structured, and actionable outputs.

## 2. Objectives of the Prompt Intelligence Layer

- Automatically **enrich input** before sending it to the LLM.
- Automatically **optimize output** by enforcing structured, low-token responses.
- Reduce **output token cost** by 60–80% compared to free-form text.
- Dramatically increase output quality and consistency.
- Fully utilize EE, Who Am I, GSD, and QC capabilities.

## 3. Hybrid Pipeline Architecture

The pipeline runs **inside the orchestrator**, immediately before the final prompt is sent to the chosen model:
User Raw Input
↓
[Layer 1] Input Analysis & Intent Detection          (Local heuristic + Ollama warm)
↓
[Layer 2] Personality & Style Adaptation             (Who Am I profile)
↓
[Layer 3] EE Experience & Principles Injection       (PreToolUse)
↓
[Layer 4] GSD Workflow Structuring                   (GSD templates)
↓
[Layer 5] Context Enrichment                         (.muonroi-flow/ + repo state)
↓
[Layer 6] Output Optimization & Safety Guard         (Tool Calling + Concise Rules)
↓
Final Optimized Prompt → 3-tier Router → Model

**Fail-open design:** If any layer fails or times out, the original prompt still proceeds.

## 4. Layer Details

### Layer 1: Input Analysis & Intent Detection
- Classifies task type (refactor, debug, plan, analyze, documentation…).
- Detects domain, urgency, and scope.
- Fast path: local regex + tree-sitter; fallback: Ollama.

### Layer 2: Personality & Style Adaptation (Who Am I v4.0)
- Adapts tone, brevity, reasoning style, and communication preferences based on the user’s personality profile.

### Layer 3: EE Experience Injection
- Automatically injects relevant principles, past lessons, and warnings via PreToolUse.

### Layer 4: GSD Workflow Structuring
- Forces structured thinking: discuss → plan → execute.
- Adds gray-area gates and evidence requirements.

### Layer 5: Context Enrichment
- Pulls relevant context from `.muonroi-flow/` artifacts, recent runs, and repository state.

### Layer 6: Output Optimization & Safety Guard (Most Critical)
- Enforces **Tool Calling** or **Minimal JSON** output.
- Adds strong instructions: “Be extremely concise. Use bullet points and code blocks. No filler words.”
- Applies safety guardrails (no hallucinations on critical paths, etc.).

## 5. Output Strategy — Tool Calling First

- **Default (80–90% of coding tasks):** Tool Calling (cheapest and most reliable).
- Model returns only structured JSON Tool Calls → CLI parses and renders beautiful text for the user.
- **Fallback:** Minimal JSON + local template / Ollama naturalization.

This approach typically reduces output tokens by **60–80%** compared to free-form text.

## 6. JSON → Natural Text Rendering (CLI Responsibility)

After receiving structured output:
- Quick local templates for speed.
- Ollama Naturalize (with user personality) for higher fluency when needed.
- Rich TUI rendering: diff previews, confirm buttons, bullet summaries, etc.

## 7. Expected Benefits & Cost Impact

- **Output token reduction:** 60–80%.
- **Overall session cost reduction:** 50–70% when combined with 3-tier router and deliberate compaction.
- **Higher consistency & quality** through principles and personality enforcement.
- **Much better UX** — users can type casually.

## 8. Implementation Plan

**Recommended Phase:** Insert as **Phase 1.5** (or integrate into late Phase 1).

- Create `src/prompt-intelligence/` module.
- Build the pipeline orchestrator.
- Add `/optimize` slash command for manual testing and debugging.
- Strong integration with existing Router and EE client.

---

### Review & Recommendations

**Overall Assessment:** This layer is one of the highest-ROI features we can add. It directly addresses cost, quality, and user experience — the three core differentiators of muonroi-cli. Strongly recommended to implement in **Phase 1.5** right after the 3-tier router stabilizes.  

**Suggested next step:** Start with Layer 1 + Layer 6 (Analysis + Output Optimization via Tool Calling), then expand to Personality and EE injection.

---

Bạn chỉ cần copy toàn bộ nội dung trên và lưu thành file `docs/prompt-intelligence-layer.md`.  

Nếu muốn chỉnh sửa thêm (thêm code skeleton, bảng so sánh, hoặc thay đổi nội dung), cứ nói nhé!