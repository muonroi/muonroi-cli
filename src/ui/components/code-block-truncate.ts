/**
 * Truncates fenced code blocks that exceed maxLines.
 * Appends a dim footer line indicating how many lines were hidden.
 * Preserves fence language hint.
 *
 * Pure function — no side effects, safe to call in tests without Ink.
 */
export function truncateCodeBlocks(text: string, maxLines = 30): string {
  const FENCE_RE = /^(```[^\n]*)\n([\s\S]*?)^```/gm;

  return text.replace(FENCE_RE, (match, openFence: string, body: string) => {
    const bodyLines = body.split("\n");
    const contentLines = bodyLines.at(-1) === "" ? bodyLines.slice(0, -1) : bodyLines;

    if (contentLines.length <= maxLines) {
      return match;
    }

    const hidden = contentLines.length - maxLines;
    const kept = contentLines.slice(0, maxLines).join("\n");
    const footer = `… ${hidden} more line${hidden === 1 ? "" : "s"} — see /export for full source`;
    return `${openFence}\n${kept}\n\`\`\`\n${footer}`;
  });
}
