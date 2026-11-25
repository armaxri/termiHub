import { getActiveTab, useAppStore } from "@/store/appStore";
import { currentSessionView, effectiveExited } from "@/store/sessionBridge";
import { useProjectedSessionLifecycleMaps } from "@/store/useSessionLifecycle";
import { t, tf } from "@/i18n/catalog";

/**
 * What the toolbar's recording chip says (#5818, slice 8): that the terminal is not connected (the recording waits for it),
 * or which terminal is recorded when it is not the active one. `null` while
 * nothing is recorded, and while the recording goes into the open automation: the
 * strip above the terminals has its one Stop then (A-010).
 */
export function useRecordingLabel(): string | null {
  const recording = useAppStore((s) => s.recording);
  const activeTabId = useAppStore((s) => getActiveTab(s)?.id);
  // Re-renders when a session drops or comes back.
  useProjectedSessionLifecycleMaps();
  if (!recording || recording.intoEditor !== null) return null;
  if (effectiveExited(currentSessionView()[recording.tabId])) {
    return t("terminalToolbar.chip.recordingPaused");
  }
  return recording.tabId === activeTabId
    ? t("terminalToolbar.chip.recording")
    : tf("terminalToolbar.chip.recordingIn", { tab: recording.tabTitle });
}
