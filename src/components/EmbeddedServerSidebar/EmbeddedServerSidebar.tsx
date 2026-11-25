import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { Button, ConfirmDialog, toast, EmptyState } from "@/components/ui";
import { onlyHealth, ServiceCounts } from "@/components/ServiceListItem";
import { t, tf } from "@/i18n/catalog";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { EmbeddedServerConfig } from "@/types/embeddedServer";
import { hostChoice, sameHost, type HostChoice } from "@/utils/hostChoice";
import { isServiceActive, serverServiceState } from "@/utils/serviceState";
import { useServiceLifecycleConfirm } from "@/hooks/useServiceLifecycleConfirm";
import { useServiceContext } from "@/hooks/useServiceContext";
import { isWideBind } from "@/utils/serviceAddress";
import { fileServerModel, serviceCounts, type ServiceHealth } from "@/utils/serviceModel";
import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { EmbeddedServerDialog } from "./EmbeddedServerDialog";
import { newId } from "@/services/transport/ids";
import "./EmbeddedServerSidebar.css";
import { errorMessage } from "@/utils/errorMessage";

/** Whether `config` signs clients in with a password (kept in the credential store). */
function hasPassword(config: EmbeddedServerConfig): boolean {
  return !!config.httpAuth || config.ftpAuth?.type === "credentials";
}

/**
 * The file servers: HTTP, FTP and TFTP. Called "File servers" while the tunnels
 * are a sidebar of their own (#6063); Services is both.
 */
export function EmbeddedServerSidebar() {
  const servers = useAppStore((s) => s.embeddedServers);
  const serverStates = useAppStore((s) => s.embeddedServerStates);
  const { remoteAgents: agents } = useProjectedAgents();
  const saveEmbeddedServer = useAppStore((s) => s.saveEmbeddedServer);
  const deleteEmbeddedServer = useAppStore((s) => s.deleteEmbeddedServer);
  const startEmbeddedServer = useAppStore((s) => s.startEmbeddedServer);
  const stopEmbeddedServer = useAppStore((s) => s.stopEmbeddedServer);
  const restartEmbeddedServer = useAppStore((s) => s.restartEmbeddedServer);
  const context = useServiceContext(servers.some((server) => isWideBind(server.bindHost)));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<EmbeddedServerConfig | null>(null);
  // A copy that has to be given its password before it is saved (#6028, F-4).
  const [copyDraft, setCopyDraft] = useState<EmbeddedServerConfig | null>(null);

  // Delete confirmation for a server (running servers are stopped first). The
  // target is the server id; the dialog message depends on the live running
  // state, so that derivation stays caller-side (see `pendingIsRunning`).
  const serverDelete = useDeleteConfirm<string>(async (id) => {
    const name = servers.find((s) => s.id === id)?.name ?? "";
    try {
      await deleteEmbeddedServer(id);
    } catch (err) {
      toast.error(`Failed to delete "${name}"`, {
        description: errorMessage(err),
      });
    }
  });

  const handleNew = useCallback(() => {
    setEditingConfig(null);
    setCopyDraft(null);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback(
    (id: string) => {
      const cfg = servers.find((s) => s.id === id);
      if (cfg) {
        setEditingConfig(cfg);
        setCopyDraft(null);
        setDialogOpen(true);
      }
    },
    [servers]
  );

  /**
   * Persist a server from the dialog. Resolves `true` when the save succeeded
   * (so the dialog closes) and `false` on failure (dialog stays open to retry).
   *
   * The host goes along only when the user chose another machine (#6028): the
   * backend keeps the stored one otherwise, so a list that is out of date in
   * this window cannot move the server.
   */
  const handleSave = useCallback(
    async (config: EmbeddedServerConfig, location: HostChoice): Promise<boolean> => {
      const isNew = !config.id;
      const { host: stored, ...rest } = config;
      const moved = location.kind !== "unreadable" && !sameHost(hostChoice(stored), location);
      const cfg: EmbeddedServerConfig = {
        ...rest,
        ...(isNew ? { id: newId("srv") } : {}),
        ...(location.kind !== "unreadable" && (isNew || moved) ? { host: location } : {}),
      };
      try {
        await saveEmbeddedServer(cfg);
        return true;
      } catch (err) {
        toast.error(`Failed to save "${cfg.name}"`, {
          description: errorMessage(err),
        });
        return false;
      }
    },
    [saveEmbeddedServer]
  );

  const handleDuplicate = useCallback(
    async (id: string) => {
      const original = servers.find((s) => s.id === id);
      if (!original) return;
      const dupe: EmbeddedServerConfig = {
        ...original,
        id: newId("srv"),
        name: `Copy of ${original.name}`,
        autoStart: false,
      };
      // The password stays with the original, so a copy that needs one opens in
      // the editor instead of being saved in a state that cannot start.
      if (hasPassword(original)) {
        setEditingConfig(null);
        setCopyDraft({ ...dupe, id: "" });
        setDialogOpen(true);
        return;
      }
      try {
        await saveEmbeddedServer(dupe);
      } catch (err) {
        toast.error(`Failed to duplicate "${original.name}"`, {
          description: errorMessage(err),
        });
      }
    },
    [servers, saveEmbeddedServer]
  );

  // "Use 8081" beside "Port 8080 is already in use" (#6063).
  const handleUsePort = useCallback(
    async (id: string, port: number) => {
      const server = servers.find((s) => s.id === id);
      if (!server) return;
      // Without the host: the backend keeps the stored one.
      const { host: _stored, ...rest } = server;
      await saveEmbeddedServer({ ...rest, port });
      await startEmbeddedServer(id);
    },
    [servers, saveEmbeddedServer, startEmbeddedServer]
  );

  const models = useMemo(
    () => new Map(servers.map((s) => [s.id, fileServerModel(s, serverStates[s.id], context)])),
    [servers, serverStates, context]
  );
  const lifecycle = useServiceLifecycleConfirm();
  const requestLifecycle = lifecycle.request;
  const modelOf = useCallback(
    (id: string) => models.get(id) ?? { name: "this file server" },
    [models]
  );
  const handleStop = useCallback(
    (id: string) => requestLifecycle("stop", modelOf(id), () => stopEmbeddedServer(id)),
    [requestLifecycle, modelOf, stopEmbeddedServer]
  );
  const handleRestart = useCallback(
    (id: string) => requestLifecycle("restart", modelOf(id), () => restartEmbeddedServer(id)),
    [requestLifecycle, modelOf, restartEmbeddedServer]
  );
  const [only, setOnly] = useState<ServiceHealth | null>(null);
  const shown = useMemo(
    () => onlyHealth(servers, only, (s) => models.get(s.id)?.health ?? "quiet"),
    [servers, only, models]
  );

  // Delete is destructive (and stops a running server), so gate it behind an
  // explicit confirmation — consistent with tunnels and workspaces (#1393).
  const requestDelete = serverDelete.request;
  const handleDelete = useCallback((id: string) => requestDelete(id), [requestDelete]);

  const pendingServer = useMemo(
    () => servers.find((s) => s.id === serverDelete.pending) ?? null,
    [servers, serverDelete.pending]
  );
  const pendingState = serverServiceState(
    serverDelete.pending ? serverStates[serverDelete.pending]?.status : undefined
  );

  // Activating a row (Enter / double-click) opens the server for editing,
  // matching the sibling management sidebars (workspaces, tunnels).
  const handleActivate = useCallback(
    (server: EmbeddedServerConfig) => handleEdit(server.id),
    [handleEdit]
  );
  // Roving-tabindex keyboard navigation + list semantics for the Services list,
  // consistent with the other management sidebars (A11Y-008): the container is a
  // `tree`, each row a `treeitem`, and Arrow/Home/End move between rows so a
  // keyboard user no longer tab-steps through every hidden action button.
  const nav = useFlatRovingNav<EmbeddedServerConfig, HTMLDivElement>(
    shown,
    (server) => server.name,
    handleActivate
  );

  return (
    <div className="server-sidebar" data-testid="server-sidebar">
      <SidebarToolbar
        aria-label="File server actions"
        actions={[
          {
            id: "new",
            label: "New file server",
            icon: <Plus size={14} />,
            onClick: handleNew,
            primary: true,
            testId: "server-new-btn",
          },
        ]}
      />

      {servers.length === 0 ? (
        <EmptyState
          className="service-empty"
          title={t("server.empty.title")}
          description={t("server.empty.text")}
          action={
            <Button variant="secondary" size="sm" onClick={handleNew}>
              New file server
            </Button>
          }
          data-testid="server-empty-message"
        />
      ) : (
        <>
          <ServiceCounts
            counts={serviceCounts([...models.values()])}
            only={only}
            onOnly={setOnly}
            data-testid="server-counts"
          />
          <div
            className="server-sidebar__list"
            data-testid="server-list"
            role="tree"
            aria-label="File servers"
            onKeyDown={nav.onKeyDown}
          >
            {shown.map((cfg, index) => {
              const { ref, ...rowProps } = nav.getItemProps(index);
              return (
                <EmbeddedServerItem
                  key={cfg.id}
                  config={cfg}
                  state={serverStates[cfg.id]}
                  agents={agents}
                  context={context}
                  onStart={startEmbeddedServer}
                  onStop={handleStop}
                  onRestart={handleRestart}
                  onEdit={handleEdit}
                  onDuplicate={handleDuplicate}
                  onDelete={handleDelete}
                  onUsePort={handleUsePort}
                  rowRef={ref}
                  rowProps={rowProps}
                />
              );
            })}
          </div>
        </>
      )}

      <EmbeddedServerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        config={editingConfig}
        onSave={handleSave}
        agents={agents}
        draft={copyDraft}
        running={
          !!editingConfig &&
          isServiceActive(serverServiceState(serverStates[editingConfig.id]?.status))
        }
        runLocation={hostChoice((editingConfig ?? copyDraft)?.host)}
      />

      <ConfirmDialog
        {...lifecycle.dialogProps}
        variant="danger"
        confirmVariant="danger"
        testIdBase="confirm-service-lifecycle"
        data-testid="confirm-service-lifecycle-dialog"
      />
      <ConfirmDialog
        {...serverDelete.dialogProps}
        variant="danger"
        confirmVariant="danger"
        title={tf("service.delete.title", { name: pendingServer?.name ?? "" })}
        message={[
          pendingState === "notReachable"
            ? t("service.delete.notReachable")
            : isServiceActive(pendingState)
              ? t("service.delete.running")
              : t("service.delete.idle"),
          t("service.delete.noUndo"),
        ].join(" ")}
        confirmLabel="Delete"
        data-testid="server-delete-confirm"
      />
    </div>
  );
}
