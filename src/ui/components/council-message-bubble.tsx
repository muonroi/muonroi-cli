import type { CouncilMessage } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { computeBubbleLayout } from "./bubble-layout.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import type { RoleStyle } from "./role-palette.js";

export interface CouncilMessageBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
  /** "left" | "right" — computed by usePairSideMap in container, NOT on the message */
  side: "left" | "right";
  /** Stable role → style resolver from useRolePalette */
  resolveStyle: (role: string) => RoleStyle;
  /** The partner's last rendered text (for reply-quote header). Omit for first turn. */
  partnerLastText?: string;
  /** Partner's role name for the reply-quote label */
  partnerRole?: string;
  theme: Theme;
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

function FlatDebateBubble({ msg, style, theme }: { msg: CouncilMessage; style: RoleStyle; theme: Theme }) {
  const header = buildHeader(msg, style);
  const footer = buildFooter(msg);
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={style.color} attributes={1}>
        {header}
      </text>
      <text fg={theme.text}>{msg.text.trim()}</text>
      <text fg={theme.textMuted}>{footer}</text>
    </box>
  );
}

export function CouncilMessageBubble({
  msg,
  terminalCols,
  side,
  resolveStyle,
  partnerLastText,
  partnerRole,
  theme,
}: CouncilMessageBubbleProps) {
  const layout = computeBubbleLayout(terminalCols);
  const style = resolveStyle(msg.speaker.role);

  if (layout.fallback) {
    return <FlatDebateBubble msg={msg} style={style} theme={theme} />;
  }

  const isRight = side === "right";
  const indent = isRight ? layout.rightIndent : 0;
  const header = buildHeader(msg, style);
  const footer = buildFooter(msg);
  const bodyText = truncateCodeBlocks(msg.text.trim());
  const roundLabel = msg.round !== undefined ? `Round ${msg.round} · ` : "";

  return (
    <box flexDirection="column" marginBottom={1}>
      {partnerLastText && partnerRole && (
        <box marginLeft={indent}>
          <text fg={theme.textMuted}>{buildQuoteLine(partnerLastText, partnerRole)}</text>
        </box>
      )}

      <box
        marginLeft={indent}
        width={layout.bubbleCols}
        borderStyle="single"
        borderColor={style.color}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={style.color} attributes={1}>
          {header}
        </text>
        <text fg={theme.text}>{bodyText}</text>
        <text fg={theme.textMuted}>{`${roundLabel}${footer}`}</text>
      </box>
    </box>
  );
}
