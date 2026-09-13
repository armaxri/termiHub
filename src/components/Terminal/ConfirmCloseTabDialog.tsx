import { ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";

/**
 * Confirmation dialog shown when the user presses the close-tab or
 * close-tab-group keyboard shortcut while
 * `settings.confirmCloseTabOnShortcut` is enabled.
 *
 * Reads `pendingShortcutCloseConfirm` from the store; renders nothing when
 * no request is pending. Confirm closes the tab/group; Cancel (Esc, backdrop
 * click, button) clears the request and leaves the tab open. The safe-default
 * focus/Enter wiring (Cancel focused on open, Enter confirms unless Cancel
 * holds focus) comes from the shared {@link ConfirmDialog} primitive.
 */
export function ConfirmCloseTabDialog() {
  const request = useAppStore((s) => s.pendingShortcutCloseConfirm);
  const setRequest = useAppStore((s) => s.setPendingShortcutCloseConfirm);
  const closeTab = useAppStore((s) => s.closeTab);
  const closeTabGroup = useAppStore((s) => s.closeTabGroup);

  if (!request) return null;

  const handleCancel = () => setRequest(null);
  const handleConfirm = () => {
    if (request.kind === "tab") {
      closeTab(request.tabId, request.panelId);
    } else {
      closeTabGroup(request.tabGroupId);
    }
    setRequest(null);
  };

  const isTab = request.kind === "tab";
  const title = isTab ? "Close tab?" : "Close tab group?";
  const message = isTab
    ? `Close "${request.label}"? Any work in this tab will be lost.`
    : `Close tab group "${request.label}" and all tabs inside it?`;
  const confirmLabel = isTab ? "Close tab" : "Close group";
  // Preserve the historical per-kind confirm test ids
  // (`confirm-close-tab-confirm` is used by the system-test harness).
  const testIdBase = isTab ? "confirm-close-tab" : "confirm-close-tab-group";

  return (
    <ConfirmDialog
      open
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      confirmVariant="danger"
      testIdBase={testIdBase}
      data-testid="confirm-close-tab-dialog"
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );
}
