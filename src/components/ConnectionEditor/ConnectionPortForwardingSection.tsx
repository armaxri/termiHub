import { useCallback, useMemo } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Toggle, toast, EmptyState } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { useTunnelDeleteConfirm } from "@/hooks/useTunnelDeleteConfirm";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { ExperimentalSettingLink } from "@/components/Settings/ExperimentalSettingLink";
import type { TunnelConfig } from "@/types/tunnel";
import { tunnelPortMapping, tunnelTypeFlag } from "@/utils/tunnelSummary";
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
 * — the **same** tunnel entities the SSH Tunnels sidebar shows, read from the
 * backend-authoritative `tunnels` projection; there is no second store. Add and
 * Edit open the regular Tunnel editor (pre-bound to this connection for a new
 * forward) so validation, run-location and chaining stay in one place; Remove
 * shares the sidebar's delete flow (confirm, "don't ask again" opt-out and the
 * 10 s Undo, #5216); the per-row "Start with
 * connection" toggle binds the forward to this connection's sessions, which
 * start it when a terminal to the host connects.
 *
 * Changes here apply immediately (tunnels are their own saved objects), not on
 * the connection editor's Save.
 *
 * The SSH Tunnels sidebar is experimental: the hint names it only while
 * experimental features are on, and otherwise links to the toggle (#5363).
 */
export function ConnectionPortForwardingSection({
  connectionId,
}: ConnectionPortForwardingSectionProps) {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);
  const experimental = useExperimentalFeatures();

  const bound = useMemo(
    () => (connectionId ? tunnels.filter((t) => t.sshConnectionId === connectionId) : []),
    [tunnels, connectionId]
  );

  // Same confirm + opt-out + 10 s Undo as the Tunnels sidebar (#5216).
  const tunnelDelete = useTunnelDeleteConfirm();
  const handleRemove = tunnelDelete.requestDelete;

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
          {experimental ? (
            <p className="settings-form__hint" data-testid="connection-port-forwarding-hint">
              Forwards bound to this connection. They are the same tunnels listed in the SSH Tunnels
              sidebar, and changes here apply immediately. Forwards marked “Start with connection”
              come up whenever a terminal to this host connects.
            </p>
          ) : (
            // The SSH Tunnels sidebar is experimental and hidden while the gate is off,
            // so point at the toggle instead of a sidebar the user cannot see (#5363).
            <p className="settings-form__hint" data-testid="connection-port-forwarding-hint">
              Forwards bound to this connection. Changes here apply immediately. Forwards marked
              “Start with connection” come up whenever a terminal to this host connects. To also see
              all tunnels in an SSH Tunnels sidebar, turn on{" "}
              <ExperimentalSettingLink data-testid="connection-port-forwarding-experimental-link" />
              .
            </p>
          )}
          {bound.length === 0 ? (
            <EmptyState
              title="No port forwards are attached to this connection yet."
              data-testid="connection-port-forwarding-empty"
            />
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
      <ConfirmDeleteDialog {...tunnelDelete.dialogProps} />
    </div>
  );
}
