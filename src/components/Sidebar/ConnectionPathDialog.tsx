import * as Dialog from "@radix-ui/react-dialog";
import { Route, ChevronDown, User, Server, MonitorDot } from "lucide-react";
import { SavedConnection } from "@/types/connection";
import { getJumpHosts } from "@/utils/jumpHost";
import "./ConnectionPathDialog.css";

interface ConnectionPathDialogProps {
  open: boolean;
  connection: SavedConnection;
  onClose: () => void;
}

interface PathNode {
  icon: typeof User;
  label: string;
  detail: string;
}

/**
 * Shows the full SSH jump-host (ProxyJump) path for a connection as a vertical
 * chain `You → hop1 → … → target`, with each hop's `user@host:port`.
 *
 * Reached from the connection context menu's "Show Connection Path" action. The
 * chain is read from the connection's `proxyJump` config (the concept's per-hop
 * status popover; live per-hop status is a later enhancement).
 */
export function ConnectionPathDialog({ open, connection, onClose }: ConnectionPathDialogProps) {
  const hops = getJumpHosts(connection.config);
  const settings = connection.config.config as Record<string, unknown>;
  const targetHost = typeof settings.host === "string" ? settings.host : connection.name;
  const targetUser = typeof settings.username === "string" ? settings.username : "";

  const nodes: PathNode[] = [
    { icon: User, label: "You", detail: "this machine" },
    ...hops.map((hop) => ({
      icon: Server,
      label: hop.host,
      detail: `${hop.username}@${hop.host}:${hop.port}`,
    })),
    {
      icon: MonitorDot,
      label: targetHost,
      detail: targetUser ? `${targetUser}@${targetHost}` : targetHost,
    },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcuts-overlay__backdrop" />
        <Dialog.Content className="connection-path-dialog" data-testid="connection-path-dialog">
          <Dialog.Title className="connection-path-dialog__title">
            <Route size={16} /> Connection Path
          </Dialog.Title>
          <Dialog.Description className="connection-path-dialog__subtitle">
            {connection.name} reaches its target through{" "}
            {hops.length === 1 ? "1 jump host" : `${hops.length} jump hosts`}.
          </Dialog.Description>
          <ol className="connection-path-dialog__chain">
            {nodes.map((node, index) => {
              const Icon = node.icon;
              const isLast = index === nodes.length - 1;
              return (
                <li key={index} className="connection-path-dialog__node">
                  <div className="connection-path-dialog__row">
                    <Icon size={15} className="connection-path-dialog__icon" />
                    <span className="connection-path-dialog__label">{node.label}</span>
                    <span className="connection-path-dialog__detail">{node.detail}</span>
                  </div>
                  {!isLast && (
                    <ChevronDown size={14} className="connection-path-dialog__arrow" aria-hidden />
                  )}
                </li>
              );
            })}
          </ol>
          <div className="connection-path-dialog__actions">
            <button
              type="button"
              className="connection-path-dialog__button"
              onClick={onClose}
              data-testid="connection-path-close"
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
