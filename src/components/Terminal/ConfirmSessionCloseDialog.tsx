import { ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { showReopenToast } from "@/utils/reopenTab";

/**
 * Confirmation dialog shown before tearing down a live session by closing a tab
 * (via the tab X or middle-click) or a split panel, while
 * `settings.confirmCloseLiveSession` is enabled.
 *
 * Reads `pendingSessionCloseConfirm` from the store; renders nothing when no
 * request is pending. Confirming performs the close (and, for a tab with a known
 * connection, fires an Undo/Reopen toast). The dialog's "Don't ask again" toggle
 * persists `confirmCloseLiveSession: false` so future closes skip the prompt.
 */
export function ConfirmSessionCloseDialog() {
  const request = useAppStore((s) => s.pendingSessionCloseConfirm);
  const setRequest = useAppStore((s) => s.setPendingSessionCloseConfirm);
  const closeTab = useAppStore((s) => s.closeTab);
  const removePanel = useAppStore((s) => s.removePanel);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const dontAsk = settings.confirmCloseLiveSession === false;

  if (!request) return null;

  const handleCancel = () => setRequest(null);

  const handleConfirm = () => {
    if (request.kind === "tab") {
      closeTab(request.tabId, request.panelId);
      showReopenToast(request.reopen);
    } else {
      removePanel(request.panelId);
    }
    setRequest(null);
  };

  const handleDontAskChange = (checked: boolean) => {
    void updateSettings({ ...settings, confirmCloseLiveSession: !checked });
  };

  const isTab = request.kind === "tab";
  const title = isTab ? "Close tab?" : "Close panel?";
  const message = isTab
    ? `Closing “${request.label}” will end its live session.`
    : panelMessage(request.tabCount, request.liveCount);
  const confirmLabel = isTab ? "Close tab" : "Close panel";

  return (
    <ConfirmDialog
      open
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      dontAskAgain={{
        checked: dontAsk,
        onChange: handleDontAskChange,
        label: "Don't ask again",
      }}
      data-testid="confirm-session-close-dialog"
    />
  );
}

/** Count-aware body for a panel close: N tabs total, of which M hold live sessions. */
function panelMessage(tabCount: number, liveCount: number): string {
  const tabs = `${tabCount} tab${tabCount === 1 ? "" : "s"}`;
  const sessions = `${liveCount} live session${liveCount === 1 ? "" : "s"}`;
  return `Closing this panel will close ${tabs} and end ${sessions}.`;
}
