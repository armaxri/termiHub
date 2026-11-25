import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { ConfirmDialog, toast, EmptyState } from "@/components/ui";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { EmbeddedServerConfig } from "@/types/embeddedServer";
import { hostChoice, sameHost, type HostChoice } from "@/utils/hostChoice";
import { isServiceActive, serverServiceState } from "@/utils/serviceState";
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
 * Services sidebar panel for managing embedded HTTP/FTP/TFTP servers.
 */
export function EmbeddedServerSidebar() {
  const servers = useAppStore((s) => s.embeddedServers);
  const serverStates = useAppStore((s) => s.embeddedServerStates);
  const { remoteAgents: agents } = useProjectedAgents();
  const saveEmbeddedServer = useAppStore((s) => s.saveEmbeddedServer);
  const deleteEmbeddedServer = useAppStore((s) => s.deleteEmbeddedServer);
  const startEmbeddedServer = useAppStore((s) => s.startEmbeddedServer);
  const stopEmbeddedServer = useAppStore((s) => s.stopEmbeddedServer);
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
    servers,
    (server) => server.name,
    handleActivate
  );

  return (
    <div className="server-sidebar" data-testid="server-sidebar">
      <SidebarToolbar
        aria-label="Service actions"
        actions={[
          {
            id: "new",
            label: "New service",
            icon: <Plus size={14} />,
            onClick: handleNew,
            primary: true,
            testId: "server-new-btn",
          },
        ]}
      />

      {servers.length === 0 ? (
        <EmptyState
          title="No services configured."
          description={<>Click &quot;+ New service&quot; to add one.</>}
          data-testid="server-empty-message"
        />
      ) : (
        <div
          className="server-sidebar__list"
          data-testid="server-list"
          role="tree"
          aria-label="Services"
          onKeyDown={nav.onKeyDown}
        >
          {servers.map((cfg, index) => {
            const { ref, ...rowProps } = nav.getItemProps(index);
            return (
              <EmbeddedServerItem
                key={cfg.id}
                config={cfg}
                state={serverStates[cfg.id]}
                agents={agents}
                runLocation={hostChoice(cfg.host)}
                onStart={startEmbeddedServer}
                onStop={stopEmbeddedServer}
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                rowRef={ref}
                rowProps={rowProps}
              />
            );
          })}
        </div>
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
        {...serverDelete.dialogProps}
        title="Delete service"
        message={
          pendingState === "notReachable"
            ? `"${pendingServer?.name}" may still run on its agent, which is offline. Deleting it stops it there as soon as the agent is connected again. This cannot be undone.`
            : isServiceActive(pendingState)
              ? `This will stop and delete the running server "${pendingServer?.name}". This cannot be undone.`
              : `Delete "${pendingServer?.name}"? This cannot be undone.`
        }
        confirmLabel="Delete"
        data-testid="server-delete-confirm"
      />
    </div>
  );
}
