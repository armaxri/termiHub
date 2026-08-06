import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useRunLocationStore } from "@/store/runLocationStore";
import { Button, ConfirmDialog, toast } from "@/components/ui";
import { EmbeddedServerConfig } from "@/types/embeddedServer";
import { setEmbeddedServerRunLocation } from "@/services/embeddedServerApi";
import { THIS_COMPUTER, type RunLocation } from "@/utils/runLocation";
import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { EmbeddedServerDialog } from "./EmbeddedServerDialog";
import "./EmbeddedServerSidebar.css";

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
          description: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [serverLocations, setServerLocation]
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<EmbeddedServerConfig | null>(null);
  // Id of the server pending delete confirmation (null when no confirm is open).
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

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
            id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          }
        : config;
      try {
        await saveEmbeddedServer(cfg);
        toast.success(isNew ? `Created "${cfg.name}"` : `Saved "${cfg.name}"`);
        return true;
      } catch (err) {
        toast.error(`Failed to save "${cfg.name}"`, {
          description: err instanceof Error ? err.message : String(err),
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
        id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Copy of ${original.name}`,
        autoStart: false,
      };
      try {
        await saveEmbeddedServer(dupe);
        toast.success(`Duplicated "${original.name}"`);
      } catch (err) {
        toast.error(`Failed to duplicate "${original.name}"`, {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [servers, saveEmbeddedServer]
  );

  // Delete is destructive (and stops a running server), so gate it behind an
  // explicit confirmation — consistent with tunnels and workspaces (#1393).
  const handleDelete = useCallback((id: string) => {
    setPendingDeleteId(id);
  }, []);

  const pendingServer = useMemo(
    () => servers.find((s) => s.id === pendingDeleteId) ?? null,
    [servers, pendingDeleteId]
  );
  const pendingIsRunning = pendingDeleteId
    ? serverStates[pendingDeleteId]?.status === "running"
    : false;

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingServer) return;
    const { id, name } = pendingServer;
    setPendingDeleteId(null);
    try {
      await deleteEmbeddedServer(id);
      toast.success(`Deleted "${name}"`);
    } catch (err) {
      toast.error(`Failed to delete "${name}"`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [pendingServer, deleteEmbeddedServer]);

  return (
    <div className="server-sidebar" data-testid="server-sidebar">
      <div className="server-sidebar__actions">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          onClick={handleNew}
          data-testid="server-new-btn"
        >
          New Service
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="server-sidebar__empty" data-testid="server-empty-message">
          <span>No services configured.</span>
          <span>Click &quot;+ New Service&quot; to add one.</span>
        </div>
      ) : (
        <div className="server-sidebar__list" data-testid="server-list">
          {servers.map((cfg) => (
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
            />
          ))}
        </div>
      )}

      <EmbeddedServerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        config={editingConfig}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={pendingServer !== null}
        title="Delete service"
        message={
          pendingIsRunning
            ? `This will stop and delete the running server "${pendingServer?.name}". This cannot be undone.`
            : `Delete "${pendingServer?.name}"? This cannot be undone.`
        }
        confirmLabel="Delete"
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDeleteId(null)}
        data-testid="server-delete-confirm"
      />
    </div>
  );
}
