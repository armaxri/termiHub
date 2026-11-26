import { useCallback } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, ConfirmDialog, EmptyState, Toggle, toast } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { TunnelListItem } from "@/components/ServicesSidebar/TunnelListItem";
import { useServiceEntries } from "@/components/ServicesSidebar/useServiceEntries";
import { useTunnelActions } from "@/components/ServicesSidebar/useTunnelActions";
import { showServicesView } from "@/components/ServicesSidebar/servicesView";
import { useServiceLifecycleConfirm } from "@/hooks/useServiceLifecycleConfirm";
import { t, tf } from "@/i18n/catalog";
import type { TunnelConfig } from "@/types/tunnel";
import { errorMessage } from "@/utils/errorMessage";
import { TUNNEL_TYPE_KINDS, tunnelTypeHelp } from "@/utils/tunnelTypeHelp";

interface ConnectionPortForwardingSectionProps {
  /**
   * Id of the saved SSH connection being edited, or `undefined` for a
   * connection that has not been saved yet (a tunnel can only reference a
   * saved connection, so the section asks the user to save first).
   */
  connectionId: string | undefined;
}

/**
 * The tunnels of an SSH connection in its editor (PROD-023; #6028, slice 13).
 *
 * A view of the same tunnels as Services, with the same rows, words, actions
 * and editor: each row is the Services row, its buttons do what they do there,
 * and New tunnel opens the tunnel editor with this connection chosen. Only
 * "Start with connection" is this section's own, because it is about this
 * connection. Show in Services opens the Services view.
 *
 * Changes apply at once (tunnels are their own saved objects), not on the
 * connection editor's Save.
 */
export function ConnectionPortForwardingSection({
  connectionId,
}: ConnectionPortForwardingSectionProps) {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);
  const { entries, context } = useServiceEntries(true);
  const bound = connectionId
    ? tunnels.filter((tunnel) => tunnel.sshConnectionId === connectionId)
    : [];

  const modelOf = useCallback(
    (id: string) =>
      entries.find((entry) => entry.model.id === id)?.model ?? { name: t("service.unnamed") },
    [entries]
  );
  const lifecycle = useServiceLifecycleConfirm();
  const actions = useTunnelActions(modelOf, lifecycle.request);

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
      <h3 className="settings-panel__category-title">{t("service.group.tunnels")}</h3>
      {!connectionId ? (
        <div className="settings-form__hint" data-testid="connection-port-forwarding-unsaved">
          <p className="port-forwarding__types-intro">{t("connection.tunnels.unsaved")}</p>
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
            {t("connection.tunnels.hint")}{" "}
            <button
              type="button"
              className="port-forwarding__link"
              onClick={showServicesView}
              data-testid="connection-port-forwarding-show-services"
            >
              {t("connection.tunnels.showServices")}
            </button>
          </p>
          {bound.length === 0 ? (
            <EmptyState
              title={t("connection.tunnels.none")}
              data-testid="connection-port-forwarding-empty"
            />
          ) : (
            <ul className="port-forwarding__list" aria-label={t("service.group.tunnels")}>
              {bound.map((tunnel) => {
                const toggleId = `port-forward-start-${tunnel.id}`;
                return (
                  <li key={tunnel.id} className="port-forwarding__row">
                    <TunnelListItem
                      tunnel={tunnel}
                      state={tunnelStates[tunnel.id]}
                      context={context}
                      onStart={actions.start}
                      onStop={actions.stop}
                      onReconnect={actions.restart}
                      onEdit={actions.edit}
                      onActivity={actions.activity}
                      onDuplicate={actions.duplicate}
                      onDelete={actions.remove}
                      onUsePort={actions.usePort}
                    />
                    {tunnel.companionOf ? (
                      <span className="settings-form__hint port-forwarding__start">
                        {t("connection.tunnels.followsParent")}
                      </span>
                    ) : (
                      <label className="port-forwarding__start" htmlFor={toggleId}>
                        <Toggle
                          id={toggleId}
                          checked={tunnel.startWithConnection === true}
                          onCheckedChange={(checked) => handleStartWithConnection(tunnel, checked)}
                          aria-label={tf("connection.tunnels.startWith", { name: tunnel.name })}
                          data-testid={`port-forward-start-with-connection-${tunnel.id}`}
                        />
                        {t("connection.tunnels.startWithShort")}
                      </label>
                    )}
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
            {t("connection.tunnels.new")}
          </Button>
        </>
      )}
      <ConfirmDialog
        {...lifecycle.dialogProps}
        variant="danger"
        confirmVariant="danger"
        testIdBase="confirm-service-lifecycle"
        data-testid="confirm-service-lifecycle-dialog"
      />
      <ConfirmDeleteDialog {...actions.deleteDialogProps} />
    </div>
  );
}
