import { toast } from "@/components/ui";
import { TerminalTab, ReopenTabPayload } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";

/**
 * Build the {@link ReopenTabPayload} for a tab, or `null` when the tab cannot be
 * meaningfully reopened (non-terminal tabs, or tabs attached to a persistent
 * session — closing those only detaches, so there is nothing to undo).
 */
export function reopenPayloadForTab(
  tab: Pick<
    TerminalTab,
    "title" | "connectionType" | "config" | "contentType" | "persistentConnectionId"
  >
): ReopenTabPayload | null {
  if (tab.contentType !== "terminal") return null;
  if (tab.persistentConnectionId) return null;
  return { title: tab.title, connectionType: tab.connectionType, config: tab.config };
}

/**
 * Show a success toast confirming a tab was closed, with an Undo/Reopen action
 * that opens a fresh tab from the saved connection config. No-op when `payload`
 * is null (nothing reconnectable to offer). The toast goes away when a dialog
 * opens (#5665).
 */
export function showReopenToast(payload: ReopenTabPayload | null): void {
  if (!payload) return;
  toast.success(`Closed “${payload.title}”`, {
    // The undo belongs to the moment of closing: a dialog opened afterwards
    // (a settings confirm, an unlock) dismisses it rather than sitting beside
    // it (#5665).
    dismissOnModal: true,
    action: {
      label: "Reopen",
      onClick: () =>
        useAppStore.getState().addTab(payload.title, payload.connectionType, payload.config, {
          contentType: "terminal",
        }),
    },
  });
}
