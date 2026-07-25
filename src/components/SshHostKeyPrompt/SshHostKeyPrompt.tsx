import { useEffect, useState, useCallback } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Modal, Button } from "@/components/ui";
import { onSshHostKeyPrompt } from "@/services/events";
import { sshHostKeyDecision } from "@/services/api";
import type { SshHostKeyPromptPayload } from "@/types/sshHostKey";
import "./SshHostKeyPrompt.css";

/**
 * Global interactive SSH host-key trust dialog (#1959) — the terminal analogue
 * of the RDP {@link RemoteDesktopCertPrompt}.
 *
 * The SSH handshake blocks when a server presents an untrusted host key and
 * emits `ssh-host-key-prompt`; this dialog surfaces the SHA-256 fingerprint and
 * lets the user accept it once, accept and remember it for the host, or reject.
 * When the key *changed* for a previously-trusted host (`changed`), it warns
 * prominently about a possible man-in-the-middle before offering to proceed. The
 * verdict is routed back to the blocked handshake via `sshHostKeyDecision`.
 *
 * Any SSH connect path (terminal, tunnel, SFTP, jump host) can raise a prompt,
 * so this mounts once at the app root and serialises concurrent prompts through
 * a small queue — one dialog at a time.
 */
export function SshHostKeyPrompt() {
  const [queue, setQueue] = useState<SshHostKeyPromptPayload[]>([]);
  const current = queue[0] ?? null;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void onSshHostKeyPrompt((payload) => {
      setQueue((q) => [...q, payload]);
    }).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const decide = useCallback(
    (accept: boolean, remember: boolean) => {
      if (!current) return;
      void sshHostKeyDecision(current.prompt_id, accept, remember);
      setQueue((q) => q.slice(1));
    },
    [current]
  );

  const changed = current?.changed ?? false;

  return (
    <Modal
      open={current !== null}
      // ESC / scrim / close all count as a rejection — the safe default.
      onOpenChange={(next) => !next && decide(false, false)}
      title={
        <span className="ssh-hostkey__title">
          {changed ? (
            <ShieldAlert
              size={16}
              className="ssh-hostkey__title-icon ssh-hostkey__title-icon--warn"
            />
          ) : (
            <ShieldCheck size={16} className="ssh-hostkey__title-icon" />
          )}
          {changed ? "Host key changed" : "Unknown host key"}
        </span>
      }
      data-testid="ssh-hostkey-prompt"
      footer={
        <div className="ssh-hostkey__actions">
          <Button
            variant="ghost"
            onClick={() => decide(false, false)}
            data-testid="ssh-hostkey-reject"
          >
            Reject
          </Button>
          <Button
            variant="secondary"
            onClick={() => decide(true, false)}
            data-testid="ssh-hostkey-accept-once"
          >
            Accept once
          </Button>
          <Button
            variant={changed ? "danger" : "primary"}
            onClick={() => decide(true, true)}
            data-testid="ssh-hostkey-accept-remember"
          >
            Accept for host
          </Button>
        </div>
      }
    >
      {current && (
        <div className="ssh-hostkey__body">
          {changed && (
            <div
              className="ssh-hostkey__warning"
              role="alert"
              data-testid="ssh-hostkey-mitm-warning"
            >
              <ShieldAlert size={16} className="ssh-hostkey__warning-icon" aria-hidden="true" />
              <span>
                The host key for this server <strong>changed</strong> since you last trusted it.
                This can mean the server was reinstalled — or that someone is intercepting the
                connection. Only continue if you expected this.
              </span>
            </div>
          )}
          <p className="ssh-hostkey__lead">
            {changed
              ? "The SSH server presented a different host key than the one you trusted for:"
              : "The SSH server presented a host key that is not yet trusted for:"}
          </p>
          <dl className="ssh-hostkey__facts">
            <dt>Host</dt>
            <dd data-testid="ssh-hostkey-host">
              {current.host}:{current.port}
            </dd>
            <dt>Key type</dt>
            <dd data-testid="ssh-hostkey-type">{current.key_type}</dd>
            <dt>Fingerprint</dt>
            <dd className="ssh-hostkey__fingerprint" data-testid="ssh-hostkey-fingerprint">
              {current.fingerprint}
            </dd>
          </dl>
          <p className="ssh-hostkey__hint">
            Verify the fingerprint matches the one your server administrator reports. &ldquo;Accept
            for host&rdquo; remembers it so you are not asked again.
          </p>
        </div>
      )}
    </Modal>
  );
}
