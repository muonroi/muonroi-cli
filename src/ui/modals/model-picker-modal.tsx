import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ProviderId } from "../../providers/types.js";
import type { ModelInfo, ReasoningEffort } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

// Tier helpers retained for backwards-compat consumers (e.g. tests).
const TIER_ORDER_MAP: Record<string, number> = { premium: 0, balanced: 1, fast: 2 };

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

export interface ApiKeyPromptState {
  provider: ProviderId;
  value: string;
  error: string | null;
  /** When true the field shows the raw key instead of mask dots (Ctrl+R). */
  reveal?: boolean;
}

/** In-progress OAuth login overlay state (browser-based subscription sign-in). */
export interface OAuthLoginState {
  provider: ProviderId;
  error: string | null;
}

export function ModelPickerModal({
  t,
  width,
  height,
  configuredProviders,
  disabledProviders,
  defaultProvider,
  providerChipIndex,
  providersWithKey,
  apiKeyPrompt,
  oauthProviders,
  oauthLogin,
}: {
  t: Theme;
  currentModel?: string;
  selectedIndex?: number;
  width: number;
  height: number;
  searchQuery?: string;
  filteredModels?: ModelInfo[];
  reasoningEffortByModel?: Record<string, ReasoningEffort>;
  configuredProviders: ProviderId[];
  disabledProviders: ProviderId[];
  disabledModels?: string[];
  defaultProvider?: ProviderId | null;
  focus?: "models" | "providers";
  providerChipIndex: number;
  providersWithKey?: ReadonlySet<ProviderId>;
  apiKeyPrompt?: ApiKeyPromptState | null;
  /** Providers that support OAuth subscription login (openai, xai). */
  oauthProviders?: ReadonlySet<ProviderId>;
  oauthLogin?: OAuthLoginState | null;
}) {
  const disabledSet = new Set(disabledProviders);
  const keyedSet = providersWithKey ?? new Set<ProviderId>();
  const oauthSet = oauthProviders ?? new Set<ProviderId>();
  const panelWidth = Math.min(64, width - 6);

  const rowCount = Math.max(configuredProviders.length, 1);
  const contentHeight = rowCount + 7;
  const maxH = Math.floor(height * 0.65);
  const panelHeight = Math.min(contentHeight, maxH);
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;

  // Sub-modal: API key prompt overlay (rendered on top of the picker).
  const subModal = apiKeyPrompt ? (
    <Semantic id="provider-key-prompt" role="dialog" isModal name={`Set ${apiKeyPrompt.provider} key`}>
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={Math.floor(height / 3)}
        backgroundColor="#000000dd"
      >
        <box
          width={Math.min(60, width - 8)}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="column"
        >
          <text fg={t.primary}>
            <b>{`Set API key — ${apiKeyPrompt.provider}`}</b>
          </text>
          <box paddingTop={1}>
            <text fg={t.textMuted}>
              {"Key is stored as an environment variable (~/.muonroi-cli/.env, mirrored to your OS env)."}
            </text>
          </box>
          <Semantic
            id="provider-key-input"
            role="textbox"
            name={`${apiKeyPrompt.provider} API key`}
            focus
            value={apiKeyPrompt.value}
          >
            <box
              paddingTop={1}
              backgroundColor={t.backgroundElement}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="row"
              justifyContent="space-between"
            >
              {apiKeyPrompt.value.length > 0 ? (
                <text fg={t.text}>
                  {`${apiKeyPrompt.reveal ? apiKeyPrompt.value.slice(0, 40) : "•".repeat(Math.min(apiKeyPrompt.value.length, 40))}▏`}
                </text>
              ) : (
                <text fg={t.textDim}>{"▏(type or paste key)"}</text>
              )}
              {apiKeyPrompt.value.length > 0 ? (
                <text
                  fg={t.textMuted}
                >{`${apiKeyPrompt.reveal ? "shown" : "hidden"} · ${apiKeyPrompt.value.length} chars`}</text>
              ) : null}
            </box>
          </Semantic>
          {apiKeyPrompt.error ? (
            <box paddingTop={1}>
              <text fg={t.initFormError}>{apiKeyPrompt.error}</text>
            </box>
          ) : null}
          <box paddingTop={1}>
            <text fg={t.textMuted}>{"Enter save · Esc cancel · Ctrl+R reveal · paste works"}</text>
          </box>
        </box>
      </box>
    </Semantic>
  ) : null;

  // Sub-modal: OAuth subscription login (browser-based) for openai / xai.
  const oauthModal = oauthLogin ? (
    <Semantic id="provider-oauth-login" role="dialog" isModal name={`Sign in to ${oauthLogin.provider}`}>
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={Math.floor(height / 3)}
        backgroundColor="#000000dd"
      >
        <box
          width={Math.min(60, width - 8)}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="column"
        >
          <text fg={t.primary}>
            <b>{`Sign in to ${oauthLogin.provider} (OAuth)`}</b>
          </text>
          <box paddingTop={1}>
            <text fg={t.textMuted}>
              {"A browser window is opening. Complete the sign-in there; this returns automatically."}
            </text>
          </box>
          {oauthLogin.error ? (
            <box paddingTop={1}>
              <text fg={t.initFormError}>{oauthLogin.error}</text>
            </box>
          ) : (
            <box paddingTop={1}>
              <text fg={t.textMuted}>{"Waiting for authorization…  Esc cancel"}</text>
            </box>
          )}
        </box>
      </box>
    </Semantic>
  ) : null;

  return (
    <>
      <Semantic id="model-picker" role="dialog" isModal name="Providers">
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
                <b>{"Providers"}</b>
              </text>
              <text fg={t.textMuted}>{"esc"}</text>
            </box>
            <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} flexDirection="column">
              {configuredProviders.length === 0 ? (
                <text fg={t.textMuted}>{"No providers configured"}</text>
              ) : (
                configuredProviders.map((p, i) => {
                  const hasKey = keyedSet.has(p);
                  const enabled = hasKey && !disabledSet.has(p);
                  const focused = i === providerChipIndex;
                  const isDefault = defaultProvider === p;
                  const mark = !hasKey ? "·" : enabled ? "✓" : "✗";
                  const star = isDefault ? "★" : " ";
                  const fg = focused ? t.accent : enabled ? t.text : t.textMuted;
                  const starFg = isDefault ? t.primary : t.textDim;
                  const canOAuth = oauthSet.has(p);
                  const suffix = !hasKey ? (canOAuth ? "  (Enter sign in · K key)" : "  (no key — press K)") : "";
                  return (
                    <Semantic
                      key={p}
                      id={`provider-chip-${p}`}
                      role="button"
                      selected={enabled ? true : undefined}
                      disabled={!hasKey ? true : undefined}
                      name={p}
                    >
                      <box
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={focused ? t.selectedBg : undefined}
                        width="100%"
                        flexDirection="row"
                      >
                        <text fg={fg}>{`${focused ? "›" : " "} ${mark} `}</text>
                        <text fg={starFg}>{`${star} `}</text>
                        <text fg={fg}>{p}</text>
                        {suffix ? <text fg={t.textMuted}>{suffix}</text> : null}
                      </box>
                    </Semantic>
                  );
                })
              )}
            </box>
            <box flexGrow={1} minHeight={0} />
            <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
              <text fg={t.textMuted}>{"↑↓ nav  Space toggle  D default  O sign in  K set key  Esc close"}</text>
            </box>
          </box>
        </box>
      </Semantic>
      {subModal}
      {oauthModal}
    </>
  );
}
