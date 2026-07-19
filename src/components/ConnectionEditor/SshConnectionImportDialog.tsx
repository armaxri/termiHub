import { useEffect, useState } from "react";
import { FileDown, Server, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui";
import type { JumpHostConfig, SshConfigImportConnection } from "@/types/connection";
import { importSshConfigConnections } from "@/services/api";
import "./SshConfigImportDialog.css";

interface SshConnectionImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the selected whole connection to pre-populate the editor. */
  onImport: (connection: SshConfigImportConnection) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; connections: SshConfigImportConnection[] }
  | { status: "error" };

/** `user@host:port`, omitting an empty user and a default (22) port. */
function targetSummary(conn: SshConfigImportConnection): string {
  const port = conn.port && conn.port !== 22 ? `:${conn.port}` : "";
  const base = conn.username ? `${conn.username}@${conn.host}${port}` : `${conn.host}${port}`;
  return base;
}

/** One-line `via` suffix summarising the jump-host chain, or "" when direct. */
function chainSuffix(hops: JumpHostConfig[]): string {
  if (hops.length === 0) return "";
  const chain = hops.map((h) => h.host).join(" → ");
  return ` · via ${chain}`;
}

/**
 * Picker for importing a whole SSH connection from the user's `~/.ssh/config`
 * (#1722). Lists every concrete `Host` alias — direct hosts and hosts behind a
 * `ProxyJump` alike — with its resolved `Hostname`/`User`/`Port`/`IdentityFile`.
 * Selecting one hands the connection to
 * {@link SshConnectionImportDialogProps.onImport}, which pre-populates the
 * editor's SSH fields (name, host, user, port, key, and any jump-host chain) for
 * the user to review and edit before saving, then closes.
 *
 * A missing / empty / unparseable config yields a friendly empty state, never
 * an error toast — the backend already degrades those cases to an empty list.
 */
export function SshConnectionImportDialog({
  open,
  onOpenChange,
  onImport,
}: SshConnectionImportDialogProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
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

  const handleSelect = (conn: SshConfigImportConnection) => {
    onImport(conn);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import connection from ~/.ssh/config"
      description="Pick a host from your OpenSSH client config to fill in this SSH connection."
      data-testid="ssh-connection-import-dialog"
    >
      {state.status === "loading" && (
        <p className="ssh-config-import__status" data-testid="ssh-connection-import-loading">
          Reading ~/.ssh/config…
        </p>
      )}

      {state.status === "error" && (
        <div className="ssh-config-import__empty" data-testid="ssh-connection-import-error">
          <AlertTriangle size={20} aria-hidden />
          <p>Could not read ~/.ssh/config.</p>
        </div>
      )}

      {state.status === "ready" && state.connections.length === 0 && (
        <div className="ssh-config-import__empty" data-testid="ssh-connection-import-empty">
          <Server size={20} aria-hidden />
          <p>No hosts were found in ~/.ssh/config.</p>
        </div>
      )}

      {state.status === "ready" && state.connections.length > 0 && (
        <ul className="ssh-config-import__list" data-testid="ssh-connection-import-list">
          {state.connections.map((conn) => (
            <li key={conn.name}>
              <button
                type="button"
                className="ssh-config-import__row"
                onClick={() => handleSelect(conn)}
                data-testid={`ssh-connection-import-host-${conn.name}`}
              >
                <FileDown size={14} aria-hidden className="ssh-config-import__row-icon" />
                <span className="ssh-config-import__row-text">
                  <span className="ssh-config-import__row-name">{conn.name}</span>
                  <span className="ssh-config-import__row-chain">
                    {targetSummary(conn)}
                    {chainSuffix(conn.proxyJump)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
