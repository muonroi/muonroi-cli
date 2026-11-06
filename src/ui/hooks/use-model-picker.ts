import { useState } from "react";
import { normalizeModelId } from "../../models/registry.js";
import type { ProviderId } from "../../providers/types.js";
import type { ReasoningEffort } from "../../types/index.js";
import { getDefaultProvider, getDisabledModels, getDisabledProviders, loadUserSettings } from "../../utils/settings.js";
import { useLiveState } from "../live-state.js";

export function useModelPicker(initialModel: string) {
  const [model, setModel] = useState(initialModel);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [configuredProviders, setConfiguredProviders] = useState<ProviderId[]>([]);
  const [disabledProviders, setDisabledProvidersState] = useState<ProviderId[]>(() => getDisabledProviders());
  const [defaultProvider, setDefaultProviderState] = useState<ProviderId | null>(() => getDefaultProvider());
  const [disabledModels, setDisabledModelsState] = useState<string[]>(() => getDisabledModels());
  const [modelPickerFocus, setModelPickerFocus] = useState<"models" | "providers">("models");
  // Live: K/O/D/Enter act on the chip the cursor is on even when ↑/↓ shares the
  // stdin chunk (handleKey reads providerChipIndexRef, see live-state.ts).
  const [providerChipIndex, setProviderChipIndex, providerChipIndexRef] = useLiveState(0);
  const [reasoningEffortByModel, setReasoningEffortByModel] = useState<Record<string, ReasoningEffort>>(() =>
    Object.fromEntries(
      Object.entries(loadUserSettings().reasoningEffortByModel ?? {}).map(([modelId, effort]) => [
        normalizeModelId(modelId),
        effort,
      ]),
    ),
  );
  return {
    model,
    setModel,
    showModelPicker,
    setShowModelPicker,
    modelPickerIndex,
    setModelPickerIndex,
    modelSearchQuery,
    setModelSearchQuery,
    configuredProviders,
    setConfiguredProviders,
    disabledProviders,
    setDisabledProvidersState,
    defaultProvider,
    setDefaultProviderState,
    disabledModels,
    setDisabledModelsState,
    modelPickerFocus,
    setModelPickerFocus,
    providerChipIndex,
    setProviderChipIndex,
    providerChipIndexRef,
    reasoningEffortByModel,
    setReasoningEffortByModel,
  };
}
