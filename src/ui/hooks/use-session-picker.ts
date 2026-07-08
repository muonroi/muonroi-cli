import { useState } from "react";
import type { ResumeEntry } from "../../types/index.js";

/**
 * State for the /sessions picker modal. Sessions are loaded lazily when the
 * picker is opened (the SQLite query is cheap — ORDER BY updated_at LIMIT 20
 * on an indexed column) so we do not pay for it on cold boot.
 */
export function useSessionPicker() {
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [sessions, setSessions] = useState<ResumeEntry[]>([]);
  return {
    showSessionPicker,
    setShowSessionPicker,
    sessionPickerIndex,
    setSessionPickerIndex,
    sessions,
    setSessions,
  };
}
