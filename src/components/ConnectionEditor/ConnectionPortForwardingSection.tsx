import { useCallback, useMemo } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Toggle, Tooltip, TooltipLines, toast, EmptyState } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { useTunnelDeleteConfirm } from "@/hooks/useTunnelDeleteConfirm";
import type { TunnelConfig } from "@/types/tunnel";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { isAgentHost, resolveTunnelHost } from "@/utils/tunnelHost";
import { tunnelPortMapping } from "@/utils/tunnelSummary";
import { TUNNEL_TYPE_KINDS, tunnelTypeHelp } from "@/utils/tunnelTypeHelp";
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
 * Each forward says in plain words what its type does (#6027); the longer
 * explanation is the type's tooltip and part of its Edit button's description.
 *
 * The hint names the SSH Tunnels sidebar, which is always available since it
 * graduated from the experimental switch (#5858).
 */
export function ConnectionPortForwardingSection({
  connectionId,
}: ConnectionPortForwardingSectionProps) {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);
  const { remoteAgents } = useProjectedAgents();

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
        <div className="settings-form__hint" data-testid="connection-port-forwarding-unsaved">
          <p className="port-forwarding__types-intro">
            Save this connection first, then attach port forwards to it:
          </p>
          <ul className="port-forwarding__types">
            {TUNNEL_TYPE_KINDS.map((kind) => {
              const help = tunnelTypeHelp(kind);
              return (
                <li key={kind}>
                  {help.label} (<code>{help.flag}</code>): {help.summary}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <>
          <p className="settings-form__hint" data-testid="connection-port-forwarding-hint">
            Forwards bound to this connection. They are the same tunnels listed in the SSH Tunnels
            sidebar, and changes here apply immediately. Forwards marked “Start with connection”
            come up whenever a terminal to this host connects.
          </p>
          {bound.length === 0 ? (
            <EmptyState
              title="No port forwards are attached to this connection yet."
              data-testid="connection-port-forwarding-empty"
            />
          ) : (
            <ul className="port-forwarding__list">
              {bound.map((tunnel) => {
                const toggleId = `port-forward-start-${tunnel.id}`;
                const helpId = `port-forward-help-${tunnel.id}`;
                const status = tunnelStates[tunnel.id]?.status ?? "disconnected";
                const host = resolveTunnelHost(tunnel);
                const agentName = isAgentHost(host)
                  ? remoteAgents.find((a) => a.id === host.agentId)?.name
                  : undefined;
                const help = tunnelTypeHelp(tunnel.tunnelType.type, host, agentName);
                return (
                  <li
                    key={tunnel.id}
                    className="port-forwarding__row"
                    data-testid={`port-forward-row-${tunnel.id}`}
                  >
                    <div className="port-forwarding__info">
                      <span className="port-forwarding__name">{tunnel.name}</span>
                      <span className="port-forwarding__mapping">
                        <Tooltip
                          content={<TooltipLines lines={help.lines} />}
                          side="top"
                          align="start"
                          data-testid={`port-forward-type-help-${tunnel.id}`}
                        >
                          <span
                            className="port-forwarding__type"
                            data-testid={`port-forward-type-${tunnel.id}`}
                          >
                            {help.label} (<code>{help.flag}</code>)
                          </span>
                        </Tooltip>{" "}
                        · {tunnelPortMapping(tunnel)}
                      </span>
                      <span className="port-forwarding__summary">{help.summary}</span>
                      <span id={helpId} hidden>
                        {help.lines.join(" ")}
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
                        aria-describedby={helpId}
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
