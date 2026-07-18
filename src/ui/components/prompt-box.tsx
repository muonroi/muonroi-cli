import type { KeyBinding, PasteEvent, TextareaRenderable } from "@opentui/core";
import { useEffect, useState } from "react";
import type { getModelInfo } from "../../models/registry.js";
import type { MODES } from "../../types/index.js";
import { PROMPT_LOADING_FRAMES } from "../constants.js";
import type { TypeaheadState } from "../hooks/useTypeahead.js";
import { Menu, TextBox } from "../primitives/index.js";
import type { SlashMenuItem } from "../slash/menu-items.js";
import type { Theme } from "../theme.js";
import type { ContextStats } from "../types.js";
import { withAlpha } from "../utils/color.js";
import { SuggestionOverlay } from "./SuggestionOverlay.js";
import { ContextMeter } from "./session-header.js";
import { SlashInlineMenu } from "./slash-inline-menu.js";

export const TEXTAREA_KEYBINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
];

export function promptLoadingCellGlyph(index: number, active: number, forward: boolean): string {
  const distance = forward ? active - index : index - active;
  return distance >= 0 && distance < 2 ? "■" : "⬝";
}

export function promptLoadingCellColor(color: string, index: number, active: number, forward: boolean): string {
  const distance = forward ? active - index : index - active;
  if (distance === 0) return color;
  if (distance === 1) return withAlpha(color, 0.72);
  return withAlpha(color, 0.22);
}

export function PromptLoadingBoxes({ t: _t, color }: { t: Theme; color: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % PROMPT_LOADING_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);

  const step = PROMPT_LOADING_FRAMES[frame] ?? PROMPT_LOADING_FRAMES[0];

  return (
    <text>
      {[0, 1, 2].map((idx) => (
        <span key={idx} style={{ fg: promptLoadingCellColor(color, idx, step.active, step.forward) }}>
          {promptLoadingCellGlyph(idx, step.active, step.forward)}
        </span>
      ))}
    </text>
  );
}

export function PromptModeLabel({
  t,
  modeInfo,
  isProcessing,
}: {
  t: Theme;
  modeInfo: (typeof MODES)[number];
  isProcessing: boolean;
}) {
  if (!isProcessing) {
    return (
      <text fg={modeInfo.color}>
        <b>{modeInfo.label}</b>
      </text>
    );
  }

  return <PromptLoadingBoxes t={t} color={modeInfo.color} />;
}

export function PromptBox({
  t,
  inputRef,
  isProcessing,
  showModelPicker,
  showSandboxPicker,
  showWalletPicker,
  showSlashMenu,
  showPlanQuestions,
  showApiKeyModal,
  blockPrompt,
  onSubmit,
  onPaste,
  pasteBlocks: _pasteBlocks,
  modeInfo,
  model,
  modelInfo,
  contextStats,
  placeholder,
  queuedCount,
  queuedMessages,
  typeahead,
  slashItems,
  slashSelectedIndex,
  slashInputIsMatched,
  composerValue,
}: {
  t: Theme;
  inputRef: React.RefObject<TextareaRenderable | null>;
  isProcessing: boolean;
  showModelPicker: boolean;
  showSandboxPicker: boolean;
  showWalletPicker: boolean;
  showSlashMenu: boolean;
  showPlanQuestions: boolean;
  showApiKeyModal: boolean;
  blockPrompt?: boolean;
  onSubmit: () => void;
  onPaste: (event: PasteEvent) => void;
  pasteBlocks: { id: number; content: string; lines: number }[];
  modeInfo: (typeof MODES)[number];
  model: string;
  modelInfo: ReturnType<typeof getModelInfo>;
  contextStats?: ContextStats | null;
  placeholder?: string;
  queuedCount?: number;
  queuedMessages?: string[];
  typeahead?: TypeaheadState;
  slashItems?: SlashMenuItem[];
  slashSelectedIndex?: number;
  slashInputIsMatched?: boolean;
  composerValue?: string;
}) {
  const hasQueue = (queuedMessages?.length ?? 0) > 0;
  const showSuggestions = typeahead?.visible ?? false;
  // Single source of truth for composer focus — mirrored to BOTH the OpenTUI
  // textarea (`focused`) and the semantic node (via TextBox `focused`). Keeping
  // one expression avoids the two drifting apart (the harness would otherwise
  // report a focus state that disagrees with what the textarea actually has).
  const composerFocused =
    !showModelPicker &&
    !showSandboxPicker &&
    !showWalletPicker &&
    !showPlanQuestions &&
    !showApiKeyModal &&
    !blockPrompt;

  return (
    <box backgroundColor={t.backgroundPanel}>
      <box>
        {hasQueue && (
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={t.queueBg}
            flexShrink={0}
          >
            {queuedMessages!.map((msg, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only queue of plain strings
              <text key={i} fg={t.text}>
                {"→ "}
                {msg}
              </text>
            ))}
            <box height={1} />
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"send now"}</span>
              <span style={{ fg: t.textDim }}>{" · "}</span>
              <span style={{ fg: t.primary }}>{"↑ "}</span>
              <span style={{ fg: t.textMuted }}>{"edit"}</span>
              <span style={{ fg: t.textDim }}>{" · "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"cancel"}</span>
            </text>
          </box>
        )}
        {showSlashMenu && slashItems && (
          <Menu id="slash-menu" name="Slash commands">
            <SlashInlineMenu t={t} items={slashItems} selectedIndex={slashSelectedIndex ?? 0} />
          </Menu>
        )}
        {showSuggestions && typeahead && (
          <SuggestionOverlay t={t} suggestions={typeahead.suggestions} selectedIndex={typeahead.selectedIndex} />
        )}
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={t.backgroundElement}
          flexDirection="row"
          gap={2}
          alignItems="flex-start"
          flexShrink={0}
        >
          <PromptModeLabel t={t} modeInfo={modeInfo} isProcessing={isProcessing} />
          <box flexGrow={1}>
            <TextBox
              id="composer"
              // Mirror current composer text so external harness drivers
              // can read back what the user typed. Prefer the textarea's
              // actual plainText (ground truth) over composerValue (derived
              // from slashSearchQuery). This makes post-Tab state visible
              // even while the slash menu is technically still open — was
              // hiding the trailing space inserted by Tab autocomplete.
              value={inputRef.current?.plainText ?? composerValue ?? ""}
              focused={composerFocused}
            >
              <textarea
                ref={inputRef}
                focused={composerFocused}
                placeholder={
                  isProcessing ? "Queue a follow-up... (esc to interrupt)" : placeholder || "Message muonroi-cli..."
                }
                // Set BOTH textColor and focusedTextColor: the OpenTUI textarea
                // renders typed text with focusedTextColor while it holds focus
                // (which the composer effectively always does), and textColor
                // only when blurred — so highlighting the recognized command
                // requires the focused variant, not textColor alone.
                textColor={slashInputIsMatched ? t.composerCommand : t.text}
                focusedTextColor={slashInputIsMatched ? t.composerCommand : t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={1}
                maxHeight={10}
                wrapMode="word"
                keyBindings={TEXTAREA_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
                onPaste={onPaste as unknown as (event: PasteEvent) => void}
              />
            </TextBox>
          </box>
        </box>
      </box>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={2}
        paddingRight={2}
        height={1}
        flexShrink={0}
      >
        <box flexDirection="row" gap={1} alignItems="center" height={1}>
          <text fg={t.text}>{modelInfo?.name || model}</text>
          {contextStats ? <ContextMeter t={t} stats={contextStats} /> : null}
        </box>
        <box flexDirection="row" gap={1} alignItems="center" height={1}>
          {isProcessing ? (
            <box flexDirection="row" gap={1}>
              <text fg={t.text}>
                {"enter "}
                <span style={{ fg: t.textMuted }}>{"queue"}</span>
              </text>
              <text fg={t.text}>
                {"esc "}
                <span style={{ fg: t.textMuted }}>{(queuedCount ?? 0) > 0 ? "clear queue" : "interrupt"}</span>
              </text>
            </box>
          ) : showSlashMenu ? (
            <box flexDirection="row" gap={1}>
              <text fg={t.text}>
                {"↑↓ "}
                <span style={{ fg: t.textMuted }}>{"navigate"}</span>
              </text>
              <text fg={t.text}>
                {"enter "}
                <span style={{ fg: t.textMuted }}>{"select"}</span>
              </text>
              <text fg={t.text}>
                {"esc "}
                <span style={{ fg: t.textMuted }}>{"dismiss"}</span>
              </text>
            </box>
          ) : showSuggestions ? (
            <box flexDirection="row" gap={1}>
              <text fg={t.text}>
                {"tab "}
                <span style={{ fg: t.textMuted }}>{"accept"}</span>
              </text>
              <text fg={t.text}>
                {"↑↓ "}
                <span style={{ fg: t.textMuted }}>{"navigate"}</span>
              </text>
              <text fg={t.text}>
                {"esc "}
                <span style={{ fg: t.textMuted }}>{"dismiss"}</span>
              </text>
            </box>
          ) : (
            // Wrap in a gap'd row like the other three hint branches — a bare
            // fragment let the three hints run together ("@ filesshift+enter new
            // linetab modes"); the inner box restores the 1-col separators.
            <box flexDirection="row" gap={1}>
              <text fg={t.text}>
                {"@ "}
                <span style={{ fg: t.textMuted }}>{"files"}</span>
              </text>
              <text fg={t.text}>
                {"shift+enter "}
                <span style={{ fg: t.textMuted }}>{"new line"}</span>
              </text>
              <text fg={t.text}>
                {"tab "}
                <span style={{ fg: t.textMuted }}>{"modes"}</span>
              </text>
            </box>
          )}
        </box>
      </box>
    </box>
  );
}
