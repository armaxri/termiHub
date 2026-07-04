import { useEffect, useRef } from "react";
import { Modal, Button } from "@/components/ui";
import { useAppStore } from "@/store/appStore";

/**
 * Confirmation dialog shown when the user presses the close-tab or
 * close-tab-group keyboard shortcut while
 * `settings.confirmCloseTabOnShortcut` is enabled.
 *
 * Reads `pendingShortcutCloseConfirm` from the store; renders nothing when
 * no request is pending. Confirm closes the tab/group; Cancel (Esc, backdrop
 * click, button) clears the request and leaves the tab open.
 */
export function ConfirmCloseTabDialog() {
  const request = useAppStore((s) => s.pendingShortcutCloseConfirm);
  const setRequest = useAppStore((s) => s.setPendingShortcutCloseConfirm);
  const closeTab = useAppStore((s) => s.closeTab);
  const closeTabGroup = useAppStore((s) => s.closeTabGroup);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the safe (Cancel) button when the dialog opens so an accidental
  // Enter press does not close the tab.
  useEffect(() => {
    if (request) {
      // Defer to ensure the button is mounted.
      requestAnimationFrame(() => cancelBtnRef.current?.focus());
    }
  }, [request]);

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

  const title = request.kind === "tab" ? "Close tab?" : "Close tab group?";
  const description =
    request.kind === "tab"
      ? `Close "${request.label}"? Any work in this tab will be lost.`
      : `Close tab group "${request.label}" and all tabs inside it?`;
  const confirmLabel = request.kind === "tab" ? "Close tab" : "Close group";
  const confirmTestId =
    request.kind === "tab" ? "confirm-close-tab-confirm" : "confirm-close-tab-group-confirm";

  return (
    <Modal
      open
      onOpenChange={(isOpen) => !isOpen && handleCancel()}
      title={title}
      data-testid="confirm-close-tab-dialog"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          // Enter confirms — unless the safe Cancel button is focused.
          if (document.activeElement === cancelBtnRef.current) return;
          e.preventDefault();
          handleConfirm();
        }
      }}
      footer={
        <>
          <Button
            ref={cancelBtnRef}
            variant="secondary"
            onClick={handleCancel}
            data-testid="confirm-close-tab-cancel"
          >
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} data-testid={confirmTestId}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description}
    </Modal>
  );
}
