import { Semantic } from "@muonroi/agent-harness-opentui";
import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import type React from "react";
import { EE_HOSTED_URL } from "../../ee/ee-connect.js";
import { EE_HOW_IT_WORKS_LINES, type EeConnectAction } from "../ee-connect-controller.js";
import type { Theme } from "../theme.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

const TEXTAREA_KEYBINDINGS: KeyBinding[] = [{ name: "return", action: "submit" }];

export type EeConnectCardMode = "actions" | "input" | "validating" | "how";

/**
 * Inline "connect the brain" card for an unconfigured Experience Engine.
 * Parallel to McpNeedsKeyCard (same modal-stack + key-precedence pattern) but
 * a separate component — EE onboarding and MCP key-repair must not couple.
 * The pasted token is never echoed: the textarea holds it transiently and the
 * success/failure copy carries only the probe detail.
 */
export function EeConnectCard({
  t,
  width,
  height,
  actions,
  selectedIndex,
  mode,
  inputRef,
  error,
  onSubmitToken,
}: {
  t: Theme;
  width: number;
  height: number;
  actions: EeConnectAction[];
  selectedIndex: number;
  mode: EeConnectCardMode;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmitToken: () => void;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(78, width - 6);
  const inputMode = mode === "input" || mode === "validating";
  // header(1) + intro(2) + body + footer + padding — mirrors mcp-needs-key-card sizing.
  const bodyHeight = mode === "how" ? EE_HOW_IT_WORKS_LINES.length : inputMode ? 4 : actions.length;
  const panelHeight = Math.min(9 + bodyHeight, Math.floor(height * 0.8));
  const top = bottomAlignedModalTop(height, panelHeight);
  const selectedHint = actions[selectedIndex]?.hint ?? "";

  return (
    <Semantic id="ee-connect-card" role="dialog" name="Connect the Experience Engine brain" isModal>
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
              <b>{"Connect the Experience Engine brain"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.text}>
              {"No brain is connected — the agent works without memory of past lessons and gotchas."}
            </text>
            {mode !== "how" && <text fg={t.textMuted}>{selectedHint}</text>}
          </box>
          {mode === "how" ? (
            <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
              {EE_HOW_IT_WORKS_LINES.map((line, i) => (
                <text key={`how-${i}`} fg={i === 0 ? t.text : t.textMuted}>
                  {line}
                </text>
              ))}
            </box>
          ) : inputMode ? (
            <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
              <text fg={t.textMuted}>{`Paste your auth token for ${EE_HOSTED_URL}:`}</text>
              <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
                <Semantic
                  id="ee-connect-input"
                  role="textbox"
                  name="EE auth token"
                  focus={mode === "input" || undefined}
                >
                  <textarea
                    ref={inputRef}
                    focused={mode === "input"}
                    placeholder="paste token…"
                    textColor={t.text}
                    backgroundColor={t.backgroundElement}
                    placeholderColor={t.textMuted}
                    minHeight={1}
                    maxHeight={2}
                    wrapMode="word"
                    keyBindings={TEXTAREA_KEYBINDINGS}
                    onSubmit={onSubmitToken as unknown as () => void}
                  />
                </Semantic>
              </box>
            </box>
          ) : (
            <Semantic id="ee-connect-actions" role="listbox">
              <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
                {actions.map((action, idx) => {
                  const selected = idx === selectedIndex;
                  return (
                    <Semantic
                      key={action.id}
                      id={`ee-connect-action-${action.id}`}
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
              <text fg={t.textMuted}>{"Checking the brain…"}</text>
            ) : error ? (
              <text fg={t.diffRemovedFg}>{error}</text>
            ) : mode === "how" ? (
              <text>
                <span style={{ fg: t.primary }}>{"esc "}</span>
                <span style={{ fg: t.textMuted }}>{"back"}</span>
              </text>
            ) : inputMode ? (
              <text>
                <span style={{ fg: t.primary }}>{"enter "}</span>
                <span style={{ fg: t.textMuted }}>{"validate & connect  ·  "}</span>
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
                <span style={{ fg: t.textMuted }}>{"not now"}</span>
              </text>
            )}
          </box>
        </box>
      </box>
    </Semantic>
  );
}
