import { useCallback, useMemo } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Toggle, toast } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import type { TunnelConfig } from "@/types/tunnel";
import {
  tunnelDeleteConfirmMessage,
  tunnelPortMapping,
  tunnelTypeFlag,
} from "@/utils/tunnelSummary";
import { errorMessage } from "@/utils/errorMessage";

interface ConnectionPortForwardingSectionProps {
  /**
   * Id of the saved SSH connection being edited, or `undefined` for a
   * connection that has not been saved yet (a tunnel can only reference a
   * saved connection, so the section asks the user to save first).
   */
  connectionId: string | undefined;
}

/**
 * "Port Forwarding" section of the SSH connection editor (PROD-023).
 *
 * Lists the tunnels bound to this connection (`TunnelConfig.sshConnectionId`)
 * — the **same** tunnel entities the Tunnels sidebar shows, read from the
 * backend-authoritative `tunnels` projection; there is no second store. Add and
 * Edit open the regular Tunnel editor (pre-bound to this connection for a new
 * forward) so validation, run-location and chaining stay in one place; Remove
 * reuses the sidebar's delete confirmation rules; the per-row "Start with
 * connection" toggle binds the forward to this connection's sessions, which
 * start it when a terminal to the host connects.
 *
 * Changes here apply immediately (tunnels are their own saved objects), not on
 * the connection editor's Save.
 */
export function ConnectionPortForwardingSection({
  connectionId,
}: ConnectionPortForwardingSectionProps) {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const deleteTunnel = useAppStore((s) => s.deleteTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);

  const bound = useMemo(
    () => (connectionId ? tunnels.filter((t) => t.sshConnectionId === connectionId) : []),
    [tunnels, connectionId]
  );

  const tunnelDelete = useDeleteConfirm<{ id: string; message: string }>(({ id }) => {
    void deleteTunnel(id).catch(() => {
      // `deleteTunnel` owns its error toast.
    });
  });
  const requestDelete = tunnelDelete.request;

  const handleRemove = useCallback(
    (tunnelId: string) => {
      const message = tunnelDeleteConfirmMessage(tunnels, tunnelStates, tunnelId);
      if (message) {
        requestDelete({ id: tunnelId, message });
        return;
      }
      void deleteTunnel(tunnelId).catch(() => {
        // `deleteTunnel` owns its error toast.
      });
    },
    [tunnels, tunnelStates, deleteTunnel, requestDelete]
  );

  const handleStartWithConnection = useCallback(
    (tunnel: TunnelConfig, startWithConnection: boolean) => {
      saveTunnel({ ...tunnel, startWithConnection }).catch((err: unknown) =>
        toast.error(`Failed to update "${tunnel.name}"`, { description: errorMessage(err) })
      );
    },
    [saveTunnel]
  );

  return (
    <div className="settings-panel__category" data-testid="connection-port-forwarding-section">
      <h3 className="settings-panel__category-title">Port Forwarding</h3>
      {!connectionId ? (
        <p className="settings-form__hint" data-testid="connection-port-forwarding-unsaved">
          Save this connection first, then attach local (<code>-L</code>), remote (<code>-R</code>)
          or dynamic SOCKS (<code>-D</code>) forwards to it.
        </p>
      ) : (
        <>
          <p className="settings-form__hint">
            Forwards bound to this connection. They are the same tunnels listed in the Tunnels
            sidebar, and changes here apply immediately. Forwards marked “Start with connection”
            come up whenever a terminal to this host connects.
          </p>
          {bound.length === 0 ? (
            <p
              className="settings-form__hint port-forwarding__empty"
              data-testid="connection-port-forwarding-empty"
            >
              No port forwards are attached to this connection yet.
            </p>
          ) : (
            <ul className="port-forwarding__list">
              {bound.map((tunnel) => {
                const toggleId = `port-forward-start-${tunnel.id}`;
                const status = tunnelStates[tunnel.id]?.status ?? "disconnected";
                return (
                  <li
                    key={tunnel.id}
                    className="port-forwarding__row"
                    data-testid={`port-forward-row-${tunnel.id}`}
                  >
                    <div className="port-forwarding__info">
                      <span className="port-forwarding__name">{tunnel.name}</span>
                      <span className="port-forwarding__mapping">
                        <code>{tunnelTypeFlag(tunnel)}</code> {tunnelPortMapping(tunnel)}
                      </span>
                      <span
                        className="port-forwarding__status"
                        data-testid={`port-forward-status-${tunnel.id}`}
                      >
                        {status}
                      </span>
                    </div>
                    <div className="port-forwarding__actions">
                      {tunnel.companionOf ? (
                        <span className="settings-form__hint">Follows its chained parent</span>
                      ) : (
                        <label className="port-forwarding__toggle" htmlFor={toggleId}>
                          <Toggle
                            id={toggleId}
                            checked={tunnel.startWithConnection === true}
                            onCheckedChange={(checked) =>
                              handleStartWithConnection(tunnel, checked)
                            }
                            data-testid={`port-forward-start-with-connection-${tunnel.id}`}
                          />
                          Start with connection
                        </label>
                      )}
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        aria-label={`Edit ${tunnel.name}`}
                        icon={<Pencil size={12} />}
                        onClick={() => openTunnelEditorTab(tunnel.id)}
                        data-testid={`port-forward-edit-${tunnel.id}`}
                      />
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        aria-label={`Remove ${tunnel.name}`}
                        icon={<Trash2 size={12} />}
                        onClick={() => handleRemove(tunnel.id)}
                        data-testid={`port-forward-remove-${tunnel.id}`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} aria-hidden />}
            onClick={() => openTunnelEditorTab(null, { sshConnectionId: connectionId })}
            data-testid="connection-port-forwarding-add"
          >
            Add port forward
          </Button>
        </>
      )}
      <ConfirmDeleteDialog
        {...tunnelDelete.dialogProps}
        message={tunnelDelete.pending?.message ?? ""}
      />
    </div>
  );
}
