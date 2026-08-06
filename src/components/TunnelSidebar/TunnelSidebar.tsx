import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { Button, toast } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import type { TunnelConfig, TunnelStatus } from "@/types/tunnel";
import { TunnelListItem } from "./TunnelListItem";
import "./TunnelSidebar.css";

/** Tunnel statuses that count as "active" — deleting one tears down a live connection. */
const ACTIVE_STATUSES: readonly TunnelStatus[] = ["connecting", "connected", "reconnecting"];

export function TunnelSidebar() {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const { connections } = useProjectedConnections();
  const startTunnel = useAppStore((s) => s.startTunnel);
  const stopTunnel = useAppStore((s) => s.stopTunnel);
  const reconnectTunnel = useAppStore((s) => s.reconnectTunnel);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const deleteTunnel = useAppStore((s) => s.deleteTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);

  // Tunnel pending confirmation before an active-tunnel delete, or null when idle.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

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
      saveTunnel(duplicate)
        .then(() => toast.success(`Duplicated "${original.name}"`))
        .catch((err: unknown) =>
          toast.error(`Failed to duplicate "${original.name}"`, {
            description: err instanceof Error ? err.message : String(err),
          })
        );
    },
    [tunnels, saveTunnel]
  );

  const handleDelete = useCallback(
    (tunnelId: string) => {
      const status = tunnelStates[tunnelId]?.status;
      // Deleting an active tunnel silently tears down a live connection — confirm first.
      if (status && ACTIVE_STATUSES.includes(status)) {
        const name = tunnels.find((t) => t.id === tunnelId)?.name ?? "this tunnel";
        setPendingDelete({ id: tunnelId, name });
        return;
      }
      void deleteTunnel(tunnelId);
    },
    [tunnelStates, tunnels, deleteTunnel]
  );

  const confirmDelete = useCallback(() => {
    if (pendingDelete) {
      void deleteTunnel(pendingDelete.id);
      setPendingDelete(null);
    }
  }, [pendingDelete, deleteTunnel]);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  // Roving-tabindex keyboard navigation over the flat tunnel list, matching the
  // Connections tree's arrow-key + Enter model. Enter edits the focused tunnel
  // (the same action as double-click).
  const handleActivate = useCallback((tunnel: TunnelConfig) => handleEdit(tunnel.id), [handleEdit]);
  const nav = useFlatRovingNav<TunnelConfig, HTMLDivElement>(
    tunnels,
    (tunnel) => tunnel.name,
    handleActivate
  );

  return (
    <div className="tunnel-sidebar" data-testid="tunnel-sidebar">
      <div className="tunnel-sidebar__actions">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          onClick={handleNew}
          title="New Tunnel"
          data-testid="tunnel-new-btn"
        >
          New Tunnel
        </Button>
      </div>
      {tunnels.length === 0 ? (
        <div className="tunnel-sidebar__empty" data-testid="tunnel-empty-message">
          <span>No SSH tunnels configured.</span>
          <span>Click &quot;+ New Tunnel&quot; to create one.</span>
        </div>
      ) : (
        <div
          className="tunnel-sidebar__list"
          data-testid="tunnel-list"
          role="tree"
          aria-label="SSH tunnels"
          onKeyDown={nav.onKeyDown}
        >
          {tunnels.map((tunnel, index) => {
            const { ref, ...itemProps } = nav.getItemProps(index);
            return (
              <TunnelListItem
                key={tunnel.id}
                tunnel={tunnel}
                state={tunnelStates[tunnel.id]}
                connections={connections}
                onStart={startTunnel}
                onStop={stopTunnel}
                onReconnect={reconnectTunnel}
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                rowRef={ref}
                rowProps={itemProps}
              />
            );
          })}
        </div>
      )}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        message={
          pendingDelete
            ? `"${pendingDelete.name}" is currently active. Deleting it will stop the tunnel. Continue?`
            : ""
        }
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}
