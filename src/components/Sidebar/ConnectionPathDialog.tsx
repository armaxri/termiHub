import { useEffect, useState } from "react";
import {
  Route,
  ChevronDown,
  User,
  Server,
  MonitorDot,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
} from "lucide-react";
import { Modal, Button } from "@/components/ui";
import { SavedConnection } from "@/types/connection";
import { getJumpHosts } from "@/utils/jumpHost";
import { probeConnectionPath, cancelConnectionPathProbe } from "@/services/api";
import { onJumpHostHopStatus, onJumpHostProbeComplete, HopProbeStatus } from "@/services/events";
import { frontendLog } from "@/utils/frontendLog";
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

/** A node's live probe status; `pending` is the initial (not-yet-probed) state. */
type NodeStatus = "pending" | HopProbeStatus;

/** Pick the status indicator icon + spin flag for a node status. */
function statusIcon(status: NodeStatus): { Icon: typeof User; spin: boolean } {
  switch (status) {
    case "connecting":
      return { Icon: Loader2, spin: true };
    case "connected":
      return { Icon: CheckCircle2, spin: false };
    case "failed":
      return { Icon: XCircle, spin: false };
    case "pending":
    default:
      return { Icon: Circle, spin: false };
  }
}

/**
 * Shows the full SSH jump-host (ProxyJump) path for a connection as a vertical
 * chain `You → hop1 → … → target`, with each hop's `user@host:port`, and live
 * per-hop connection status (#962).
 *
 * Reached from the connection context menu's "Show Connection Path" action. The
 * chain is read from the connection's `proxyJump` config. While the dialog is
 * open it runs a backend *probe* of the whole path and updates each node from
 * `connecting` → `connected` / `failed` as the probe steps the chain; a failed
 * hop is flagged and later nodes stay pending. Closing the dialog cancels the
 * probe.
 */
export function ConnectionPathDialog({ open, connection, onClose }: ConnectionPathDialogProps) {
  const hops = getJumpHosts(connection.config);
  const settings = connection.config.config as Record<string, unknown>;
  const targetHost = typeof settings.host === "string" ? settings.host : connection.name;
  const targetUser = typeof settings.username === "string" ? settings.username : "";

  // One status per probed node (gateway hops + target), excluding the "You"
  // origin. Keyed by the probe's node index so events map straight onto it.
  const [statuses, setStatuses] = useState<NodeStatus[]>([]);
  const [messages, setMessages] = useState<Record<number, string>>({});

  // Run a probe for the lifetime of an open dialog: start it, subscribe to its
  // hop-status events, and cancel + unsubscribe on close / unmount.
  useEffect(() => {
    if (!open) return;

    const probeId = `probe-${connection.id}-${Date.now()}`;
    const probedNodeCount = hops.length + 1;
    setStatuses(Array.from({ length: probedNodeCount }, () => "pending" as NodeStatus));
    setMessages({});

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const apply = (payload: { probeId: string; index: number; status: HopProbeStatus }) => {
      if (cancelled || payload.probeId !== probeId) return;
      setStatuses((prev) => {
        const next = [...prev];
        if (payload.index < next.length) next[payload.index] = payload.status;
        return next;
      });
    };

    void (async () => {
      const offStatus = await onJumpHostHopStatus((payload) => {
        apply(payload);
        if (payload.status === "failed" && payload.message) {
          setMessages((prev) => ({ ...prev, [payload.index]: payload.message }));
        }
      });
      const offComplete = await onJumpHostProbeComplete((payload) => {
        if (payload.probeId === probeId) {
          frontendLog("connection_path", `probe ${probeId} complete success=${payload.success}`);
        }
      });
      unlisteners.push(offStatus, offComplete);
      if (cancelled) {
        // Dialog closed before listeners attached — tear them down immediately.
        unlisteners.forEach((off) => off());
        return;
      }
      try {
        await probeConnectionPath(probeId, settings);
      } catch (e) {
        frontendLog("connection_path", `probe ${probeId} failed to start: ${String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
      void cancelConnectionPathProbe(probeId);
    };
    // The probe is keyed by the open dialog + connection; settings/hops derive
    // from the connection so they need not be separate deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection.id]);

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
    <Modal
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      data-testid="connection-path-dialog"
      title={
        <span className="connection-path-dialog__title-row">
          <Route size={16} /> Connection Path
        </span>
      }
      footer={
        <Button variant="secondary" onClick={onClose} data-testid="connection-path-close">
          Close
        </Button>
      }
    >
      <p className="connection-path-dialog__subtitle">
        {connection.name} reaches its target through{" "}
        {hops.length === 1 ? "1 jump host" : `${hops.length} jump hosts`}.
      </p>
      <ol className="connection-path-dialog__chain">
        {nodes.map((node, index) => {
          const Icon = node.icon;
          const isLast = index === nodes.length - 1;
          // The "You" origin (index 0) is always reachable; probed nodes map
          // to statuses[index - 1].
          const status: NodeStatus = index === 0 ? "connected" : (statuses[index - 1] ?? "pending");
          const message = index === 0 ? undefined : messages[index - 1];
          const { Icon: StatusIcon, spin } = statusIcon(status);
          return (
            <li
              key={index}
              className="connection-path-dialog__node"
              data-status={status}
              data-testid="connection-path-node"
            >
              <div className="connection-path-dialog__row">
                <Icon size={15} className="connection-path-dialog__icon" />
                <span className="connection-path-dialog__label">{node.label}</span>
                <span className="connection-path-dialog__detail">{node.detail}</span>
                <StatusIcon
                  size={15}
                  className={`connection-path-dialog__status connection-path-dialog__status--${status}${
                    spin ? " connection-path-dialog__status--spin motion-essential-spinner" : ""
                  }`}
                  aria-label={`status: ${status}`}
                />
              </div>
              {message && (
                <span className="connection-path-dialog__error" role="alert">
                  {message}
                </span>
              )}
              {!isLast && (
                <ChevronDown size={14} className="connection-path-dialog__arrow" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
    </Modal>
  );
}
