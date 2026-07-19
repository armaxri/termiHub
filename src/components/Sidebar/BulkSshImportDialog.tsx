import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Server } from "lucide-react";
import { Button, Checkbox, Modal, Select } from "@/components/ui";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import type { JumpHostConfig, SshConfigImportConnection } from "@/types/connection";
import { importSshConfigConnections } from "@/services/api";
import {
  buildBulkSshConnections,
  importFolderOptions,
  resolveImportFolderId,
  ROOT_FOLDER_VALUE,
} from "@/services/sshConfigImport";
import "./BulkSshImportDialog.css";

interface BulkSshImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Folders offered as import targets (root is always added first). */
  folders: ConnectionFolder[];
  /** Existing connections, used for per-folder name-collision handling. */
  existingConnections: SavedConnection[];
  /** Called with the freshly built saved connections to persist in bulk. */
  onImport: (connections: SavedConnection[]) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; connections: SshConfigImportConnection[] }
  | { status: "error" };

/** `user@host:port`, omitting an empty user and a default (22) port. */
function targetSummary(conn: SshConfigImportConnection): string {
  const port = conn.port && conn.port !== 22 ? `:${conn.port}` : "";
  return conn.username ? `${conn.username}@${conn.host}${port}` : `${conn.host}${port}`;
}

/** One-line `via` suffix summarising the jump-host chain, or "" when direct. */
function chainSuffix(hops: JumpHostConfig[]): string {
  if (hops.length === 0) return "";
  return ` · via ${hops.map((h) => h.host).join(" → ")}`;
}

/**
 * Bulk importer for whole SSH connections from the user's `~/.ssh/config`
 * (#1731). Reuses the #1722 backend command `import_ssh_config_connections`,
 * which returns every concrete `Host` alias as a resolved connection, and lets
 * the user multi-select several of them, pick a target folder, and create a
 * saved SSH connection per selection in one action (via the store's bulk-add).
 *
 * Names collide-resolve within the chosen folder (` (2)`, ` (3)`, …). A missing
 * / empty / unparseable config yields a friendly empty state, never an error
 * toast — the backend already degrades those cases to an empty list.
 */
export function BulkSshImportDialog({
  open,
  onOpenChange,
  folders,
  existingConnections,
  onImport,
}: BulkSshImportDialogProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folderId, setFolderId] = useState<string>(ROOT_FOLDER_VALUE);

  const folderOptions = useMemo(() => importFolderOptions(folders), [folders]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    setSelected(new Set());
    setFolderId(ROOT_FOLDER_VALUE);
    importSshConfigConnections()
      .then((connections) => {
        if (!cancelled) setState({ status: "ready", connections: connections ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const connections = state.status === "ready" ? state.connections : [];
  const allSelected = connections.length > 0 && selected.size === connections.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggleOne = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === connections.length ? new Set() : new Set(connections.map((c) => c.name))
    );
  };

  const handleImport = () => {
    const chosen = connections.filter((c) => selected.has(c.name));
    if (chosen.length === 0) return;
    const built = buildBulkSshConnections(
      chosen,
      resolveImportFolderId(folderId),
      existingConnections
    );
    onImport(built);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Bulk import from ~/.ssh/config"
      description="Select hosts from your OpenSSH client config and create saved SSH connections in a folder."
      size="lg"
      data-testid="bulk-ssh-import-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="bulk-ssh-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={selected.size === 0}
            data-testid="bulk-ssh-import"
          >
            {selected.size > 0 ? `Import ${selected.size}` : "Import"}
          </Button>
        </>
      }
    >
      {state.status === "loading" && (
        <p className="ssh-config-import__status" data-testid="bulk-ssh-import-loading">
          Reading ~/.ssh/config…
        </p>
      )}

      {state.status === "error" && (
        <div className="ssh-config-import__empty" data-testid="bulk-ssh-import-error">
          <AlertTriangle size={20} aria-hidden />
          <p>Could not read ~/.ssh/config.</p>
        </div>
      )}

      {state.status === "ready" && connections.length === 0 && (
        <div className="ssh-config-import__empty" data-testid="bulk-ssh-import-empty">
          <Server size={20} aria-hidden />
          <p>No hosts were found in ~/.ssh/config.</p>
        </div>
      )}

      {state.status === "ready" && connections.length > 0 && (
        <div className="bulk-ssh-import">
          <div className="bulk-ssh-import__folder">
            <label className="bulk-ssh-import__folder-label" htmlFor="bulk-ssh-import-folder">
              Import into
            </label>
            <Select
              value={folderId}
              onChange={setFolderId}
              options={folderOptions}
              aria-label="Target folder"
              data-testid="bulk-ssh-import-folder"
            />
          </div>

          <div className="bulk-ssh-import__selectall">
            <Checkbox
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={toggleAll}
              aria-label="Select all hosts"
              data-testid="bulk-ssh-import-select-all"
            />
            <span className="bulk-ssh-import__selectall-label">
              {selected.size} of {connections.length} selected
            </span>
          </div>

          <ul className="ssh-config-import__list" data-testid="bulk-ssh-import-list">
            {connections.map((conn) => {
              const isSelected = selected.has(conn.name);
              return (
                <li key={conn.name}>
                  <label
                    className="bulk-ssh-import__row"
                    data-testid={`bulk-ssh-import-host-${conn.name}`}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleOne(conn.name)}
                      aria-label={`Select ${conn.name}`}
                      data-testid={`bulk-ssh-import-check-${conn.name}`}
                    />
                    <span className="ssh-config-import__row-text">
                      <span className="ssh-config-import__row-name">{conn.name}</span>
                      <span className="ssh-config-import__row-chain">
                        {targetSummary(conn)}
                        {chainSuffix(conn.proxyJump)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}
