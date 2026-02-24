import { useCallback } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { TunnelListItem } from "./TunnelListItem";
import "./TunnelSidebar.css";

export function TunnelSidebar() {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const connections = useAppStore((s) => s.connections);
  const startTunnel = useAppStore((s) => s.startTunnel);
  const stopTunnel = useAppStore((s) => s.stopTunnel);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const deleteTunnel = useAppStore((s) => s.deleteTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);

  const handleNew = useCallback(() => {
    openTunnelEditorTab(null);
  }, [openTunnelEditorTab]);

  const handleEdit = useCallback(
    (tunnelId: string) => {
      openTunnelEditorTab(tunnelId);
    },
    [openTunnelEditorTab]
  );

  const handleDuplicate = useCallback(
    (tunnelId: string) => {
      const original = tunnels.find((t) => t.id === tunnelId);
      if (!original) return;
      const duplicate = {
        ...original,
        id: `tun-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Copy of ${original.name}`,
        autoStart: false,
      };
      saveTunnel(duplicate).catch((err) => console.error("Failed to duplicate tunnel:", err));
    },
    [tunnels, saveTunnel]
  );

  const handleDelete = useCallback(
    (tunnelId: string) => {
      deleteTunnel(tunnelId);
    },
    [deleteTunnel]
  );

  return (
    <div className="tunnel-sidebar" data-testid="tunnel-sidebar">
      <div className="tunnel-sidebar__actions">
        <button
          className="tunnel-sidebar__add-btn"
          onClick={handleNew}
          title="New Tunnel"
          data-testid="tunnel-new-btn"
        >
          <Plus size={14} />
          New Tunnel
        </button>
      </div>
      {tunnels.length === 0 ? (
        <div className="tunnel-sidebar__empty" data-testid="tunnel-empty-message">
          <span>No SSH tunnels configured.</span>
          <span>Click &quot;+ New Tunnel&quot; to create one.</span>
        </div>
      ) : (
        <div className="tunnel-sidebar__list" data-testid="tunnel-list">
          {tunnels.map((tunnel) => (
            <TunnelListItem
              key={tunnel.id}
              tunnel={tunnel}
              state={tunnelStates[tunnel.id]}
              connections={connections}
              onStart={startTunnel}
              onStop={stopTunnel}
              onEdit={handleEdit}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
