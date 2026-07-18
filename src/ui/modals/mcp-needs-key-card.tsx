import { Semantic } from "@muonroi/agent-harness-opentui";
import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import type React from "react";
import type { MissingKeyServer } from "../../mcp/key-requirements.js";
import type { NeedsKeyAction } from "../needs-key-controller.js";
import type { Theme } from "../theme.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

const TEXTAREA_KEYBINDINGS: KeyBinding[] = [{ name: "return", action: "submit" }];

export type NeedsKeyCardMode = "actions" | "input" | "validating";

/**
 * Inline "fix it here" card for an MCP server that is enabled but missing its
 * API key. Fully generalized on the MissingKeyServer descriptor — label,
 * envVar, setupHint, and nativeFallback all come from key-requirements, so a
 * future key-gated server renders correctly with zero UI changes.
 */
export function McpNeedsKeyCard({
  t,
  width,
  height,
  server,
  actions,
  selectedIndex,
  mode,
  inputRef,
  error,
  onSubmitKey,
}: {
  t: Theme;
  width: number;
  height: number;
  server: MissingKeyServer;
  actions: NeedsKeyAction[];
  selectedIndex: number;
  mode: NeedsKeyCardMode;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmitKey: () => void;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(76, width - 6);
  const inputMode = mode === "input" || mode === "validating";
  // header(1) + intro(2) + hint(1) + body + footer(3) + padding(2)
  const bodyHeight = inputMode ? 4 : actions.length;
  const panelHeight = Math.min(9 + bodyHeight, Math.floor(height * 0.8));
  const top = bottomAlignedModalTop(height, panelHeight);

  return (
    <Semantic id="mcp-needs-key-card" role="dialog" name={`${server.label} needs an API key`} isModal>
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
              <b>{`${server.label} needs an API key`}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.text}>
              {`${server.label} is enabled but ${server.envVar} is not set`}
              {server.nativeFallback ? ` — the built-in ${server.nativeFallback} covers it meanwhile.` : "."}
            </text>
            <text fg={t.textMuted}>{server.setupHint}</text>
          </box>
          {inputMode ? (
            <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
              <text fg={t.textMuted}>{`Paste ${server.envVar}:`}</text>
              <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
                <Semantic id="mcp-needs-key-input" role="textbox" name={server.envVar} focus={mode === "input" || undefined}>
                  <textarea
                    ref={inputRef}
                    focused={mode === "input"}
                    placeholder="paste key…"
                    textColor={t.text}
                    backgroundColor={t.backgroundElement}
                    placeholderColor={t.textMuted}
                    minHeight={1}
                    maxHeight={2}
                    wrapMode="word"
                    keyBindings={TEXTAREA_KEYBINDINGS}
                    onSubmit={onSubmitKey as unknown as () => void}
                  />
                </Semantic>
              </box>
            </box>
          ) : (
            <Semantic id="mcp-needs-key-actions" role="listbox">
              <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
                {actions.map((action, idx) => {
                  const selected = idx === selectedIndex;
                  return (
                    <Semantic
                      key={action.id}
                      id={`mcp-needs-key-action-${action.id}`}
                      role="listitem"
                      name={action.label}
                      selected={selected || undefined}
                    >
                      <box backgroundColor={selected ? t.selectedBg : undefined} paddingLeft={1} paddingRight={1}>
                        <text fg={selected ? t.selected : t.text}>
                          {selected ? "› " : "  "}
                          {action.label}
                        </text>
                      </box>
                    </Semantic>
                  );
                })}
              </box>
            </Semantic>
          )}
          <box flexGrow={1} minHeight={0} />
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            {mode === "validating" ? (
              <text fg={t.textMuted}>{"Validating key…"}</text>
            ) : error ? (
              <text fg={t.diffRemovedFg}>{error}</text>
            ) : inputMode ? (
              <text>
                <span style={{ fg: t.primary }}>{"enter "}</span>
                <span style={{ fg: t.textMuted }}>{"validate & save  ·  "}</span>
                <span style={{ fg: t.primary }}>{"esc "}</span>
                <span style={{ fg: t.textMuted }}>{"back"}</span>
              </text>
            ) : (
              <text>
                <span style={{ fg: t.primary }}>{"↑↓ "}</span>
                <span style={{ fg: t.textMuted }}>{"choose  ·  "}</span>
                <span style={{ fg: t.primary }}>{"enter "}</span>
                <span style={{ fg: t.textMuted }}>{"select  ·  "}</span>
                <span style={{ fg: t.primary }}>{"esc "}</span>
                <span style={{ fg: t.textMuted }}>{"snooze"}</span>
              </text>
            )}
          </box>
        </box>
      </box>
    </Semantic>
  );
}
