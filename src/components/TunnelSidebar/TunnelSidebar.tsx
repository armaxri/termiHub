import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, toast, ConfirmDialog, EmptyState } from "@/components/ui";
import { onlyHealth, ServiceCounts } from "@/components/ServiceListItem";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useServiceLifecycleConfirm } from "@/hooks/useServiceLifecycleConfirm";
import { useServiceContext } from "@/hooks/useServiceContext";
import { useTunnelDeleteConfirm } from "@/hooks/useTunnelDeleteConfirm";
import type { TunnelConfig, TunnelStatus } from "@/types/tunnel";
import {
  combinedPairStatus,
  findCompanion,
  isCompanionRedundant,
  orderTunnelRows,
} from "@/utils/tunnelChain";
import { isWideBind } from "@/utils/serviceAddress";
import { serviceCounts, tunnelModel, type ServiceHealth } from "@/utils/serviceModel";
import { TunnelListItem } from "./TunnelListItem";
import { newId } from "@/services/transport/ids";
import "./TunnelSidebar.css";
import { t } from "@/i18n/catalog";
import { errorMessage } from "@/utils/errorMessage";

const DISCONNECTED: TunnelStatus = "disconnected";

/** `tunnel`, listening on another port. */
function withLocalPort(tunnel: TunnelConfig, localPort: number): TunnelConfig {
  const { tunnelType } = tunnel;
  switch (tunnelType.type) {
    case "local":
      return {
        ...tunnel,
        tunnelType: { type: "local", config: { ...tunnelType.config, localPort } },
      };
    case "dynamic":
      return {
        ...tunnel,
        tunnelType: { type: "dynamic", config: { ...tunnelType.config, localPort } },
      };
    case "remote":
      return tunnel;
  }
}

export function TunnelSidebar() {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const needsNetwork = tunnels.some(
    (tunnel) =>
      tunnel.tunnelType.type !== "remote" && isWideBind(tunnel.tunnelType.config.localHost)
  );
  const context = useServiceContext(needsNetwork);
  const startTunnel = useAppStore((s) => s.startTunnel);
  const stopTunnel = useAppStore((s) => s.stopTunnel);
  const reconnectTunnel = useAppStore((s) => s.reconnectTunnel);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);

  // Confirm + Undo for a tunnel delete, shared with the connection editor's
  // Port Forwarding section (#5158, #5216).
  const tunnelDelete = useTunnelDeleteConfirm();
  const models = useMemo(
    () =>
      new Map(
        tunnels.map((tunnel) => [tunnel.id, tunnelModel(tunnel, tunnelStates[tunnel.id], context)])
      ),
    [tunnels, tunnelStates, context]
  );
  const modelOf = useCallback(
    (tunnelId: string) => models.get(tunnelId) ?? { name: "this tunnel" },
    [models]
  );
  const lifecycle = useServiceLifecycleConfirm();
  const requestLifecycle = lifecycle.request;

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
      const original = tunnels.find((tunnel) => tunnel.id === tunnelId);
      if (!original) return;
      // A copy keeps where it runs, and is its own tunnel: it starts by hand and
      // is not a second hop of the original's parent (#6028, F-4).
      const { companionOf: _chain, ...rest } = original;
      const duplicate = {
        ...rest,
        id: newId("tun"),
        name: `Copy of ${original.name}`,
        autoStart: false,
        startWithConnection: false,
      };
      // The copy's row is the confirmation (#5859).
      saveTunnel(duplicate).catch((err: unknown) =>
        toast.error(`Failed to duplicate "${original.name}"`, {
          description: errorMessage(err),
        })
      );
    },
    [tunnels, saveTunnel]
  );

  const handleDelete = tunnelDelete.requestDelete;

  // "Use 8081" beside "Port 8080 is already in use" (#6063).
  const handleUsePort = useCallback(
    async (tunnelId: string, port: number) => {
      const tunnel = tunnels.find((item) => item.id === tunnelId);
      if (!tunnel) return;
      try {
        await saveTunnel(withLocalPort(tunnel, port));
      } catch (err) {
        toast.error(`Failed to change the port of "${tunnel.name}"`, {
          description: errorMessage(err),
        });
        return;
      }
      await startTunnel(tunnelId);
    },
    [tunnels, saveTunnel, startTunnel]
  );

  const handleStop = useCallback(
    (tunnelId: string) => requestLifecycle("stop", modelOf(tunnelId), () => stopTunnel(tunnelId)),
    [requestLifecycle, modelOf, stopTunnel]
  );

  const handleReconnect = useCallback(
    (tunnelId: string) =>
      requestLifecycle("restart", modelOf(tunnelId), () => reconnectTunnel(tunnelId)),
    [requestLifecycle, modelOf, reconnectTunnel]
  );

  // Order rows so each chained companion (#2597) renders directly beneath its
  // parent, then flatten to the nav order. Keyboard nav walks the same visible
  // order, including nested companion rows.
  const rows = useMemo(() => orderTunnelRows(tunnels), [tunnels]);
  const [only, setOnly] = useState<ServiceHealth | null>(null);
  const healthOf = useCallback(
    (tunnel: TunnelConfig): ServiceHealth => models.get(tunnel.id)?.health ?? "quiet",
    [models]
  );
  const shown = useMemo(
    () => onlyHealth(rows, only, ({ tunnel }) => healthOf(tunnel)),
    [rows, only, healthOf]
  );
  const rowTunnels = useMemo(() => shown.map((r) => r.tunnel), [shown]);

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
      <SidebarToolbar
        aria-label="Tunnel actions"
        actions={[
          {
            id: "new",
            label: "New tunnel",
            icon: <Plus size={14} />,
            onClick: handleNew,
            primary: true,
            testId: "tunnel-new-btn",
          },
        ]}
      />
      {tunnels.length === 0 ? (
        <EmptyState
          className="service-empty"
          title={t("tunnel.empty.title")}
          description={t("tunnel.empty.text")}
          action={
            <Button variant="secondary" size="sm" onClick={handleNew}>
              New tunnel
            </Button>
          }
          data-testid="tunnel-empty-message"
        />
      ) : (
        <>
          <ServiceCounts
            counts={serviceCounts([...models.values()])}
            only={only}
            onOnly={setOnly}
            data-testid="tunnel-counts"
          />
          <div
            className="tunnel-sidebar__list"
            data-testid="tunnel-list"
            role="tree"
            aria-label="SSH tunnels"
            onKeyDown={nav.onKeyDown}
          >
            {shown.map(({ tunnel, parent }, index) => {
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
                  context={context}
                  onStart={startTunnel}
                  onStop={handleStop}
                  onReconnect={handleReconnect}
                  onEdit={handleEdit}
                  onDuplicate={handleDuplicate}
                  onDelete={handleDelete}
                  onUsePort={handleUsePort}
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
        </>
      )}
      <ConfirmDeleteDialog {...tunnelDelete.dialogProps} />
      <ConfirmDialog
        {...lifecycle.dialogProps}
        variant="danger"
        confirmVariant="danger"
        testIdBase="confirm-service-lifecycle"
        data-testid="confirm-service-lifecycle-dialog"
      />
    </div>
  );
}
