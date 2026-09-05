import { Link2, Monitor, Plug, Server, Info } from "lucide-react";
import { Button, Field, Modal, Select, Toggle } from "@/components/ui";
import "./TunnelChainPreviewDialog.css";

/**
 * Props for {@link TunnelChainPreviewDialog} — the preview/confirm shown before a
 * companion desktop hop is created (#2597). Pure presentation: the editor derives
 * the companion config (via `deriveCompanion`) and passes the display endpoints +
 * SSH-via choices here, so the dialog never touches the store or the derivation.
 */
export interface TunnelChainPreviewDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with the next open state (Radix fires `false` on ESC / scrim / close). */
  onOpenChange: (open: boolean) => void;
  /** The desktop port the companion restores `localhost:` on (the parent's port). */
  port: number | "";
  /** The host agent's display name, e.g. "build-box". */
  agentName: string;
  /** The companion's desktop listen endpoint, e.g. "127.0.0.1:5432". */
  companionListen: string;
  /** The parent loopback socket the companion forwards to, e.g. "127.0.0.1:5432". */
  companionForwards: string;
  /** Saved SSH connections to pick the companion's SSH-via from. */
  sshOptions: { value: string; label: string }[];
  /** The currently-selected SSH-via connection id (controlled). */
  sshConnectionId: string;
  /** Change the selected SSH-via connection. */
  onSshConnectionChange: (id: string) => void;
  /** "Start the pair now" toggle (controlled). */
  startNow: boolean;
  /** Toggle "Start the pair now". */
  onStartNowChange: (value: boolean) => void;
  /** Commit — create + link the companion. */
  onConfirm: () => void;
}

/**
 * Preview / confirm dialog for "Chain a hop to this computer" (#2597).
 *
 * The concept's core requirement is that the second moving part is **never
 * silent**: before anything is created the user sees all three companion
 * endpoints, the derived SSH-via, and an explicit note that this is a second,
 * linked tunnel with a cascading lifecycle. Composed entirely from the shared
 * `ui/` primitives (Modal / Field / Select / Toggle / Button) so it inherits the
 * token'd styling and focus/ESC behaviour with no bespoke shell.
 */
export function TunnelChainPreviewDialog({
  open,
  onOpenChange,
  port,
  agentName,
  companionListen,
  companionForwards,
  sshOptions,
  sshConnectionId,
  onSshConnectionChange,
  startNow,
  onStartNowChange,
  onConfirm,
}: TunnelChainPreviewDialogProps) {
  const portLabel = port === "" ? "?" : String(port);
  const hasSshOptions = sshOptions.length > 0;
  const canCreate = hasSshOptions && !!sshConnectionId;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="tunnel-chain-preview__title">
          <Link2 size={15} aria-hidden="true" /> Chain a hop to this computer
        </span>
      }
      description="Preview the companion desktop tunnel before creating it."
      data-testid="tunnel-chain-preview"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="tunnel-chain-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Link2 size={13} />}
            onClick={onConfirm}
            disabled={!canCreate}
            data-testid="tunnel-chain-confirm"
          >
            Create &amp; link
          </Button>
        </>
      }
    >
      <p className="tunnel-chain-preview__lede">
        Creates a companion tunnel <strong>on this computer</strong> so{" "}
        <code>localhost:{portLabel}</code> reaches the port on {agentName}.
      </p>

      <ul className="tunnel-chain-preview__endpoints" data-testid="tunnel-chain-endpoints">
        <li>
          <Monitor size={13} aria-hidden="true" />
          <span>
            Companion listens <code>{companionListen}</code> on this computer
          </span>
        </li>
        <li>
          <Plug size={13} aria-hidden="true" />
          <span>Via the agent&rsquo;s SSH connection {agentName}</span>
        </li>
        <li>
          <Server size={13} aria-hidden="true" />
          <span>
            Forwards to the parent&rsquo;s port <code>{companionForwards}</code> on {agentName}
          </span>
        </li>
      </ul>

      <Field
        label="SSH connection to the agent"
        htmlFor="tunnel-chain-ssh-via"
        error={hasSshOptions ? undefined : `No saved SSH connection reaches ${agentName}.`}
      >
        <Select
          value={sshConnectionId || undefined}
          onChange={onSshConnectionChange}
          options={sshOptions}
          placeholder="No SSH connections available"
          aria-label="SSH connection to the agent"
          data-testid="tunnel-chain-ssh-via"
        />
      </Field>

      <div className="tunnel-chain-preview__toggle">
        <Toggle id="tunnel-chain-start-now" checked={startNow} onCheckedChange={onStartNowChange} />
        <label htmlFor="tunnel-chain-start-now">Start the pair now</label>
      </div>

      <p className="tunnel-chain-preview__note" data-testid="tunnel-chain-note">
        <Info size={13} aria-hidden="true" />
        <span>
          This adds a second linked tunnel. It appears under the parent and is removed when the
          parent is removed.
        </span>
      </p>
    </Modal>
  );
}
