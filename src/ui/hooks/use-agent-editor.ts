import { useState } from "react";
import { MODELS } from "../../models/registry.js";
import type { StoredSchedule } from "../../tools/schedule.js";
import type { CustomSubagentConfig } from "../../utils/settings.js";
import { loadValidSubAgents } from "../../utils/settings.js";
import type { SubagentEditorField } from "../agents-modal.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export function useAgentEditor() {
  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [showAgentsEditor, setShowAgentsEditor] = useState(false);
  const [subAgents, setSubAgents] = useState<CustomSubagentConfig[]>(() => loadValidSubAgents());
  const [agentsSearchQuery, setAgentsSearchQuery] = useState("");
  const [agentsModalIndex, setAgentsModalIndex] = useState(0);
  const [editingSubagent, setEditingSubagent] = useState<CustomSubagentConfig | null>(null);
  const [agentsEditorDraft, setAgentsEditorDraft] = useState({ name: "", instruction: "" });
  const [agentsEditorField, setAgentsEditorField] = useState<SubagentEditorField>("name");
  const [agentsEditorModelIndex, setAgentsEditorModelIndex] = useState(() =>
    Math.max(
      0,
      MODELS.findIndex((model) => model.id === DEFAULT_MODEL),
    ),
  );
  const [agentsEditorSyncKey, setAgentsEditorSyncKey] = useState(0);
  const [agentsEditorError, setAgentsEditorError] = useState<string | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [schedules, setSchedules] = useState<StoredSchedule[]>([]);
  const [scheduleSearchQuery, setScheduleSearchQuery] = useState("");
  const [scheduleModalIndex, setScheduleModalIndex] = useState(0);
  return {
    showAgentsModal,
    setShowAgentsModal,
    showAgentsEditor,
    setShowAgentsEditor,
    subAgents,
    setSubAgents,
    agentsSearchQuery,
    setAgentsSearchQuery,
    agentsModalIndex,
    setAgentsModalIndex,
    editingSubagent,
    setEditingSubagent,
    agentsEditorDraft,
    setAgentsEditorDraft,
    agentsEditorField,
    setAgentsEditorField,
    agentsEditorModelIndex,
    setAgentsEditorModelIndex,
    agentsEditorSyncKey,
    setAgentsEditorSyncKey,
    agentsEditorError,
    setAgentsEditorError,
    showScheduleModal,
    setShowScheduleModal,
    schedules,
    setSchedules,
    scheduleSearchQuery,
    setScheduleSearchQuery,
    scheduleModalIndex,
    setScheduleModalIndex,
  };
}
