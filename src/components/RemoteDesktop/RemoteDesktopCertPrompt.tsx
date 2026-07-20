import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Modal, Button } from "@/components/ui";
import type { RemoteDesktopCertPromptPayload } from "@/types/remoteDesktop";
import "./RemoteDesktopCertPrompt.css";

interface RemoteDesktopCertPromptProps {
  /** The pending prompt, or `null` when no decision is needed. */
  prompt: RemoteDesktopCertPromptPayload | null;
  /** Called with the user's verdict: `accept` proceeds, `remember` persists it. */
  onDecision: (accept: boolean, remember: boolean) => void;
}

/**
 * Interactive server-certificate trust dialog for RDP (#1767) — the SSH
 * host-key-prompt analogue for remote desktops.
 *
 * The RDP host presented an untrusted certificate; the user eyeballs the
 * SHA-256 public-key fingerprint and chooses to accept it once, accept and
 * remember it for this host, or reject the connection. When the fingerprint
 * *changed* for a previously-trusted host (`changed`), the dialog warns
 * prominently about a possible man-in-the-middle before offering to proceed.
 *
 * Composed from the shared {@link Modal} + {@link Button} primitives; the verdict
 * is routed back to the backend via `remoteDesktopCertDecision`.
 */
export function RemoteDesktopCertPrompt({ prompt, onDecision }: RemoteDesktopCertPromptProps) {
  const open = prompt !== null;
  const changed = prompt?.changed ?? false;

  return (
    <Modal
      open={open}
      // ESC / scrim / close all count as a rejection — the safe default.
      onOpenChange={(next) => !next && onDecision(false, false)}
      title={
        <span className="rd-cert__title">
          {changed ? (
            <ShieldAlert size={16} className="rd-cert__title-icon rd-cert__title-icon--warn" />
          ) : (
            <ShieldCheck size={16} className="rd-cert__title-icon" />
          )}
          {changed ? "Certificate changed" : "Untrusted certificate"}
        </span>
      }
      data-testid="remote-desktop-cert-prompt"
      footer={
        <div className="rd-cert__actions">
          <Button
            variant="ghost"
            onClick={() => onDecision(false, false)}
            data-testid="cert-reject"
          >
            Reject
          </Button>
          <Button
            variant="secondary"
            onClick={() => onDecision(true, false)}
            data-testid="cert-accept-once"
          >
            Accept once
          </Button>
          <Button
            variant={changed ? "danger" : "primary"}
            onClick={() => onDecision(true, true)}
            data-testid="cert-accept-remember"
          >
            Accept for host
          </Button>
        </div>
      }
    >
      {prompt && (
        <div className="rd-cert__body">
          {changed && (
            <div className="rd-cert__warning" role="alert" data-testid="cert-mitm-warning">
              <ShieldAlert size={16} className="rd-cert__warning-icon" aria-hidden="true" />
              <span>
                The certificate for this host <strong>changed</strong> since you last trusted it.
                This can mean the server was reinstalled — or that someone is intercepting the
                connection. Only continue if you expected this.
              </span>
            </div>
          )}
          <p className="rd-cert__lead">
            {changed
              ? "The RDP server presented a different certificate than the one you trusted for:"
              : "The RDP server presented a certificate that is not yet trusted for:"}
          </p>
          <dl className="rd-cert__facts">
            <dt>Host</dt>
            <dd data-testid="cert-host">{prompt.host}</dd>
            {prompt.subject && (
              <>
                <dt>Subject</dt>
                <dd>{prompt.subject}</dd>
              </>
            )}
            {prompt.issuer && (
              <>
                <dt>Issuer</dt>
                <dd>{prompt.issuer}</dd>
              </>
            )}
            <dt>Fingerprint</dt>
            <dd className="rd-cert__fingerprint" data-testid="cert-fingerprint">
              {prompt.fingerprint}
            </dd>
          </dl>
          <p className="rd-cert__hint">
            Verify the fingerprint matches the one your server administrator reports.
            &ldquo;Accept for host&rdquo; remembers it so you are not asked again.
          </p>
        </div>
      )}
    </Modal>
  );
}
