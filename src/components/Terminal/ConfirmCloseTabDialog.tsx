import { useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
    <Dialog.Root open={true} onOpenChange={(isOpen) => !isOpen && handleCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcuts-overlay__backdrop" />
        <Dialog.Content
          className="confirm-close-tab-dialog"
          data-testid="confirm-close-tab-dialog"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Enter on the dialog content triggers confirm; focused Cancel button
              // does not bubble its own Enter here because we attach to content.
              if (document.activeElement === cancelBtnRef.current) return;
              e.preventDefault();
              handleConfirm();
            }
          }}
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "380px",
            padding: "var(--spacing-lg, 16px)",
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-lg, 8px)",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
            zIndex: 1001,
          }}
        >
          <Dialog.Title
            style={{ margin: "0 0 var(--spacing-md, 12px) 0", color: "var(--text-primary)" }}
          >
            {title}
          </Dialog.Title>
          <Dialog.Description style={{ color: "var(--text-secondary)", marginBottom: "16px" }}>
            {description}
          </Dialog.Description>
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              ref={cancelBtnRef}
              onClick={handleCancel}
              data-testid="confirm-close-tab-cancel"
              style={{
                padding: "4px 16px",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md, 4px)",
                background: "transparent",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              data-testid={confirmTestId}
              style={{
                padding: "4px 16px",
                border: "none",
                borderRadius: "var(--radius-md, 4px)",
                background: "var(--color-error)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
