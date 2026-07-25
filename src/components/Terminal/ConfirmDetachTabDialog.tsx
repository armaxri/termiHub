import { useState } from "react";
import { ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";

/**
 * One-time notice shown before closing a tab that is attached to a persistent
 * background session (via the tab X or middle-click), while
 * `settings.confirmCloseAttachedTab` is enabled.
 *
 * Unlike the live-session warning, closing a persistent-attached tab is *not*
 * destructive — it only detaches the tab, leaving the background process
 * running — so this reassures the user rather than warning of data loss. Reads
 * `pendingAttachedTabCloseConfirm` from the store; renders nothing when no
 * request is pending. The "Don't show again" checkbox is local state that only
 * takes effect on confirm: confirming with it ticked persists
 * `confirmCloseAttachedTab: false` so future closes skip the notice, while
 * cancelling discards the tick and leaves the setting untouched (honouring the
 * {@link ConfirmDialog} checkbox contract).
 */
export function ConfirmDetachTabDialog() {
  const request = useAppStore((s) => s.pendingAttachedTabCloseConfirm);
  const setRequest = useAppStore((s) => s.setPendingAttachedTabCloseConfirm);
  const closeTab = useAppStore((s) => s.closeTab);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  // Local, deferred checkbox state — committed only on confirm, discarded on cancel.
  const [dontShow, setDontShow] = useState(false);

  if (!request) return null;

  const handleCancel = () => {
    setDontShow(false);
    setRequest(null);
  };

  const handleConfirm = () => {
    if (dontShow) {
      void updateSettings({ ...settings, confirmCloseAttachedTab: false });
    }
    closeTab(request.tabId, request.panelId);
    setDontShow(false);
    setRequest(null);
  };

  return (
    <ConfirmDialog
      open
      title="Close tab?"
      message={`Closing “${request.label}” leaves its session running in the background. Use Stop in the sidebar to terminate it.`}
      confirmLabel="Close tab"
      confirmVariant="primary"
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      dontAskAgain={{
        checked: dontShow,
        onChange: setDontShow,
        label: "Don't show again",
      }}
      testIdBase="confirm-detach-tab"
      data-testid="confirm-detach-tab-dialog"
    />
  );
}
