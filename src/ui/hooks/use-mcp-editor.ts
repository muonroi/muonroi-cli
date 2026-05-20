import { useState } from "react";
import type { McpServerConfig } from "../../utils/settings.js";
import { loadMcpServers } from "../../utils/settings.js";
import { createEmptyMcpEditorDraft, type McpEditorDraft, type McpEditorField } from "../mcp-modal-types.js";

export function useMcpEditor() {
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [showMcpEditor, setShowMcpEditor] = useState(false);
  const [mcpSearchQuery, setMcpSearchQuery] = useState("");
  const [mcpModalIndex, setMcpModalIndex] = useState(0);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  const [mcpEditorDraft, setMcpEditorDraft] = useState<McpEditorDraft>(createEmptyMcpEditorDraft());
  const [mcpEditorField, setMcpEditorField] = useState<McpEditorField>("transport");
  const [mcpEditorSyncKey, setMcpEditorSyncKey] = useState(0);
  const [mcpEditorError, setMcpEditorError] = useState<string | null>(null);
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  return {
    showMcpModal,
    setShowMcpModal,
    showMcpEditor,
    setShowMcpEditor,
    mcpSearchQuery,
    setMcpSearchQuery,
    mcpModalIndex,
    setMcpModalIndex,
    mcpServers,
    setMcpServers,
    mcpEditorDraft,
    setMcpEditorDraft,
    mcpEditorField,
    setMcpEditorField,
    mcpEditorSyncKey,
    setMcpEditorSyncKey,
    mcpEditorError,
    setMcpEditorError,
    editingMcpId,
    setEditingMcpId,
  };
}
