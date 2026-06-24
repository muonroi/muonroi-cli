import { formatSubagentName } from "../../utils/subagent-display.js";
import { SubagentEditorModal, SubagentsBrowserModal } from "../agents-modal.js";
import { CONNECT_CHANNELS } from "../constants.js";
import { McpBrowserModal, McpEditorModal } from "../mcp-modal.js";
import { ApiKeyModal } from "../modals/api-key-modal.js";
import { ConnectModal, TelegramPairModal, TelegramTokenModal } from "../modals/connect-modal.js";
import { ModelPickerModal } from "../modals/model-picker-modal.js";
import { SandboxPickerModal } from "../modals/sandbox-picker-modal.js";
import { SessionPickerModal } from "../modals/session-picker-modal.js";
import { UpdateModal } from "../modals/update-modal.js";
import { WalletPickerModal } from "../modals/wallet-picker-modal.js";
import { ScheduleBrowserModal } from "../schedule-modal.js";

export interface ModalsLayerProps {
  agentRows: any;
  agentsEditorDraft: any;
  agentsEditorError: any;
  agentsEditorField: any;
  agentsEditorModelIndex: any;
  agentsEditorSyncKey: any;
  agentsModalIndex: any;
  agentsSearchQuery: any;
  apiKeyError: any;
  apiKeyInputRef: any;
  apiKeyPrompt: any;
  bwSync: any;
  configuredProviders: any;
  connectModalIndex: any;
  defaultProvider: any;
  disabledModels: any;
  disabledProviders: any;
  editingMcpId: any;
  editingSubagent: any;
  filteredModels: any;
  height: any;
  mcpArgsRef: any;
  mcpCommandRef: any;
  mcpCwdRef: any;
  mcpEditorDraft: any;
  mcpEditorError: any;
  mcpEditorField: any;
  mcpEditorSyncKey: any;
  mcpEnvRef: any;
  mcpHeadersRef: any;
  mcpLabelRef: any;
  mcpModalIndex: any;
  mcpRows: any;
  mcpSearchQuery: any;
  mcpUrlRef: any;
  model: any;
  modelPickerFocus: any;
  modelPickerIndex: any;
  modelSearchQuery: any;
  providerChipIndex: any;
  providersWithKey: any;
  reasoningEffortByModel: any;
  sandboxMode: any;
  sandboxSettings: any;
  sandboxSettingsEditBuffer: any;
  sandboxSettingsEditing: any;
  sandboxSettingsFocusIndex: any;
  scheduleModalIndex: any;
  scheduleRows: any;
  scheduleSearchQuery: any;
  sessionPickerIndex: any;
  sessionPickerList: any;
  showAgentsEditor: any;
  showAgentsModal: any;
  showApiKeyModal: any;
  showConnectModal: any;
  showMcpEditor: any;
  showMcpModal: any;
  showModelPicker: any;
  showSandboxPicker: any;
  showScheduleModal: any;
  showSessionPicker: any;
  showTelegramPairModal: any;
  showTelegramTokenModal: any;
  showUpdateModal: any;
  showWalletPicker: any;
  startupConfig: any;
  subagentInstructionRef: any;
  subagentNameRef: any;
  submitApiKey: any;
  submitMcpEditor: any;
  submitSubagentEditor: any;
  submitTelegramPair: any;
  submitTelegramToken: any;
  t: any;
  telegramPairError: any;
  telegramPairInputRef: any;
  telegramTokenError: any;
  telegramTokenInputRef: any;
  updateInfo: any;
  walletDisplayInfo: any;
  walletFocusIndex: any;
  walletSettings: any;
  width: any;
}

export function ModalsLayer(props: ModalsLayerProps) {
  const {
    agentRows,
    agentsEditorDraft,
    agentsEditorError,
    agentsEditorField,
    agentsEditorModelIndex,
    agentsEditorSyncKey,
    agentsModalIndex,
    agentsSearchQuery,
    apiKeyError,
    apiKeyInputRef,
    apiKeyPrompt,
    bwSync,
    configuredProviders,
    connectModalIndex,
    defaultProvider,
    disabledModels,
    disabledProviders,
    editingMcpId,
    editingSubagent,
    filteredModels,
    height,
    mcpArgsRef,
    mcpCommandRef,
    mcpCwdRef,
    mcpEditorDraft,
    mcpEditorError,
    mcpEditorField,
    mcpEditorSyncKey,
    mcpEnvRef,
    mcpHeadersRef,
    mcpLabelRef,
    mcpModalIndex,
    mcpRows,
    mcpSearchQuery,
    mcpUrlRef,
    model,
    modelPickerFocus,
    modelPickerIndex,
    modelSearchQuery,
    providerChipIndex,
    providersWithKey,
    reasoningEffortByModel,
    sandboxMode,
    sandboxSettings,
    sandboxSettingsEditBuffer,
    sandboxSettingsEditing,
    sandboxSettingsFocusIndex,
    scheduleModalIndex,
    scheduleRows,
    scheduleSearchQuery,
    sessionPickerIndex,
    sessionPickerList,
    showAgentsEditor,
    showAgentsModal,
    showApiKeyModal,
    showConnectModal,
    showMcpEditor,
    showMcpModal,
    showModelPicker,
    showSandboxPicker,
    showScheduleModal,
    showSessionPicker,
    showTelegramPairModal,
    showTelegramTokenModal,
    showUpdateModal,
    showWalletPicker,
    startupConfig,
    subagentInstructionRef,
    subagentNameRef,
    submitApiKey,
    submitMcpEditor,
    submitSubagentEditor,
    submitTelegramPair,
    submitTelegramToken,
    t,
    telegramPairError,
    telegramPairInputRef,
    telegramTokenError,
    telegramTokenInputRef,
    updateInfo,
    walletDisplayInfo,
    walletFocusIndex,
    walletSettings,
    width,
  } = props;

  return (
    <>
      {showApiKeyModal && (
        <ApiKeyModal
          t={t}
          width={width}
          height={height}
          inputRef={apiKeyInputRef}
          error={apiKeyError}
          onSubmit={submitApiKey}
        />
      )}
      {showUpdateModal && updateInfo && (
        <UpdateModal
          t={t}
          width={width}
          height={height}
          currentVersion={startupConfig.version}
          latestVersion={updateInfo.latestVersion}
        />
      )}
      {showMcpModal && !showMcpEditor && (
        <McpBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={mcpModalIndex}
          searchQuery={mcpSearchQuery}
          rows={mcpRows}
        />
      )}
      {showMcpEditor && (
        <McpEditorModal
          t={t}
          width={width}
          height={height}
          draft={mcpEditorDraft}
          focusedField={mcpEditorField}
          syncKey={mcpEditorSyncKey}
          error={mcpEditorError}
          title={editingMcpId ? "Edit MCP Server" : "Add MCP Server"}
          labelRef={mcpLabelRef}
          urlRef={mcpUrlRef}
          headersRef={mcpHeadersRef}
          commandRef={mcpCommandRef}
          argsRef={mcpArgsRef}
          cwdRef={mcpCwdRef}
          envRef={mcpEnvRef}
          onSubmit={submitMcpEditor}
        />
      )}
      {showScheduleModal && (
        <ScheduleBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={scheduleModalIndex}
          searchQuery={scheduleSearchQuery}
          rows={scheduleRows}
        />
      )}
      {showAgentsModal && !showAgentsEditor && (
        <SubagentsBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={agentsModalIndex}
          searchQuery={agentsSearchQuery}
          rows={agentRows}
        />
      )}
      {showAgentsEditor && (
        <SubagentEditorModal
          key={`subagent-editor-${agentsEditorSyncKey}`}
          t={t}
          width={width}
          height={height}
          draft={agentsEditorDraft}
          focusedField={agentsEditorField}
          modelIndex={agentsEditorModelIndex}
          error={agentsEditorError}
          title={editingSubagent ? `Edit sub-agent: ${formatSubagentName(editingSubagent.name)}` : "Add sub-agent"}
          nameRef={subagentNameRef}
          instructionRef={subagentInstructionRef}
          onSubmit={submitSubagentEditor}
          showRemoveHint={!!editingSubagent}
        />
      )}
      {showModelPicker && (
        <ModelPickerModal
          t={t}
          currentModel={model}
          selectedIndex={modelPickerIndex}
          width={width}
          height={height}
          searchQuery={modelSearchQuery}
          filteredModels={filteredModels}
          reasoningEffortByModel={reasoningEffortByModel}
          configuredProviders={configuredProviders}
          disabledProviders={disabledProviders}
          disabledModels={disabledModels}
          defaultProvider={defaultProvider}
          focus={modelPickerFocus}
          providerChipIndex={providerChipIndex}
          providersWithKey={providersWithKey}
          apiKeyPrompt={apiKeyPrompt}
          bwSync={bwSync}
        />
      )}
      {showSessionPicker && (
        <SessionPickerModal
          t={t}
          sessions={sessionPickerList}
          focusIndex={sessionPickerIndex}
          width={width}
          height={height}
        />
      )}
      {showWalletPicker && (
        <WalletPickerModal
          t={t}
          settings={walletSettings}
          walletInfo={walletDisplayInfo}
          focusIndex={walletFocusIndex}
          width={width}
          height={height}
        />
      )}
      {showSandboxPicker && (
        <SandboxPickerModal
          t={t}
          currentMode={sandboxMode}
          settings={sandboxSettings}
          focusIndex={sandboxSettingsFocusIndex}
          editing={sandboxSettingsEditing}
          editBuffer={sandboxSettingsEditBuffer}
          width={width}
          height={height}
        />
      )}
      {showConnectModal && (
        <ConnectModal
          t={t}
          width={width}
          height={height}
          selectedIndex={connectModalIndex}
          channels={CONNECT_CHANNELS}
        />
      )}
      {showTelegramTokenModal && (
        <TelegramTokenModal
          t={t}
          width={width}
          height={height}
          inputRef={telegramTokenInputRef}
          error={telegramTokenError}
          onSubmit={submitTelegramToken}
        />
      )}
      {showTelegramPairModal && (
        <TelegramPairModal
          t={t}
          width={width}
          height={height}
          inputRef={telegramPairInputRef}
          error={telegramPairError}
          onSubmit={() => void submitTelegramPair()}
        />
      )}
    </>
  );
}
