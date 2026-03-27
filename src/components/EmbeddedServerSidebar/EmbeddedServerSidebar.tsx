import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { EmbeddedServerConfig } from "@/types/embeddedServer";
import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { EmbeddedServerDialog } from "./EmbeddedServerDialog";
import "./EmbeddedServerSidebar.css";

/**
 * Services sidebar panel for managing embedded HTTP/FTP/TFTP servers.
 */
export function EmbeddedServerSidebar() {
  const servers = useAppStore((s) => s.embeddedServers);
  const serverStates = useAppStore((s) => s.embeddedServerStates);
  const saveEmbeddedServer = useAppStore((s) => s.saveEmbeddedServer);
  const deleteEmbeddedServer = useAppStore((s) => s.deleteEmbeddedServer);
  const startEmbeddedServer = useAppStore((s) => s.startEmbeddedServer);
  const stopEmbeddedServer = useAppStore((s) => s.stopEmbeddedServer);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<EmbeddedServerConfig | null>(null);

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

  const handleSave = useCallback(
    (config: EmbeddedServerConfig) => {
      const isNew = !config.id;
      const cfg = isNew
        ? {
            ...config,
            id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          }
        : config;
      saveEmbeddedServer(cfg).catch((err: unknown) => console.error("Failed to save server:", err));
    },
    [saveEmbeddedServer]
  );

  const handleDuplicate = useCallback(
    (id: string) => {
      const original = servers.find((s) => s.id === id);
      if (!original) return;
      const dupe: EmbeddedServerConfig = {
        ...original,
        id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Copy of ${original.name}`,
        autoStart: false,
      };
      saveEmbeddedServer(dupe).catch((err: unknown) =>
        console.error("Failed to duplicate server:", err)
      );
    },
    [servers, saveEmbeddedServer]
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteEmbeddedServer(id);
    },
    [deleteEmbeddedServer]
  );

  return (
    <div className="server-sidebar" data-testid="server-sidebar">
      <div className="server-sidebar__actions">
        <button
          className="server-sidebar__add-btn"
          onClick={handleNew}
          title="New Service"
          data-testid="server-new-btn"
        >
          <Plus size={14} />
          New Service
        </button>
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
    </div>
  );
}
