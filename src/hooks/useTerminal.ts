import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { ConnectionType } from "@/types/terminal";

/**
 * Hook for terminal operations.
 * Phase 1: Uses mock local echo. Phase 2 will wire to Tauri backend.
 */
export function useTerminal() {
  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const openTerminal = useCallback(
    (title: string, connectionType: ConnectionType, panelId?: string) => {
      addTab(title, connectionType, panelId);
    },
    [addTab]
  );

  const closeTerminal = useCallback(
    (tabId: string, panelId: string) => {
      closeTab(tabId, panelId);
    },
    [closeTab]
  );

  const activateTerminal = useCallback(
    (tabId: string, panelId: string) => {
      setActiveTab(tabId, panelId);
    },
    [setActiveTab]
  );

  return { openTerminal, closeTerminal, activateTerminal };
}
