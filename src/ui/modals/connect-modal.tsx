import type { KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type React from "react";
import { useEffect, useRef } from "react";
import { Dialog } from "../primitives/index.js";
import type { Theme } from "../theme.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

const TEXTAREA_KEYBINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
];

export function ConnectModal({
  t,
  width,
  height,
  selectedIndex,
  channels,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  channels: { id: string; label: string; description: string }[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    const ch = channels[selectedIndex];
    if (ch) listRef.current?.scrollChildIntoView(`connect-${ch.id}`);
  }, [selectedIndex, channels]);

  const panelHeight = Math.min(channels.length + 9, Math.floor(height * 0.5));
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;
  return (
    <Dialog id="connect-modal" name="Connect">
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={top}
        backgroundColor={overlayBg}
      >
        <box
          width={Math.min(56, width - 6)}
          height={panelHeight}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
            <text fg={t.primary}>
              <b>{"Connect"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <text fg={t.textMuted}>{"Choose a channel"}</text>
          </box>
          <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
            {channels.map((ch, idx) => (
              <box
                key={ch.id}
                id={`connect-${ch.id}`}
                backgroundColor={idx === selectedIndex ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
              >
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={idx === selectedIndex ? t.selected : t.text}>{ch.label}</text>
                  <text fg={t.textMuted}>{ch.description}</text>
                </box>
              </box>
            ))}
          </scrollbox>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"select  ·  "}</span>
              <span style={{ fg: t.primary }}>{"↑↓ "}</span>
              <span style={{ fg: t.textMuted }}>{"navigate  ·  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"close"}</span>
            </text>
          </box>
        </box>
      </box>
    </Dialog>
  );
}

export function TelegramTokenModal({
  t,
  width,
  height,
  inputRef,
  error,
  onSubmit,
}: {
  t: Theme;
  width: number;
  height: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmit: () => void;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(68, width - 6);
  const panelHeight = 14;
  const top = bottomAlignedModalTop(height, panelHeight);

  return (
    <Dialog id="telegram-token-modal" name="Telegram bot token">
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={top}
        backgroundColor={overlayBg}
      >
        <box
          width={panelWidth}
          height={panelHeight}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
            <text fg={t.primary}>
              <b>{"Telegram bot token"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.text}>
              {"From @BotFather: /newbot, then paste the token here. Stored in ~/.muonroi-cli/user-settings.json."}
            </text>
          </box>
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
              <textarea
                ref={inputRef}
                focused={true}
                placeholder="123456:ABC..."
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={1}
                maxHeight={3}
                wrapMode="word"
                keyBindings={TEXTAREA_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
          <box flexGrow={1} minHeight={0} />
          <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
            {error ? (
              <text fg={t.diffRemovedFg}>{error}</text>
            ) : (
              <text>
                <span style={{ fg: t.primary }}>{"enter "}</span>
                <span style={{ fg: t.textMuted }}>{"save token  ·  "}</span>
                <span style={{ fg: t.primary }}>{"esc "}</span>
                <span style={{ fg: t.textMuted }}>{"close"}</span>
              </text>
            )}
          </box>
        </box>
      </box>
    </Dialog>
  );
}

export function TelegramPairModal({
  t,
  width,
  height,
  inputRef,
  error,
  onSubmit,
}: {
  t: Theme;
  width: number;
  height: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmit: () => void;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(68, width - 6);
  const panelHeight = 13;
  const top = bottomAlignedModalTop(height, panelHeight);

  return (
    <Dialog id="telegram-pair-modal" name="Pairing code">
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={top}
        backgroundColor={overlayBg}
      >
        <box
          width={panelWidth}
          height={panelHeight}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
            <text fg={t.primary}>
              <b>{"Pairing code"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.text}>{"DM your bot with /pair, then paste the 6-character code."}</text>
          </box>
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
              <textarea
                ref={inputRef}
                focused={true}
                placeholder="ABC123"
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={1}
                maxHeight={2}
                wrapMode="word"
                keyBindings={TEXTAREA_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
          <box flexGrow={1} minHeight={0} />
          <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
            {error ? (
              <text fg={t.diffRemovedFg}>{error}</text>
            ) : (
              <text>
                <span style={{ fg: t.primary }}>{"enter "}</span>
                <span style={{ fg: t.textMuted }}>{"approve pairing  ·  "}</span>
                <span style={{ fg: t.primary }}>{"esc "}</span>
                <span style={{ fg: t.textMuted }}>{"close"}</span>
              </text>
            )}
          </box>
        </box>
      </box>
    </Dialog>
  );
}
