import { ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { getLayoutRenderTree } from "@/store/layoutSelectors";
import { getAllLeaves } from "@/utils/panelTree";
import { continueTabClose } from "@/utils/tabCloseFlow";

/**
 * Confirmation dialog the close-tab and close-tab-group keyboard shortcuts
 * raise.
 *
 * - `tab` — the generic unsaved-changes prompt for a dirty tab whose editor has
 *   no prompt of its own (#4410). A clean tab never lands here: the shortcut
 *   runs the shared close decision (`tabCloseFlow.ts`, #5189), which confirms
 *   only a live or persistent session, with the same dialogs as the tab X.
 *   Confirming continues that decision, so a dirty live tab is still asked
 *   about its session.
 * - `tab-group` — the plain group confirm, while
 *   `settings.confirmCloseTabOnShortcut` is enabled.
 *
 * Reads `pendingShortcutCloseConfirm` from the store; renders nothing when
 * no request is pending. Cancel (Esc, backdrop click, button) clears the
 * request and leaves the tab open. The safe-default
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
    setRequest(null);
    if (request.kind === "tab-group") {
      closeTabGroup(request.tabGroupId);
      return;
    }
    const tab = getAllLeaves(getLayoutRenderTree())
      .find((p) => p.id === request.panelId)
      ?.tabs.find((t) => t.id === request.tabId);
    if (tab) continueTabClose(tab, request.panelId, "shortcut");
    else closeTab(request.tabId, request.panelId);
  };

  const isTab = request.kind === "tab";
  // The same copy as the tab X's unsaved-changes fallback dialog.
  const title = isTab ? "Unsaved changes" : "Close tab group?";
  const message = isTab
    ? `"${request.label}" has unsaved changes. Close anyway?`
    : `Close tab group "${request.label}" and all tabs inside it?`;
  const confirmLabel = isTab ? "Close anyway" : "Close group";
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
