import { useCallback } from "react";
import { FolderOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSessionLifecycle } from "@/store/useSessionLifecycle";
import { getComposedLayout } from "@/store/layoutHelpers";
import { findLeafByTab } from "@/utils/panelTree";
import { Button, ContentOverlay } from "@/components/ui";
import "./TerminalDisconnectOverlay.css";

interface TerminalFilesOnlyPanelProps {
  tabId: string;
  /**
   * Whether this tab is the active (visible) one. Moves focus to **Open Files**
   * when the panel appears (#4514) — there is no shell to type into; background
   * tabs never steal focus.
   */
  isActive?: boolean;
}

/**
 * "No shell" info panel for a files-only SSH session (#4078). The host refused
 * the interactive shell (e.g. `ForceCommand internal-sftp`) but SFTP works, so
 * the backend kept the session up for the Files sidebar and editor. The panel
 * covers the (empty) terminal and offers **Open Files**, which focuses this tab
 * and opens the Files sidebar on its session.
 *
 * Renders nothing unless the tab's projected lifecycle is files-only — the
 * verdict comes from the backend, never from terminal output.
 */
export function TerminalFilesOnlyPanel({ tabId, isActive = false }: TerminalFilesOnlyPanelProps) {
  const lifecycle = useProjectedSessionLifecycle(tabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setSidebarView = useAppStore((s) => s.setSidebarView);

  const handleOpenFiles = useCallback(() => {
    const state = useAppStore.getState();
    // The Files sidebar follows the active tab, so make this tab active first.
    const { rootPanel, activePanelId } = getComposedLayout(state);
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf && (leaf.activeTabId !== tabId || activePanelId !== leaf.id)) {
      setActiveTab(tabId, leaf.id);
    }
    // `setSidebarView` toggles an already-open view closed; only call it when
    // the Files view is not already showing.
    if (state.sidebarView !== "files" || state.sidebarCollapsed) {
      setSidebarView("files");
    }
  }, [tabId, setActiveTab, setSidebarView]);

  if (!lifecycle.filesOnly) return null;

  return (
    <div
      className="terminal-disconnect-overlay terminal-disconnect-overlay--files-only"
      data-testid="terminal-files-only-panel"
    >
      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        icon={<FolderOpen size={32} className="terminal-files-only-panel__icon" />}
        heading="This host doesn't allow a shell."
        subheading="Files are available in the sidebar."
        // A state change, announced once through the overlay's live region
        // (#4514) — the wrapper is no longer a live region of its own.
        announce="polite"
        autoFocusPrimaryAction={isActive}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<FolderOpen size={14} />}
            onClick={handleOpenFiles}
            data-testid="terminal-files-only-open-files"
          >
            Open Files
          </Button>
        }
      />
    </div>
  );
}
