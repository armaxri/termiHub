import { useState } from "react";
import { ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { showReopenToast } from "@/utils/reopenTab";
import type { SessionCloseConfirmRequest } from "@/types/terminal";

/**
 * Confirmation dialog shown before tearing down a live session by closing a tab
 * (via the tab X or middle-click), a split panel, or a whole tab group, while
 * `settings.confirmCloseLiveSession` is enabled. A group close also prompts when
 * it would discard unsaved editors; the "Don't ask again" opt-out is then hidden,
 * since it only covers live sessions.
 *
 * Reads `pendingSessionCloseConfirm` from the store; renders nothing when no
 * request is pending. Confirming performs the close (and, for a tab with a known
 * connection, fires an Undo/Reopen toast). The dialog's "Don't ask again"
 * checkbox is local state that only takes effect on confirm: confirming with it
 * ticked persists `confirmCloseLiveSession: false` so future closes skip the
 * prompt, while cancelling discards the tick and leaves the setting untouched.
 * This honours the checkbox contract from {@link ConfirmDialog} (a checkbox
 * applies on confirm, not the moment it is ticked).
 */
export function ConfirmSessionCloseDialog() {
  const request = useAppStore((s) => s.pendingSessionCloseConfirm);
  const setRequest = useAppStore((s) => s.setPendingSessionCloseConfirm);
  const closeTab = useAppStore((s) => s.closeTab);
  const removePanel = useAppStore((s) => s.removePanel);
  const closeTabGroup = useAppStore((s) => s.closeTabGroup);
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  // Local, deferred checkbox state — committed only on confirm, discarded on cancel.
  const [dontAsk, setDontAsk] = useState(false);

  if (!request) return null;

  const handleCancel = () => {
    setDontAsk(false);
    setRequest(null);
  };

  const handleConfirm = () => {
    if (dontAsk) {
      void updateSettings({ ...settings, confirmCloseLiveSession: false });
    }
    if (request.kind === "tab") {
      closeTab(request.tabId, request.panelId);
      showReopenToast(request.reopen);
    } else if (request.kind === "panel") {
      removePanel(request.panelId);
    } else {
      closeTabGroup(request.tabGroupId);
    }
    setDontAsk(false);
    setRequest(null);
  };

  const { title, message, confirmLabel } = dialogCopy(request);
  // The opt-out only suppresses live-session prompts, so it is not offered when
  // the close would also discard unsaved editors.
  const offerDontAsk = !(request.kind === "group" && request.dirtyCount > 0);

  return (
    <ConfirmDialog
      open
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      dontAskAgain={
        offerDontAsk
          ? { checked: dontAsk, onChange: setDontAsk, label: "Don't ask again" }
          : undefined
      }
      data-testid="confirm-session-close-dialog"
    />
  );
}

/** Title, body and confirm label for each request kind. */
function dialogCopy(request: SessionCloseConfirmRequest): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  switch (request.kind) {
    case "tab":
      return {
        title: "Close tab?",
        message: `Closing “${request.label}” will end its live session.`,
        confirmLabel: "Close tab",
      };
    case "panel":
      return {
        title: "Close panel?",
        message: panelMessage(request.tabCount, request.liveCount),
        confirmLabel: "Close panel",
      };
    case "group":
      return {
        title: "Close group?",
        message: groupMessage(request.label, request.liveCount, request.dirtyCount),
        confirmLabel: "Close group",
      };
  }
}

/** Count-aware body for a group close: live sessions ending and unsaved editors lost. */
function groupMessage(label: string, liveCount: number, dirtyCount: number): string {
  const parts: string[] = [];
  if (liveCount > 0) {
    parts.push(`end ${liveCount} live session${liveCount === 1 ? "" : "s"}`);
  }
  if (dirtyCount > 0) {
    parts.push(`discard ${dirtyCount} unsaved editor${dirtyCount === 1 ? "" : "s"}`);
  }
  return `Closing group “${label}” will ${parts.join(" and ")}.`;
}

/** Count-aware body for a panel close: N tabs total, of which M hold live sessions. */
function panelMessage(tabCount: number, liveCount: number): string {
  const tabs = `${tabCount} tab${tabCount === 1 ? "" : "s"}`;
  const sessions = `${liveCount} live session${liveCount === 1 ? "" : "s"}`;
  return `Closing this panel will close ${tabs} and end ${sessions}.`;
}
