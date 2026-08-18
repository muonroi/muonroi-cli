import type { CouncilMessage } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { capBubbleBody, clampBubbleLines, DEFAULT_BUBBLE_BODY_LINES } from "./bubble-body-guard.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import type { RoleStyle } from "./role-palette.js";

export interface CouncilMessageBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
  /**
   * Legacy left/right pairing hint. The debate now renders as a single linear
   * group-chat stream (WhatsApp-style), so this is ignored — kept only for
   * call-site/back-compat. Do not reintroduce side-based alignment.
   */
  side: "left" | "right";
  /** Stable role → style resolver from useRolePalette */
  resolveStyle: (role: string) => RoleStyle;
  /** The partner's last rendered text (for reply-quote header). Omit for first turn. */
  partnerLastText?: string;
  /** Partner's role name for the reply-quote label */
  partnerRole?: string;
  theme: Theme;
  /**
   * True when this turn's body is shown in full. Collapsed turns clamp to
   * {@link DEFAULT_BUBBLE_BODY_LINES} and surface an expand affordance instead
   * of trimming silently. Ctrl+O (expand-all) also drives this.
   */
  expanded?: boolean;
  /** Click / Ctrl+↵ handler for the expand affordance. Omit to render it inert. */
  onToggleExpand?: () => void;
  /**
   * True when this speaker holds an unresolved objection on some success
   * criterion (a `-` stance). Marks the turn `◐ contested` so a scan of the
   * transcript shows WHERE the disagreement actually lives, not just that the
   * round is unmet.
   */
  contested?: boolean;
}

const MAX_QUOTE_CHARS = 80;

export function buildFooter(msg: CouncilMessage): string {
  const wordCount = msg.text.trim().split(/\s+/).filter(Boolean).length;
  const parts: string[] = [`${wordCount} words`];
  if (msg.partner) parts.push(`→ ${msg.partner.role}`);
  if (msg.toolCalls?.length) {
    parts.push(`tools: ${msg.toolCalls.map((t) => t.name).join(", ")}`);
  }
  if (msg.attempts && msg.attempts > 1) {
    parts.push("recovered on retry");
  }
  return parts.join(" · ");
}

export function buildHeader(msg: CouncilMessage, style: RoleStyle): string {
  const prefix = msg.kind === "research" ? "🔍 " : `${style.sigil} `;
  return `${prefix}${msg.speaker.role} · ${msg.speaker.model}`;
}

export function buildQuoteLine(partnerLastText: string, partnerRole: string): string {
  const flat = partnerLastText.replace(/\n/g, " ").trim();
  const excerpt = flat.slice(0, MAX_QUOTE_CHARS);
  const ellipsis = flat.length > MAX_QUOTE_CHARS ? "…" : "";
  return `↪ ${partnerRole}: "${excerpt}${ellipsis}"`;
}

/**
 * Linear group-chat message row. Every speaker renders the same way — a
 * role-colored left bar + a bold role-colored header (`● Role · model`), the
 * body, and a muted footer — appended in chronological order like a WhatsApp
 * group chat. No left/right/bubble alignment: the reader follows one downward
 * stream instead of a two-column ping-pong. The role color (from the shared
 * palette) is the sole visual identity per speaker, so a long debate stays
 * easy to track.
 */
export function CouncilMessageBubble({
  msg,
  terminalCols,
  resolveStyle,
  partnerLastText,
  partnerRole,
  theme,
  expanded = false,
  onToggleExpand,
  contested = false,
}: CouncilMessageBubbleProps) {
  const style = resolveStyle(msg.speaker.role);
  const header = buildHeader(msg, style);
  const footer = buildFooter(msg);
  // Guard the terminal wrapper against a pathological body (mega single-line /
  // 100KB+ blob) that hard-freezes the shared render+loop thread. See
  // bubble-body-guard.ts for the live root-cause trace.
  const capped = capBubbleBody(truncateCodeBlocks(msg.text.trim()), terminalCols);
  // Then clamp for READABILITY, reporting what was hidden so the cut becomes an
  // affordance rather than a silent trim. `expanded` disables the clamp.
  const { text: bodyText, hiddenLines } = clampBubbleLines(capped, expanded ? 0 : DEFAULT_BUBBLE_BODY_LINES);
  const roundLabel = msg.round !== undefined ? `Round ${msg.round} · ` : "";
  const showAffordance = hiddenLines > 0 || (expanded && msg.text.split("\n").length > DEFAULT_BUBBLE_BODY_LINES);

  return (
    <box flexDirection="column" marginBottom={1} border={["left"]} borderColor={style.color} paddingLeft={2}>
      {partnerLastText && partnerRole && (
        <text fg={theme.textMuted}>{buildQuoteLine(partnerLastText, partnerRole)}</text>
      )}
      <text fg={style.color} attributes={1}>
        {header}
      </text>
      <text fg={theme.text}>{bodyText}</text>
      {/* Expand affordance + contested marker, on their own line ABOVE the
          footer so the footer stays the turn's stable last line. */}
      {showAffordance || contested ? (
        // Click target for the expand affordance; Ctrl+↵ is its keyboard twin.
        <box flexDirection="row" onMouseDown={onToggleExpand}>
          {showAffordance ? (
            <text>
              <span style={{ fg: theme.accent }}>{expanded ? "▾ " : "▸ "}</span>
              <span style={{ fg: theme.accent }}>
                {expanded ? "collapse" : `${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}`}
              </span>
              <span style={{ fg: theme.textMuted }}>{" · click or ctrl+↵"}</span>
            </text>
          ) : null}
          {contested ? (
            <text fg={theme.councilContested}>{showAffordance ? "  ◐ contested" : "◐ contested"}</text>
          ) : null}
        </box>
      ) : null}
      <text fg={theme.textMuted}>{`${roundLabel}${footer}`}</text>
    </box>
  );
}
