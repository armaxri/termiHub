import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { ConnectionType, ConnectionConfig } from "@/types/terminal";

/**
 * Hook for terminal operations.
 */
export function useTerminal() {
  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const openTerminal = useCallback(
    (title: string, connectionType: ConnectionType, config?: ConnectionConfig, panelId?: string) => {
      addTab(title, connectionType, config, panelId);
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
