import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { getEffectiveReasoningEffort, getSupportedReasoningEfforts, normalizeModelId } from "../../models/registry.js";
import type { ProviderId } from "../../providers/types.js";
import type { ModelInfo, ReasoningEffort } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

// ── Tier grouping helpers ─────────────────────────────────────────────────────

const TIER_ORDER_MAP: Record<string, number> = { premium: 0, balanced: 1, fast: 2 };
const TIER_BADGE: Record<string, string> = { premium: "[prem]", balanced: "[bal]", fast: "[fast]" };

export function sortModelsByTier(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const ta = TIER_ORDER_MAP[a.tier ?? ""] ?? 3;
    const tb = TIER_ORDER_MAP[b.tier ?? ""] ?? 3;
    return ta - tb;
  });
}

export type TierGroup = { tier: string; items: ModelInfo[] };

export function groupModelsByTier(models: ModelInfo[]): TierGroup[] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const tier = m.tier ?? "other";
    const list = map.get(tier) ?? [];
    list.push(m);
    map.set(tier, list);
  }
  const order = ["premium", "balanced", "fast", "other"];
  return order.filter((t) => map.has(t)).map((t) => ({ tier: t, items: map.get(t)! }));
}

export function ModelPickerModal({
  t,
  currentModel,
  selectedIndex,
  width,
  height,
  searchQuery,
  filteredModels,
  reasoningEffortByModel,
  configuredProviders,
  disabledProviders,
  disabledModels,
  focus,
  providerChipIndex,
}: {
  t: Theme;
  currentModel: string;
  selectedIndex: number;
  width: number;
  height: number;
  searchQuery: string;
  filteredModels: ModelInfo[];
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  configuredProviders: ProviderId[];
  disabledProviders: ProviderId[];
  disabledModels: string[];
  focus: "models" | "providers";
  providerChipIndex: number;
}) {
  const disabledSet = new Set(disabledProviders);
  const disabledModelSet = new Set(disabledModels);
  const listRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    const m = filteredModels[selectedIndex];
    if (m) listRef.current?.scrollChildIntoView(`model-${m.id}`);
  }, [selectedIndex, filteredModels]);

  // Sort: enabled first, disabled to bottom within tier ordering
  const sortedModels = useMemo(() => {
    const enabledModels = filteredModels.filter(
      (m) => !disabledModelSet.has(m.id) && !(m.provider && disabledSet.has(m.provider as ProviderId)),
    );
    const disabledModelsList = filteredModels.filter(
      (m) => disabledModelSet.has(m.id) || (m.provider && disabledSet.has(m.provider as ProviderId)),
    );
    return [...sortModelsByTier(enabledModels), ...sortModelsByTier(disabledModelsList)];
  }, [filteredModels, disabledModelSet, disabledSet]);

  const showGroups = sortedModels.length > 6;
  const tierGroups = showGroups ? groupModelsByTier(sortedModels) : null;

  const selectedModel = filteredModels[selectedIndex];
  const selectedSupportsReasoning = !!selectedModel && getSupportedReasoningEfforts(selectedModel.id).length > 0;

  const panelWidth = Math.min(64, width - 6);
  const maxNameWidth = panelWidth - 22;

  const itemCount = Math.max(sortedModels.length, 1);
  const headerCount = tierGroups ? tierGroups.length : 0;
  const contentHeight = itemCount + headerCount + 9;
  const maxH = Math.floor(height * 0.65);
  const panelHeight = Math.min(contentHeight, maxH);
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;

  const renderModelRow = (m: ModelInfo, idx: number) => {
    const selected = idx === selectedIndex;
    const current = m.id === currentModel;
    const modelDisabled = disabledModelSet.has(m.id) || (m.provider && disabledSet.has(m.provider as ProviderId));
    const supportedReasoningEfforts = getSupportedReasoningEfforts(m.id);
    const reasoningEffort = getEffectiveReasoningEffort(m.id, reasoningEffortByModel[normalizeModelId(m.id)]) ?? "auto";

    const nameRaw = m.name ?? m.id;
    const truncatedName = nameRaw.length > maxNameWidth ? `${nameRaw.slice(0, maxNameWidth - 1)}…` : nameRaw;

    const enableMark = modelDisabled ? "✗" : "✓";
    const tierBadge = m.tier ? (TIER_BADGE[m.tier] ?? "") : "";
    const visionBadge = m.supportsVision ? " [V]" : "";
    const reasoningBadge = m.reasoning ? " [R]" : "";

    const nameFg = modelDisabled ? t.textMuted : current ? t.accent : selected ? t.selected : t.text;

    return (
      <Semantic
        key={m.id}
        id={`model-row-${m.id}`}
        role="listitem"
        selected={selected ? true : undefined}
        disabled={modelDisabled ? true : undefined}
        name={m.name ?? m.id}
      >
        <box
          id={`model-${m.id}`}
          backgroundColor={selected ? t.selectedBg : undefined}
          paddingLeft={1}
          paddingRight={1}
          width="100%"
        >
          <box width="100%" flexDirection="row">
            <text fg={modelDisabled ? t.textMuted : selected ? t.accent : t.textMuted}>{`${enableMark} `}</text>
            <text fg={nameFg}>{truncatedName.padEnd(Math.max(0, maxNameWidth))}</text>
            {tierBadge ? <text fg={selected ? t.primary : t.textDim}>{` ${tierBadge}`}</text> : null}
            {visionBadge ? <text fg={selected ? t.primary : t.textDim}>{visionBadge}</text> : null}
            {reasoningBadge ? <text fg={selected ? t.primary : t.textDim}>{reasoningBadge}</text> : null}
            {supportedReasoningEfforts.length > 0 ? (
              <text fg={selected ? t.primary : t.textMuted}>{` [${reasoningEffort}]`}</text>
            ) : null}
          </box>
        </box>
      </Semantic>
    );
  };

  return (
    <Semantic id="model-picker" role="dialog" isModal name="Select model">
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
              <b>{"Select model"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          {configuredProviders.length > 0 && (
            <box
              flexShrink={0}
              flexDirection="row"
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              backgroundColor={focus === "providers" ? t.selectedBg : undefined}
            >
              <text fg={t.textMuted}>{"providers: "}</text>
              {configuredProviders.map((p, i) => {
                const enabled = !disabledSet.has(p);
                const focused = focus === "providers" && i === providerChipIndex;
                const mark = enabled ? "✓" : "✗";
                const fg = focused ? t.accent : enabled ? t.text : t.textMuted;
                return (
                  <Semantic
                    key={p}
                    id={`provider-chip-${p}`}
                    role="button"
                    selected={enabled ? true : undefined}
                    name={p}
                  >
                    <text fg={fg}>
                      {`${i === 0 ? "" : "  "}${focused ? "[" : " "}${mark} ${p}${focused ? "]" : " "}`}
                    </text>
                  </Semantic>
                );
              })}
            </box>
          )}
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <text fg={t.text}>{searchQuery || <span style={{ fg: t.textMuted }}>{"Search..."}</span>}</text>
          </box>
          <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
            {showGroups && tierGroups
              ? tierGroups.map((group) => (
                  <box key={group.tier} flexDirection="column">
                    <box paddingLeft={2} paddingRight={2}>
                      <text fg={t.textDim}>
                        {"── " +
                          (group.tier === "premium"
                            ? "Premium"
                            : group.tier === "balanced"
                              ? "Balanced"
                              : group.tier === "fast"
                                ? "Fast"
                                : group.tier) +
                          " " +
                          "─".repeat(Math.max(0, panelWidth - 16))}
                      </text>
                    </box>
                    {group.items.map((m) => {
                      const globalIdx = sortedModels.indexOf(m);
                      return renderModelRow(m, globalIdx);
                    })}
                  </box>
                ))
              : sortedModels.map((m, idx) => renderModelRow(m, idx))}
            {filteredModels.length === 0 && (
              <box paddingLeft={2}>
                <text fg={t.textMuted}>{"No models match your search"}</text>
              </box>
            )}
          </scrollbox>
          {selectedModel && (
            <box flexShrink={0} paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>
                {`${selectedModel.name}${selectedModel.provider ? ` (${selectedModel.provider})` : ""}`}
              </text>
            </box>
          )}
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.textMuted}>
              {focus === "providers"
                ? "←→ pick  Space toggle  Tab back  Esc close"
                : selectedSupportsReasoning
                  ? "↑↓ nav  Space toggle  ←→ reasoning  Enter select  Tab providers  Esc close"
                  : "↑↓ nav  Space toggle  Enter select  Tab providers  Esc close"}
            </text>
          </box>
        </box>
      </box>
    </Semantic>
  );
}
