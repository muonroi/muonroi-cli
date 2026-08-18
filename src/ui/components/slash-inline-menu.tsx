import { Semantic } from "@muonroi/agent-harness-opentui";
import type { SlashMenuItem } from "../slash/menu-items.js";
import type { Theme } from "../theme.js";

const SLASH_MENU_MAX_VISIBLE = 8;

/**
 * Compute the scrolling viewport for the slash dropdown so the highlighted row
 * stays visible when the filtered list exceeds the window. Pure + exported so
 * the scroll behavior is unit-testable without a live TUI (the api-key modal
 * blocks a clean greenfield harness drive of the menu).
 */
export function computeSlashMenuWindow(
  total: number,
  selectedIndex: number,
  maxVisible: number = SLASH_MENU_MAX_VISIBLE,
): { start: number; end: number; hiddenAbove: number; hiddenBelow: number } {
  if (total <= 0) return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 };
  const clamped = Math.min(Math.max(0, selectedIndex), total - 1);
  const start = total <= maxVisible ? 0 : Math.min(Math.max(0, clamped - maxVisible + 1), total - maxVisible);
  const end = Math.min(start + maxVisible, total);
  return { start, end, hiddenAbove: start, hiddenBelow: total - end };
}

export function SlashInlineMenu({
  t,
  items,
  selectedIndex,
}: {
  t: Theme;
  items: SlashMenuItem[];
  selectedIndex: number;
}) {
  if (items.length === 0) {
    return (
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0} flexDirection="column">
        <box height={1} paddingLeft={1}>
          <text fg={t.textMuted}>{"No commands match"}</text>
        </box>
      </box>
    );
  }

  // Scrolling viewport: keep the highlighted row in view when the filtered list
  // exceeds the visible window. Without this the window was pinned to
  // items.slice(0,8) and pressing Down past index 7 moved the selection
  // off-screen — the list "wouldn't continue past the initial suggestions".
  const clampedSelected = Math.min(Math.max(0, selectedIndex), items.length - 1);
  const { start: windowStart, hiddenAbove, hiddenBelow } = computeSlashMenuWindow(items.length, clampedSelected);
  const visible = items.slice(windowStart, windowStart + SLASH_MENU_MAX_VISIBLE);

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0} flexDirection="column">
      {hiddenAbove > 0 && <text fg={t.textDim}>{`  ▲ ${hiddenAbove} more`}</text>}
      {visible.map((item, i) => {
        const absoluteIndex = windowStart + i;
        const isSelected = absoluteIndex === clampedSelected;
        return (
          <Semantic
            key={item.id}
            id={`slash-item-${item.id}`}
            role="listitem"
            name={`/${item.label}`}
            value={item.description}
            selected={isSelected ? true : undefined}
          >
            <box
              height={1}
              backgroundColor={isSelected ? t.selectedBg : undefined}
              flexDirection="row"
              justifyContent="space-between"
              paddingLeft={1}
              paddingRight={1}
            >
              {/* Label must NEVER shrink — a long description (e.g. /providers')
                  would otherwise squeeze the command name to zero width in this
                  space-between row, rendering just "/". flexShrink={0} pins the
                  label; the description takes the remaining space and truncates. */}
              <box flexShrink={0} flexDirection="row">
                <text fg={isSelected ? t.selected : t.text}>
                  {"/"}
                  {item.label}
                </text>
              </box>
              <box flexShrink={1} marginLeft={2} overflow="hidden">
                <text fg={t.textMuted}>{item.description}</text>
              </box>
            </box>
          </Semantic>
        );
      })}
      {hiddenBelow > 0 && <text fg={t.textDim}>{`  ▼ ${hiddenBelow} more`}</text>}
    </box>
  );
}
