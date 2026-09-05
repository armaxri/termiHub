import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { Button, toast } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import type { TunnelConfig, TunnelStatus } from "@/types/tunnel";
import {
  combinedPairStatus,
  findCompanion,
  isCompanionRedundant,
  orderTunnelRows,
} from "@/utils/tunnelChain";
import { TunnelListItem } from "./TunnelListItem";
import "./TunnelSidebar.css";

const DISCONNECTED: TunnelStatus = "disconnected";

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

  // Tunnel pending delete confirmation (active teardown, chained-pair cascade, or
  // a direct companion delete that breaks localhost), or null when idle.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; message: string } | null>(null);

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
      const target = tunnels.find((t) => t.id === tunnelId);
      const name = target?.name ?? "this tunnel";
      const status = tunnelStates[tunnelId]?.status;
      const isActive = !!status && ACTIVE_STATUSES.includes(status);
      const companion = target ? findCompanion(tunnels, tunnelId) : undefined;

      // Deleting a chained companion directly breaks localhost while leaving the
      // agent port running — warn explicitly (#2597 edge case).
      if (target?.companionOf) {
        setPendingDelete({
          id: tunnelId,
          message: `Deleting "${name}" removes the hop on this computer. localhost will stop reaching the port (it still works on the agent). Continue?`,
        });
        return;
      }
      // Deleting a chained parent cascades to its companion — name both.
      if (companion) {
        setPendingDelete({
          id: tunnelId,
          message: `Deleting "${name}" also removes its linked hop "${companion.name}" on this computer. Continue?`,
        });
        return;
      }
      // Deleting an active tunnel silently tears down a live connection — confirm first.
      if (isActive) {
        setPendingDelete({
          id: tunnelId,
          message: `"${name}" is currently active. Deleting it will stop the tunnel. Continue?`,
        });
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

  // Order rows so each chained companion (#2597) renders directly beneath its
  // parent, then flatten to the nav order. Keyboard nav walks the same visible
  // order, including nested companion rows.
  const rows = useMemo(() => orderTunnelRows(tunnels), [tunnels]);
  const rowTunnels = useMemo(() => rows.map((r) => r.tunnel), [rows]);

  // Roving-tabindex keyboard navigation over the flat tunnel list, matching the
  // Connections tree's arrow-key + Enter model. Enter edits the focused tunnel
  // (the same action as double-click).
  const handleActivate = useCallback((tunnel: TunnelConfig) => handleEdit(tunnel.id), [handleEdit]);
  const nav = useFlatRovingNav<TunnelConfig, HTMLDivElement>(
    rowTunnels,
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
          {rows.map(({ tunnel, parent }, index) => {
            const { ref, ...itemProps } = nav.getItemProps(index);
            // A parent's combined pair status folds both live states so the row
            // reads "does localhost:PORT work?" rather than juggling two rows.
            const companion = parent ? undefined : findCompanion(tunnels, tunnel.id);
            const pairStatus = combinedPairStatus(
              tunnelStates[tunnel.id]?.status ?? DISCONNECTED,
              (companion ? tunnelStates[companion.id]?.status : undefined) ?? DISCONNECTED,
              !!companion
            );
            // Combined status the companion row also renders (degraded → inline fix).
            const parentPairStatus = parent
              ? combinedPairStatus(
                  tunnelStates[parent.id]?.status ?? DISCONNECTED,
                  tunnelStates[tunnel.id]?.status ?? DISCONNECTED,
                  true
                )
              : undefined;
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
                nested={!!parent}
                pairStatus={parent ? parentPairStatus : companion ? pairStatus : undefined}
                companionRedundant={!!companion && isCompanionRedundant(tunnel)}
                onRemoveCompanion={companion ? () => handleDelete(companion.id) : undefined}
                rowRef={ref}
                rowProps={itemProps}
              />
            );
          })}
        </div>
      )}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        message={pendingDelete?.message ?? ""}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}
