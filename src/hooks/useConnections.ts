import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { SavedConnection, ConnectionFolder } from "@/types/connection";

/**
 * Hook for connection management operations.
 * Phase 1: Uses in-memory store. Phase 4 will add persistence.
 */
export function useConnections() {
  const connections = useAppStore((s) => s.connections);
  const folders = useAppStore((s) => s.folders);
  const addConnection = useAppStore((s) => s.addConnection);
  const updateConnection = useAppStore((s) => s.updateConnection);
  const deleteConnection = useAppStore((s) => s.deleteConnection);
  const addFolder = useAppStore((s) => s.addFolder);
  const toggleFolder = useAppStore((s) => s.toggleFolder);

  const createConnection = useCallback(
    (connection: Omit<SavedConnection, "id">) => {
      addConnection({ ...connection, id: `conn-${Date.now()}` });
    },
    [addConnection]
  );

  const createFolder = useCallback(
    (name: string, parentId: string | null) => {
      const folder: ConnectionFolder = {
        id: `folder-${Date.now()}`,
        name,
        parentId,
        isExpanded: true,
      };
      addFolder(folder);
    },
    [addFolder]
  );

  return {
    connections,
    folders,
    createConnection,
    updateConnection,
    deleteConnection,
    createFolder,
    toggleFolder,
  };
}
