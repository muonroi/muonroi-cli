import React from "react";
import { Box, Text } from "ink";
import { computeBubbleLayout } from "./bubble-layout.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import type { CouncilMessage } from "../../types/index.js";
import type { RoleStyle } from "./role-palette.js";

export interface CouncilMessageBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
  side: "left" | "right";
  resolveStyle: (role: string) => RoleStyle;
  partnerLastText?: string;
  partnerRole?: string;
}

const MAX_QUOTE_CHARS = 80;

function buildFooter(msg: CouncilMessage): string {
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

function buildHeader(msg: CouncilMessage, style: RoleStyle): string {
  return `${style.sigil} ${msg.speaker.role} · ${msg.speaker.model}`;
}

function buildQuoteLine(partnerLastText: string, partnerRole: string): string {
  const flat = partnerLastText.replace(/\n/g, " ").trim();
  const excerpt = flat.slice(0, MAX_QUOTE_CHARS);
  const ellipsis = flat.length > MAX_QUOTE_CHARS ? "…" : "";
  return `↪ ${partnerRole}: "${excerpt}${ellipsis}"`;
}

function FlatDebateBubble({
  msg,
  style,
}: {
  msg: CouncilMessage;
  style: RoleStyle;
}): React.ReactElement {
  const header = buildHeader(msg, style);
  const footer = buildFooter(msg);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={style.color}>
        {header}
      </Text>
      <Text wrap="wrap">{msg.text.trim()}</Text>
      <Text dimColor>{footer}</Text>
    </Box>
  );
}

export function CouncilMessageBubble({
  msg,
  terminalCols,
  side,
  resolveStyle,
  partnerLastText,
  partnerRole,
}: CouncilMessageBubbleProps): React.ReactElement {
  const layout = computeBubbleLayout(terminalCols);
  const style = resolveStyle(msg.speaker.role);

  if (layout.fallback) {
    return <FlatDebateBubble msg={msg} style={style} />;
  }

  const isRight = side === "right";
  const indent = isRight ? layout.rightIndent : 0;
  const header = buildHeader(msg, style);
  const footer = buildFooter(msg);
  const bodyText = truncateCodeBlocks(msg.text.trim());
  const roundLabel = msg.round !== undefined ? `Round ${msg.round} · ` : "";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {partnerLastText && partnerRole && (
        <Box marginLeft={indent}>
          <Text dimColor>{buildQuoteLine(partnerLastText, partnerRole)}</Text>
        </Box>
      )}

      <Box
        marginLeft={indent}
        width={layout.bubbleCols}
        borderStyle="round"
        borderColor={style.color}
        flexDirection="column"
      >
        <Text bold color={style.color}>
          {header}
        </Text>
        <Text wrap="wrap">{bodyText}</Text>
        <Text dimColor>{`${roundLabel}${footer}`}</Text>
      </Box>
    </Box>
  );
}
