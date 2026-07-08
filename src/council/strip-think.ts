/**
 * Strip inline chain-of-thought markup from council LLM output.
 *
 * Some providers (kimi-k2.7 via opencode-go, GLM thinking variants) emit
 * reasoning inline as `<think>…</think>` in `result.text` instead of the AI
 * SDK's separated `reasoningText`. Rendered verbatim, the user sees hundreds
 * of words of internal drafting above every debate turn (live-verified
 * 2026-07-06). Applied at the council LLM boundary (src/council/llm.ts) so
 * every consumer — debate turns, leader evals, synthesis — is covered.
 *
 * Handles three shapes:
 *   - complete `<think>…</think>` blocks anywhere (global, case-insensitive)
 *   - an unclosed trailing `<think>…` block (output truncated mid-reasoning)
 *   - a stray leading `…</think>` (model omitted the opener; everything up to
 *     and including the close tag is reasoning)
 */
export function stripThinkBlocks(text: string): string {
  if (!text || !/<\/?think>/i.test(text)) return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Stray close tag with no opener before it → everything before it is reasoning.
  const closeIdx = out.search(/<\/think>/i);
  if (closeIdx !== -1) {
    out = out.slice(closeIdx).replace(/^<\/think>/i, "");
  }
  // Unclosed opener → everything after it is reasoning that got truncated.
  const openIdx = out.search(/<think>/i);
  if (openIdx !== -1) {
    out = out.slice(0, openIdx);
  }
  return out.trim();
}
