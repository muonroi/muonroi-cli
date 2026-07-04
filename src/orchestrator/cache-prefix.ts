/**
 * Non-Claude prompt-cache prefix stability (Task 3).
 *
 * On non-Claude providers (DeepSeek / GLM / other OpenAI-compatible backends)
 * the whole system prompt is sent as a single string. Any per-turn-varying
 * content that sits AFTER the byte-stable `staticPrefix` but BEFORE the
 * conversation — the `dynamicSuffix` (plan / resume / cwd), the PIL output
 * suffix, and the live MCP capability roster — shifts the cached prefix and
 * forces a full cache miss on PIL-active turns. Measured: `pil_active=1` ⟺
 * `cache_read=0` on 12/12 calls (session `47a774d272da`).
 *
 * Fix (variant b): split the assembled system string at the END of
 * `staticPrefix`. The front stays as the `system` string; the dynamic tail is
 * relocated into the trailing user message (see `foldDynamicTailIntoUserMessage`)
 * rather than emitted as a mid-conversation system-role message, because
 * OpenAI-compatible providers do not reliably accept a non-leading system role.
 *
 * IMPORTANT fast-tier caveat: for fast-tier models the cheap-model workbook /
 * playbook / shell directive are front-loaded BEFORE `staticPrefix` for primacy,
 * and the workbook's task addendum covaries with `taskType` (== `pil_active`).
 * That portion still shifts the prefix and is a deliberate primacy design, so
 * this split does NOT relocate it — the front is fully byte-stable only for
 * non-fast-tier non-Claude models (the expensive-model path, which is where the
 * cache payoff is per the plan). See task-3-report.md for the residual analysis.
 *
 * The Claude path keeps its own two-block cache split upstream and MUST NOT be
 * routed through this helper.
 */

export interface FrontTailSplit {
  /** The byte-stable front to send as the `system` string. */
  front: string;
  /** The per-turn-dynamic tail to relocate into the trailing user message. */
  dynamicTail: string;
}

/**
 * Split an assembled non-Claude system string into a byte-stable front and a
 * per-turn-dynamic tail, cutting at the end of `staticPrefix`.
 *
 * Uses the established provider-family detection (`modelId.startsWith("claude")`)
 * so the Claude branch is a no-op guard. If `staticPrefix` cannot be located in
 * `systemWithCaps` (unexpected), returns the whole string as `front` with an
 * empty tail so no instruction content is ever dropped.
 */
export function splitFrontAndDynamicTail(params: {
  modelId: string;
  systemWithCaps: string;
  staticPrefix: string;
}): FrontTailSplit {
  const { modelId, systemWithCaps, staticPrefix } = params;
  // Claude is handled by its own two-block ephemeral-cache split — never here.
  if (modelId.startsWith("claude") || staticPrefix.length === 0) {
    return { front: systemWithCaps, dynamicTail: "" };
  }
  const anchor = systemWithCaps.indexOf(staticPrefix);
  if (anchor < 0) {
    // staticPrefix not found — do not risk relocating (and possibly dropping)
    // content we cannot precisely locate. Keep the original single string.
    return { front: systemWithCaps, dynamicTail: "" };
  }
  const splitAt = anchor + staticPrefix.length;
  return {
    front: systemWithCaps.slice(0, splitAt),
    dynamicTail: systemWithCaps.slice(splitAt),
  };
}

/**
 * `assembleFrontSystem` — thin convenience wrapper returning only the byte-stable
 * front (the value sent as the `system` string). Named to match the plan's
 * invariant-test contract.
 */
export function assembleFrontSystem(params: { modelId: string; systemWithCaps: string; staticPrefix: string }): string {
  return splitFrontAndDynamicTail(params).front;
}

/**
 * Fold a relocated dynamic tail into a user message's content. Handles both
 * string content and structured (array-of-parts) content. Returns the message
 * unchanged when the tail is empty. Never mutates the input.
 */
export function foldDynamicTailIntoUserMessage<T extends { role: unknown; content: unknown }>(
  msg: T,
  dynamicTail: string,
): T {
  if (dynamicTail.trim().length === 0) return msg;
  const block = `\n\n---\n[Session context — working directory, task guidance, and available tools]\n${dynamicTail.trim()}`;
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") {
    return { ...msg, content: `${content}${block}` };
  }
  if (Array.isArray(content)) {
    return { ...msg, content: [...content, { type: "text", text: block }] } as unknown as T;
  }
  // Unknown content shape — do not risk corrupting it; leave unchanged.
  return msg;
}
