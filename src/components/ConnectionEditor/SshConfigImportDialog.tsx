import { useEffect, useState } from "react";
import { FileDown, Server, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui";
import type { JumpHostConfig, SshConfigImportHost } from "@/types/connection";
import { importSshConfigHosts } from "@/services/api";
import "./SshConfigImportDialog.css";

interface SshConfigImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the selected host's resolved hop chain. */
  onImport: (hops: JumpHostConfig[]) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; hosts: SshConfigImportHost[] }
  | { status: "error" };

/** One-line summary of a hop chain, e.g. `bob@bastion.example.com → carol@edge`. */
function chainSummary(hops: JumpHostConfig[]): string {
  return hops
    .map((h) => {
      const port = h.port && h.port !== 22 ? `:${h.port}` : "";
      return h.username ? `${h.username}@${h.host}${port}` : `${h.host}${port}`;
    })
    .join(" → ");
}

/**
 * Picker for importing a `ProxyJump` chain from the user's `~/.ssh/config`
 * (#1702). Lists the config hosts that declare a `ProxyJump`; selecting one
 * hands its resolved hop chain to {@link SshConfigImportDialogProps.onImport}
 * (which populates the editor's jump-host fields for review) and closes.
 *
 * A missing / empty / unparseable config yields a friendly empty state, never
 * an error toast — the backend already degrades those cases to an empty list.
 */
export function SshConfigImportDialog({
  open,
  onOpenChange,
  onImport,
}: SshConfigImportDialogProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    importSshConfigHosts()
      .then((hosts) => {
        if (!cancelled) setState({ status: "ready", hosts: hosts ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSelect = (host: SshConfigImportHost) => {
    onImport(host.proxyJump);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import from ~/.ssh/config"
      description="Pick a host from your OpenSSH client config to populate the jump-host chain."
      data-testid="ssh-config-import-dialog"
    >
      {state.status === "loading" && (
        <p className="ssh-config-import__status" data-testid="ssh-config-import-loading">
          Reading ~/.ssh/config…
        </p>
      )}

      {state.status === "error" && (
        <div className="ssh-config-import__empty" data-testid="ssh-config-import-error">
          <AlertTriangle size={20} aria-hidden />
          <p>Could not read ~/.ssh/config.</p>
        </div>
      )}

      {state.status === "ready" && state.hosts.length === 0 && (
        <div className="ssh-config-import__empty" data-testid="ssh-config-import-empty">
          <Server size={20} aria-hidden />
          <p>No hosts with a ProxyJump were found in ~/.ssh/config.</p>
        </div>
      )}

      {state.status === "ready" && state.hosts.length > 0 && (
        <ul className="ssh-config-import__list" data-testid="ssh-config-import-list">
          {state.hosts.map((host) => (
            <li key={host.name}>
              <button
                type="button"
                className="ssh-config-import__row"
                onClick={() => handleSelect(host)}
                data-testid={`ssh-config-import-host-${host.name}`}
              >
                <FileDown size={14} aria-hidden className="ssh-config-import__row-icon" />
                <span className="ssh-config-import__row-text">
                  <span className="ssh-config-import__row-name">{host.name}</span>
                  <span className="ssh-config-import__row-chain">
                    {chainSummary(host.proxyJump)}
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
