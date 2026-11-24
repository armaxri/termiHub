import { useEffect } from "react";
import { toast } from "@/components/ui";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { useAppStore } from "@/store/appStore";
import { useLayoutRenderTree, useLayoutTabGroups } from "@/store/layoutSelectors";
import type { SaveTakeRequest } from "@/store/slices/recordingSlice";
import { useProjectedSessionLifecycleMaps } from "@/store/useSessionLifecycle";
import { RecordingSaveDialog } from "./RecordingSaveDialog";

/**
 * App-level host of recording (#5818, slice 8): it follows the recorded terminal
 * (a closed tab or an ended session stops the recording and keeps what was
 * typed; a dropped one waits for its reconnect) and shows the save dialog.
 */
export function RecordingHost() {
  const recordedTab = useAppStore((s) => s.recording?.tabId);
  const follow = useAppStore((s) => s.followRecordedTerminal);
  const take = useAppStore((s) => s.recordedTake);
  const saveOpen = useAppStore((s) => s.recordingSaveOpen);
  const startHeld = useAppStore((s) => s.recordingStartHeld);
  const automations = useAppStore((s) => s.automations);
  const setSaveOpen = useAppStore((s) => s.setRecordingSaveOpen);
  const save = useAppStore((s) => s.saveRecordedTake);
  const discard = useAppStore((s) => s.discardRecordedTake);
  // A change of the layout or of a session may be the end of the terminal.
  const rootPanel = useLayoutRenderTree();
  const tabGroups = useLayoutTabGroups();
  const lifecycle = useProjectedSessionLifecycleMaps();
  useEffect(() => {
    if (recordedTab) follow();
  }, [recordedTab, follow, rootPanel, tabGroups, lifecycle]);

  const handleSave = async (request: SaveTakeRequest) => {
    const id = await save(request);
    const state = useAppStore.getState();
    useAutomationSections.getState().markSaved(id);
    if (state.sidebarView === "automations" && !state.sidebarCollapsed) return;
    const name = state.automations.find((a) => a.id === id)?.name ?? "the automation";
    // toast-policy: off-screen — the saved row is in the Automations list, which does not show
    toast.success(
      request.to === "new" ? `Saved automation "${name}"` : `Added the recording to "${name}"`
    );
  };

  // Not while a recording runs: a take brought back meanwhile waits for its end.
  if (!take || take.forEditor || !saveOpen || recordedTab) return null;
  return (
    <RecordingSaveDialog
      key={take.id}
      take={take}
      automations={automations}
      startHeld={startHeld}
      onKeep={() => setSaveOpen(false)}
      onDiscard={discard}
      onSave={handleSave}
    />
  );
}
