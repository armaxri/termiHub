import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useRunLocationStore } from "@/store/runLocationStore";
import { Button, ConfirmDialog, toast } from "@/components/ui";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { EmbeddedServerConfig } from "@/types/embeddedServer";
import { setEmbeddedServerRunLocation } from "@/services/embeddedServerApi";
import { THIS_COMPUTER, type RunLocation } from "@/utils/runLocation";
import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { EmbeddedServerDialog } from "./EmbeddedServerDialog";
import { newId } from "@/services/transport/ids";
import "./EmbeddedServerSidebar.css";
import { errorMessage } from "@/utils/errorMessage";

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
  const serverLocations = useRunLocationStore((s) => s.serverLocations);
  const setServerLocation = useRunLocationStore((s) => s.setServerLocation);

  // Record a server's run-location: mirror it UI-side (optimistic) and persist
  // it on the desktop backend, which routes the server's next start. Roll back
  // and surface a toast if the backend rejects the choice.
  const handleRunLocationChange = useCallback(
    (serverId: string, location: RunLocation) => {
      const previous = serverLocations[serverId] ?? THIS_COMPUTER;
      setServerLocation(serverId, location);
      setEmbeddedServerRunLocation(serverId, location).catch((err: unknown) => {
        setServerLocation(serverId, previous);
        toast.error("Couldn't change run location", {
          description: errorMessage(err),
        });
      });
    },
    [serverLocations, setServerLocation]
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<EmbeddedServerConfig | null>(null);

  // Delete confirmation for a server (running servers are stopped first). The
  // target is the server id; the dialog message depends on the live running
  // state, so that derivation stays caller-side (see `pendingIsRunning`).
  const serverDelete = useDeleteConfirm<string>(async (id) => {
    const name = servers.find((s) => s.id === id)?.name ?? "";
    try {
      await deleteEmbeddedServer(id);
      toast.success(`Deleted "${name}"`);
    } catch (err) {
      toast.error(`Failed to delete "${name}"`, {
        description: errorMessage(err),
      });
    }
  });

  const handleNew = useCallback(() => {
    setEditingConfig(null);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback(
    (id: string) => {
      const cfg = servers.find((s) => s.id === id);
      if (cfg) {
        setEditingConfig(cfg);
        setDialogOpen(true);
      }
    },
    [servers]
  );

  /**
   * Persist a server from the dialog. Resolves `true` when the save succeeded
   * (so the dialog closes) and `false` on failure (dialog stays open to retry).
   */
  const handleSave = useCallback(
    async (config: EmbeddedServerConfig): Promise<boolean> => {
      const isNew = !config.id;
      const cfg = isNew
        ? {
            ...config,
            id: newId("srv"),
          }
        : config;
      try {
        await saveEmbeddedServer(cfg);
        toast.success(isNew ? `Created "${cfg.name}"` : `Saved "${cfg.name}"`);
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
      try {
        await saveEmbeddedServer(dupe);
        toast.success(`Duplicated "${original.name}"`);
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
  const pendingIsRunning = serverDelete.pending
    ? serverStates[serverDelete.pending]?.status === "running"
    : false;

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
      <SidebarToolbar>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          onClick={handleNew}
          data-testid="server-new-btn"
        >
          New Service
        </Button>
      </SidebarToolbar>

      {servers.length === 0 ? (
        <div className="server-sidebar__empty" data-testid="server-empty-message">
          <span>No services configured.</span>
          <span>Click &quot;+ New Service&quot; to add one.</span>
        </div>
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
                runLocation={serverLocations[cfg.id] ?? THIS_COMPUTER}
                onRunLocationChange={(location) => handleRunLocationChange(cfg.id, location)}
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
      />

      <ConfirmDialog
        {...serverDelete.dialogProps}
        title="Delete service"
        message={
          pendingIsRunning
            ? `This will stop and delete the running server "${pendingServer?.name}". This cannot be undone.`
            : `Delete "${pendingServer?.name}"? This cannot be undone.`
        }
        confirmLabel="Delete"
        data-testid="server-delete-confirm"
      />
    </div>
  );
}
