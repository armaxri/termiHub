import { getActiveTab, useAppStore } from "@/store/appStore";
import { currentSessionView, effectiveExited } from "@/store/sessionBridge";
import { useProjectedSessionLifecycleMaps } from "@/store/useSessionLifecycle";
import { t, tf } from "@/i18n/catalog";

/**
 * What the toolbar's recording chip says (#5818, slice 8): that a password prompt
 * is answered, that the terminal is not connected (the recording waits for it),
 * or which terminal is recorded when it is not the active one. `null` while
 * nothing is recorded.
 */
export function useRecordingLabel(): string | null {
  const recording = useAppStore((s) => s.recording);
  const activeTabId = useAppStore((s) => getActiveTab(s)?.id);
  // Re-renders when a session drops or comes back.
  useProjectedSessionLifecycleMaps();
  if (!recording) return null;
  if (recording.atPrompt) return t("terminalToolbar.chip.recordingPrompt");
  if (effectiveExited(currentSessionView()[recording.tabId])) {
    return t("terminalToolbar.chip.recordingPaused");
  }
  return recording.tabId === activeTabId
    ? t("terminalToolbar.chip.recording")
    : tf("terminalToolbar.chip.recordingIn", { tab: recording.tabTitle });
}
