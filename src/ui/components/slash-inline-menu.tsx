import { Semantic } from "@muonroi/agent-harness-opentui";
import type { SlashMenuItem } from "../slash/menu-items.js";
import type { Theme } from "../theme.js";

const SLASH_MENU_MAX_VISIBLE = 8;

export function SlashInlineMenu({
  t,
  items,
  selectedIndex,
}: {
  t: Theme;
  items: SlashMenuItem[];
  selectedIndex: number;
}) {
  const visible = items.slice(0, SLASH_MENU_MAX_VISIBLE);

  if (visible.length === 0) {
    return (
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0} flexDirection="column">
        <box height={1} paddingLeft={1}>
          <text fg={t.textMuted}>{"No commands match"}</text>
        </box>
      </box>
    );
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0} flexDirection="column">
      {visible.map((item, i) => {
        const isSelected = i === selectedIndex;
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
              <text fg={isSelected ? t.selected : t.text}>
                {"/"}
                {item.label}
              </text>
              <text fg={t.textMuted}>{item.description}</text>
            </box>
          </Semantic>
        );
      })}
      {items.length > SLASH_MENU_MAX_VISIBLE && (
        <text fg={t.textDim}>{`  +${items.length - SLASH_MENU_MAX_VISIBLE} more`}</text>
      )}
    </box>
  );
}
