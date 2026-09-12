import { TrustPrompt, type TrustFact } from "@/components/ui";
import type { RemoteDesktopCertPromptPayload } from "@/types/remoteDesktop";

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
 * Rendered through the shared {@link TrustPrompt} primitive (UISF-007), so the
 * MITM warning and three-verdict footer stay identical to the SSH host-key
 * prompt; the verdict is routed back to the backend via
 * `remoteDesktopCertDecision`.
 */
export function RemoteDesktopCertPrompt({ prompt, onDecision }: RemoteDesktopCertPromptProps) {
  const facts: TrustFact[] = prompt
    ? [
        { label: "Host", value: prompt.host, testId: "cert-host" },
        ...(prompt.subject
          ? [{ label: "Subject", value: prompt.subject, testId: "cert-subject" }]
          : []),
        ...(prompt.issuer
          ? [{ label: "Issuer", value: prompt.issuer, testId: "cert-issuer" }]
          : []),
        {
          label: "Fingerprint",
          value: prompt.fingerprint,
          mono: true,
          copyable: true,
          testId: "cert-fingerprint",
          copyTestId: "cert-fingerprint-copy",
        },
      ]
    : [];

  return (
    <TrustPrompt
      open={prompt !== null}
      changed={prompt?.changed ?? false}
      unknownTitle="Untrusted certificate"
      changedTitle="Certificate changed"
      unknownLead="The RDP server presented a certificate that is not yet trusted for:"
      changedLead="The RDP server presented a different certificate than the one you trusted for:"
      changedWarningSubject="certificate for this host"
      facts={facts}
      onReject={() => onDecision(false, false)}
      onAcceptOnce={() => onDecision(true, false)}
      onAcceptForHost={() => onDecision(true, true)}
      modalTestId="remote-desktop-cert-prompt"
      rejectTestId="cert-reject"
      acceptOnceTestId="cert-accept-once"
      acceptForHostTestId="cert-accept-remember"
      warningTestId="cert-mitm-warning"
    />
  );
}
